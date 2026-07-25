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
import type {ToolGateEvent, ToolResult} from '../tools/types.js';

export type AgentEvent =
  | {type: 'status'; text: string}
  | {type: 'assistant_delta'; text: string}
  | {type: 'assistant_message'; text: string}
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
  appendInterrupted?: (reason: string) => Promise<void>;
  reportGate?: (event: ToolGateEvent) => void;
}

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface PreparedToolCall {
  toolCall: AssistantToolCall;
  input: unknown;
}

interface InvalidToolCall {
  toolCall: AssistantToolCall;
  input: unknown;
  result: ToolResult;
}

interface ToolBatchValidation {
  prepared: PreparedToolCall[];
  invalid: InvalidToolCall[];
  idsUsable: boolean;
  onlyInvalidJson: boolean;
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

function invalidToolCallProtocolResult(message: string): ToolResult {
  return {
    ok: false,
    summary: '模型工具调用协议无效',
    error: {
      code: 'INVALID_TOOL_CALL_PROTOCOL',
      message,
    },
  };
}

function rejectedBatchResult(): ToolResult {
  return {
    ok: false,
    summary: '同批工具调用包含协议错误，本调用未执行',
    error: {
      code: 'TOOL_BATCH_REJECTED',
      message: '请修正整批工具调用后重试一次',
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

const PURE_GREETING = /^(?:你好(?:呀|啊|哇)?|您好|嗨|哈喽|在吗|hi|hello|hey)[\s!！?？。,.，]*$/iu;

function taskAllowsTools(task: string): boolean {
  return !PURE_GREETING.test(task.trim());
}

async function appendInterrupted(
  options: RunAgentTaskOptions,
  reason: string,
): Promise<void> {
  try {
    if (options.appendInterrupted !== undefined) {
      await options.appendInterrupted(reason);
    } else {
      await options.session.store.append(options.session.id, {
        type: 'interrupted',
        at: Date.now(),
        reason,
      });
    }
  } catch {
    // The interruption event is still emitted even if persistence is unavailable.
  }
}

async function appendSessionEvent(
  session: AgentSession,
  event: SessionEvent,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await session.store.append(session.id, event);
  throwIfAborted(signal);
}

function validateToolBatch(
  toolCalls: readonly AssistantToolCall[],
): ToolBatchValidation {
  const prepared: PreparedToolCall[] = [];
  const invalidByCall = new Map<AssistantToolCall, ToolResult>();
  const idCounts = new Map<string, number>();

  for (const toolCall of toolCalls) {
    idCounts.set(toolCall.id, (idCounts.get(toolCall.id) ?? 0) + 1);
  }

  let idsUsable = true;
  let onlyInvalidJson = true;
  for (const toolCall of toolCalls) {
    let protocolMessage: string | undefined;
    if (toolCall.id.trim() === '') {
      protocolMessage = '工具调用 id 不能为空';
    } else if ((idCounts.get(toolCall.id) ?? 0) > 1) {
      protocolMessage = '同一响应中的工具调用 id 必须唯一';
    } else if (toolCall.function.name.trim() === '') {
      protocolMessage = '工具调用名称不能为空';
    }

    if (protocolMessage !== undefined) {
      idsUsable = false;
      onlyInvalidJson = false;
      invalidByCall.set(
        toolCall,
        invalidToolCallProtocolResult(protocolMessage),
      );
      continue;
    }

    try {
      prepared.push({
        toolCall,
        input: JSON.parse(toolCall.function.arguments),
      });
    } catch {
      invalidByCall.set(toolCall, invalidArgumentsResult());
    }
  }

  const parsedInputs = new Map(
    prepared.map(entry => [entry.toolCall, entry.input]),
  );
  const invalid = invalidByCall.size === 0
    ? []
    : toolCalls.map((toolCall): InvalidToolCall => ({
      toolCall,
      input: parsedInputs.get(toolCall)
        ?? {arguments: toolCall.function.arguments},
      result: invalidByCall.get(toolCall) ?? rejectedBatchResult(),
    }));

  return {
    prepared,
    invalid,
    idsUsable,
    onlyInvalidJson,
  };
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
    let toolProtocolCorrectionPending = false;

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
    await appendSessionEvent(options.session, {
      type: 'user',
      at: Date.now(),
      text: options.task,
    }, options.signal);
    const messages = await abortableCall(() => buildContext({
      systemPrompt: buildAgentSystemPrompt({
        workspace,
        task: options.task,
      }),
      currentTask: options.task,
      events: history,
      maxTokens: options.maxContextTokens ?? 16_000,
    }), options.signal);
    const allowTools = taskAllowsTools(options.task);
    const tools = allowTools
      ? options.registry.modelToolDefinitions()
      : undefined;

    while (true) {
      if (turns >= maxTurns) {
        yield {type: 'limit_reached', limit: 'turns'};
        return;
      }
      turns += 1;

      let assistantText = '';
      let finishReason: string | undefined;
      let finishCount = 0;
      const calls = new Map<number, PendingToolCall>();
      const callOrder: number[] = [];
      throwIfAborted(options.signal);
      const iterator = options.model.stream({
        model: modelName,
        messages,
        tools,
        toolChoice: allowTools ? 'auto' : 'none',
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
        } else if (event.type === 'finish') {
          finishReason = event.reason;
          finishCount += 1;
        }
      }

      const hasToolCalls = callOrder.length > 0;
      if (finishCount !== 1 || finishReason === undefined) {
        yield {
          type: 'error',
          message: '模型响应协议不一致：必须且只能包含一个 finish 事件',
        };
        return;
      }
      if (!hasToolCalls && finishReason !== 'stop') {
        yield {
          type: 'error',
          message: finishReason === 'length' || finishReason === 'content_filter'
            ? `模型响应未正常完成：${finishReason}`
            : `模型响应协议不一致：纯文本响应以 ${finishReason} 结束`,
        };
        return;
      }
      if (hasToolCalls && finishReason !== 'tool_calls') {
        yield {
          type: 'error',
          message: `模型响应协议不一致：工具调用响应以 ${finishReason} 结束`,
        };
        return;
      }

      if (assistantText !== '') {
        await appendSessionEvent(options.session, {
          type: 'assistant',
          at: Date.now(),
          text: assistantText,
        }, options.signal);
        yield hasToolCalls
          ? {type: 'assistant_message', text: assistantText}
          : {type: 'assistant_text', text: assistantText};
      }

      if (!hasToolCalls) return;

      const toolCalls: AssistantToolCall[] = callOrder.map((index) => {
        const call = calls.get(index)!;
        return {
          id: call.id,
          type: 'function',
          function: {name: call.name, arguments: call.arguments},
        };
      });
      const batch = validateToolBatch(toolCalls);
      if (batch.invalid.length > 0) {
        if (batch.idsUsable) {
          messages.push({
            role: 'assistant',
            content: assistantText === '' ? null : assistantText,
            tool_calls: toolCalls,
          });
        }

        for (const invalidCall of batch.invalid) {
          yield {
            type: 'tool_finished',
            name: invalidCall.toolCall.function.name,
            result: invalidCall.result,
          };
          await appendSessionEvent(options.session, {
            type: 'tool',
            at: Date.now(),
            tool: invalidCall.toolCall.function.name,
            input: invalidCall.input,
            result: invalidCall.result,
          }, options.signal);
          if (batch.idsUsable) {
            messages.push({
              role: 'tool',
              tool_call_id: invalidCall.toolCall.id,
              content: serializeResult(invalidCall.result),
            });
          }
        }

        if (!batch.idsUsable) {
          messages.push({
            role: 'system',
            content: [
              '上一轮工具调用协议无效，整批均未执行。',
              '请确保每个工具调用都有非空且唯一的 id、非空名称和合法 JSON 参数，然后仅修正一次。',
            ].join('\n'),
          });
        }
        if (toolProtocolCorrectionPending) {
          yield {
            type: 'error',
            message: batch.onlyInvalidJson
              ? '模型连续两次提供了无效的工具调用 JSON'
              : '模型连续两次提供了无效的工具调用协议',
          };
          return;
        }
        toolProtocolCorrectionPending = true;
        continue;
      }

      toolProtocolCorrectionPending = false;
      messages.push({
        role: 'assistant',
        content: assistantText === '' ? null : assistantText,
        tool_calls: toolCalls,
      });

      for (const {toolCall, input} of batch.prepared) {
        if (toolCallCount >= maxToolCalls) {
          yield {type: 'limit_reached', limit: 'tools'};
          return;
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
            reportGate: options.reportGate,
          },
        ), options.signal);
        yield {
          type: 'tool_finished',
          name: toolCall.function.name,
          result,
        };
        await appendSessionEvent(options.session, {
          type: 'tool',
          at: Date.now(),
          tool: toolCall.function.name,
          input,
          result,
        }, options.signal);
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
      await appendInterrupted(options, safeReason);
      yield {type: 'interrupted', reason: safeReason};
      return;
    }
    yield {type: 'error', message: safeErrorMessage(error)};
  }
}
