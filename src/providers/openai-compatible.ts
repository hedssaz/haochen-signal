import type {HaochenConfig} from '../config/schema.js';
import {redactValue} from '../security/redact.js';
import {decodeSse} from './sse.js';
import type {ModelClient, ModelEvent, ModelRequest} from './types.js';

interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const SENSITIVE_HEADER_NAME =
  /(?:^|[-_])(?:authorization|cookie|set[-_]?cookie|api[-_]?key|key|token|secret)(?:$|[-_])/i;

interface OperationSignal {
  signal: AbortSignal;
  dispose(): void;
}

export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export class ModelHttpError extends ModelProviderError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelHttpError';
    this.status = status;
  }
}

function createOperationSignal(
  callerSignal: AbortSignal,
  timeoutMs: number,
): OperationSignal {
  const controller = new AbortController();
  const onCallerAbort = () => {
    controller.abort(callerSignal.reason);
  };

  if (callerSignal.aborted) {
    onCallerAbort();
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, {once: true});
  }

  const timeout = setTimeout(() => {
    controller.abort(new DOMException(
      `Model request timed out after ${timeoutMs}ms`,
      'TimeoutError',
    ));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
}

function collectSensitiveValues(headers: Headers, apiKey: string): string[] {
  const values = new Set<string>();
  if (apiKey.length > 0) values.add(apiKey);

  for (const [name, value] of headers) {
    if (value.length > 0 && SENSITIVE_HEADER_NAME.test(name)) {
      values.add(value);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

function redactErrorMessage(rawMessage: string, secrets: string[]): string {
  const redacted = redactValue(rawMessage);
  let message = typeof redacted === 'string' ? redacted : 'Model provider failed';

  for (const secret of secrets) {
    message = message.replaceAll(secret, '[REDACTED]');
  }

  return message;
}

function errorDescription(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function providerError(
  context: string,
  error: unknown,
  secrets: string[],
  signal: AbortSignal,
): Error {
  if (signal.aborted) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
  if (error instanceof ModelProviderError) return error;

  return new ModelProviderError(redactErrorMessage(
    `${context}: ${errorDescription(error)}`,
    secrets,
  ));
}

function httpErrorMessage(response: Response, secrets: string[]): string {
  const rawMessage =
    `Model request failed with status ${response.status} ${response.statusText}`;
  return redactErrorMessage(rawMessage, secrets);
}

function retryDelayMs(response: Response, now: () => number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) return 1_000;
  const trimmed = retryAfter.trim();
  const seconds = Number(retryAfter);
  if (trimmed.length > 0 && Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1_000 : 1_000;
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - now())
    : 1_000;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

async function fetchResponse(
  fetchImpl: typeof fetch,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  now: () => number,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 2) {
      return response;
    }

    await response.body?.cancel();
    await sleep(retryDelayMs(response, now), signal);
  }

  throw new Error('unreachable retry state');
}

async function* responseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let abortCancellation: Promise<void> | undefined;
  let reachedNaturalEof = false;
  const onAbort = () => {
    abortCancellation = reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, {once: true});

  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) {
        reachedNaturalEof = true;
        return;
      }
      yield result.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!reachedNaturalEof) {
      await (abortCancellation ?? reader.cancel(new Error(
        'Model response stream was not fully consumed',
      )).catch(() => {}));
    }
    reader.releaseLock();
  }
}

function requestBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: {include_usage: true},
    ...(request.tools === undefined ? {} : {tools: request.tools}),
    ...(request.toolChoice === undefined
      ? {}
      : {tool_choice: request.toolChoice}),
  };
}

function accumulateToolCall(
  calls: Map<number, AccumulatedToolCall>,
  delta: ToolCallDelta,
): void {
  const existing = calls.get(delta.index) ?? {index: delta.index};
  calls.set(delta.index, {
    ...existing,
    ...(delta.id === undefined ? {} : {id: delta.id}),
    ...(delta.function?.name === undefined ? {} : {name: delta.function.name}),
    ...(delta.function?.arguments === undefined
      ? {}
      : {arguments: `${existing.arguments ?? ''}${delta.function.arguments}`}),
  });
}

async function* streamResponse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<ModelEvent> {
  if (response.body === null) throw new Error('Model response has no body');

  const toolCalls = new Map<number, AccumulatedToolCall>();
  let finishReason: string | undefined;
  let usage: {inputTokens: number; outputTokens: number} | undefined;

  for await (const data of decodeSse(
    responseChunks(response.body, signal),
    {requireCompleteFinalFrame: true},
  )) {
    if (data === '[DONE]') {
      if (finishReason === undefined) {
        throw new Error(
          'Chat completions stream received [DONE] before finish_reason',
        );
      }
      break;
    }

    const chunk = JSON.parse(data) as ChatCompletionChunk;
    if (
      typeof chunk.usage?.prompt_tokens === 'number'
      && typeof chunk.usage.completion_tokens === 'number'
    ) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
    }

    for (const choice of chunk.choices ?? []) {
      const content = choice.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield {type: 'text_delta', text: content};
      }

      for (const toolCall of choice.delta?.tool_calls ?? []) {
        accumulateToolCall(toolCalls, toolCall);
      }

      if (typeof choice.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }
    }
  }

  if (finishReason === undefined) {
    throw new Error(
      'Chat completions stream ended before finish_reason',
    );
  }

  for (const toolCall of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
    yield {type: 'tool_call_delta', ...toolCall};
  }

  yield {type: 'finish', reason: finishReason, usage};
}

export function createOpenAiCompatibleClient(
  config: HaochenConfig,
  apiKey: string,
  options: ClientOptions = {},
): ModelClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  return {
    async *stream(request: ModelRequest, callerSignal: AbortSignal) {
      const operation = createOperationSignal(callerSignal, config.timeoutMs);

      try {
        const headers = new Headers(config.headers);
        headers.set('content-type', 'application/json');
        headers.set('authorization', `Bearer ${apiKey}`);
        const secrets = collectSensitiveValues(headers, apiKey);
        let response: Response;
        try {
          response = await fetchResponse(
            fetchImpl,
            sleep,
            now,
            `${config.baseUrl}/chat/completions`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(requestBody(request)),
              signal: operation.signal,
            },
            operation.signal,
          );
        } catch (error) {
          throw providerError(
            'Model fetch failed',
            error,
            secrets,
            operation.signal,
          );
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new ModelHttpError(
            response.status,
            httpErrorMessage(response, secrets),
          );
        }

        try {
          yield* streamResponse(response, operation.signal);
        } catch (error) {
          throw providerError(
            'Model response stream failed',
            error,
            secrets,
            operation.signal,
          );
        }
      } finally {
        operation.dispose();
      }
    },
  };
}
