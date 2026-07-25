import {buildContext} from './context.js';
import {buildAgentSystemPrompt} from './prompt.js';
import type {
  AssistantToolCall,
  ModelClient,
  ModelEvent,
  ModelMessage,
} from '../providers/types.js';
import {redactValue} from '../security/redact.js';
import type {ReviewDecision} from '../security/reviewer.js';
import type {SessionStore} from '../sessions/store.js';
import type {SessionEvent} from '../sessions/types.js';
import type {ToolRegistry} from '../tools/registry.js';
import type {ToolResult} from '../tools/types.js';

export type AgentEvent =
  | {type: 'status'; text: string}
  | {type: 'assistant_delta'; text: string}
  | {type: 'assistant_text'; text: string}
  | {type: 'tool_started'; name: string; input: unknown}
  | {type: 'tool_finished'; name: string; result: ToolResult}
  | {type: 'review'; decision: ReviewDecision}
  | {type: 'limit_reached'; limit: 'turns' | 'tools'}
  | {type: 'interrupted'; reason: string}
  | {type: 'error'; message: string};

export interface AgentSession {
  id: string;
  store: Pick<SessionStore, 'append' | 'read'>;
}

export interface AgentLimits {
  maxTurns: number;
  maxToolCalls: number;
}

export interface RunAgentTaskOptions {
  task: string;
  model: ModelClient;
  modelName?: string;
  registry: ToolRegistry;
  session: AgentSession;
  workspace?: string;
  tempDir?: string;
  reviewClient?: ModelClient;
  reviewModel?: string;
  limits: AgentLimits;
  signal: AbortSignal;
  maxContextTokens?: number;
}

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

function serializeResult(result: ToolResult): string {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({
      ok: false,
      summary: '工具结果无法序列化',
      error: {
        code: 'UNSERIALIZABLE_TOOL_RESULT',
        message: '工具结果无法序列化',
      },
    });
  }
}

class AgentAbortError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AgentAbortError';
  }
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (typeof reason === 'string' && reason !== '') return reason;
  if (reason instanceof Error && reason.message !== '') return reason.message;
  return '操作已中止';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentAbortError(abortReason(signal));
}

async function abortable<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let rejectAbort: ((error: AgentAbortError) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(new AgentAbortError(abortReason(signal)));
  };
  signal.addEventListener('abort', onAbort, {once: true});
  try {
    return await Promise.race([Promise.resolve(operation), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function abortableCall<T>(
  operation: () => PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return abortable(operation(), signal);
}

async function nextModelEvent(
  iterator: AsyncIterator<ModelEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<ModelEvent>> {
  try {
    return await abortableCall(() => iterator.next(), signal);
  } catch (error) {
    if (error instanceof AgentAbortError) {
      void iterator.return?.().catch(() => undefined);
    }
    throw error;
  }
}

function invalidArgumentsResult(): ToolResult {
  return {
    ok: false,
    summary: '模型工具调用参数不是合法 JSON',
    error: {
      code: 'INVALID_TOOL_ARGUMENTS',
      message: '模型工具调用参数不是合法 JSON，请修正后仅重试一次',
    },
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactValue(message));
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

async function appendInterrupted(
  session: AgentSession,
  reason: string,
): Promise<void> {
  const append = session.store.append(session.id, {
    type: 'interrupted',
    at: Date.now(),
    reason,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      append,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 100);
      }),
    ]);
  } catch {
    // The interruption event is still emitted even if persistence is unavailable.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function* runAgentTask(
  options: RunAgentTaskOptions,
): AsyncGenerator<AgentEvent> {
  try {
    throwIfAborted(options.signal);
    const workspace = options.workspace ?? process.cwd();
    const tempDir = options.tempDir ?? workspace;
    const modelName = options.modelName ?? 'default';
    const reviewModel = options.reviewModel ?? modelName;
    const maxTurns = normalizeLimit(options.limits.maxTurns);
    const maxToolCalls = normalizeLimit(options.limits.maxToolCalls);
    let turns = 0;
    let toolCallCount = 0;
    let invalidJsonCount = 0;

    let history: SessionEvent[];
    try {
      history = await abortableCall(
        () => options.session.store.read(options.session.id),
        options.signal,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        history = [];
      } else {
        throw error;
      }
    }
    await abortableCall(() => options.session.store.append(options.session.id, {
      type: 'user',
      at: Date.now(),
      text: options.task,
    }), options.signal);
    const messages = await abortableCall(() => buildContext({
      systemPrompt: buildAgentSystemPrompt({
        workspace,
        task: options.task,
      }),
      currentTask: options.task,
      events: history,
      maxTokens: options.maxContextTokens ?? 16_000,
    }), options.signal);
    const tools = options.registry.modelToolDefinitions();

    while (true) {
      if (turns >= maxTurns) {
        yield {type: 'limit_reached', limit: 'turns'};
        return;
      }
      turns += 1;

      let assistantText = '';
      const calls = new Map<number, PendingToolCall>();
      const callOrder: number[] = [];
      throwIfAborted(options.signal);
      const iterator = options.model.stream({
        model: modelName,
        messages,
        tools,
        toolChoice: 'auto',
      }, options.signal)[Symbol.asyncIterator]();

      while (true) {
        const next = await nextModelEvent(iterator, options.signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'text_delta') {
          assistantText += event.text;
          yield {type: 'assistant_delta', text: event.text};
        } else if (event.type === 'tool_call_delta') {
          let call = calls.get(event.index);
          if (call === undefined) {
            call = {
              index: event.index,
              id: '',
              name: '',
              arguments: '',
            };
            calls.set(event.index, call);
            callOrder.push(event.index);
          }
          call.id += event.id ?? '';
          call.name += event.name ?? '';
          call.arguments += event.arguments ?? '';
        }
      }

      if (assistantText !== '') {
        await abortableCall(() => options.session.store.append(options.session.id, {
          type: 'assistant',
          at: Date.now(),
          text: assistantText,
        }), options.signal);
        yield {type: 'assistant_text', text: assistantText};
      }

      if (callOrder.length === 0) return;

      const toolCalls: AssistantToolCall[] = callOrder.map((index) => {
        const call = calls.get(index)!;
        return {
          id: call.id,
          type: 'function',
          function: {name: call.name, arguments: call.arguments},
        };
      });
      messages.push({
        role: 'assistant',
        content: assistantText === '' ? null : assistantText,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        if (toolCallCount >= maxToolCalls) {
          yield {type: 'limit_reached', limit: 'tools'};
          return;
        }

        let input: unknown;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          invalidJsonCount += 1;
          const result = invalidArgumentsResult();
          const invalidInput = {arguments: toolCall.function.arguments};
          yield {
            type: 'tool_finished',
            name: toolCall.function.name,
            result,
          };
          await abortableCall(() => options.session.store.append(options.session.id, {
            type: 'tool',
            at: Date.now(),
            tool: toolCall.function.name,
            input: invalidInput,
            result,
          }), options.signal);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeResult(result),
          });
          if (invalidJsonCount > 1) {
            yield {
              type: 'error',
              message: '模型连续两次提供了无效的工具调用 JSON',
            };
            return;
          }
          continue;
        }

        toolCallCount += 1;
        yield {
          type: 'tool_started',
          name: toolCall.function.name,
          input,
        };
        const result = await abortableCall(() => options.registry.execute(
          toolCall.function.name,
          input,
          {
            workspace,
            tempDir,
            taskSummary: options.task,
            reviewClient: options.reviewClient,
            reviewModel,
            signal: options.signal,
          },
        ), options.signal);
        yield {
          type: 'tool_finished',
          name: toolCall.function.name,
          result,
        };
        await abortableCall(() => options.session.store.append(options.session.id, {
          type: 'tool',
          at: Date.now(),
          tool: toolCall.function.name,
          input,
          result,
        }), options.signal);
        const toolMessage: ModelMessage = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: serializeResult(result),
        };
        messages.push(toolMessage);
      }
    }
  } catch (error) {
    if (error instanceof AgentAbortError || options.signal.aborted) {
      const reason = error instanceof AgentAbortError
        ? error.reason
        : abortReason(options.signal);
      const safeReason = safeErrorMessage(reason);
      await appendInterrupted(options.session, safeReason);
      yield {type: 'interrupted', reason: safeReason};
      return;
    }
    yield {type: 'error', message: safeErrorMessage(error)};
  }
}
