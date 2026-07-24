import type {HaochenConfig} from '../config/schema.js';
import {redactValue} from '../security/redact.js';
import {decodeSse} from './sse.js';
import type {ModelClient, ModelEvent, ModelRequest} from './types.js';

interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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

export class ModelHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelHttpError';
    this.status = status;
  }
}

function httpErrorMessage(response: Response, apiKey: string): string {
  const rawMessage =
    `Model request failed with status ${response.status} ${response.statusText}`;
  const redactedMessage = redactValue(rawMessage);
  const message = typeof redactedMessage === 'string'
    ? redactedMessage
    : `Model request failed with status ${response.status}`;

  return apiKey.length > 0
    ? message.replaceAll(apiKey, '[REDACTED]')
    : message;
}

function retryDelayMs(response: Response): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) return 1_000;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 1_000;
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
    await sleep(retryDelayMs(response), signal);
  }

  throw new Error('unreachable retry state');
}

async function* responseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, {once: true});

  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
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

  for await (const data of decodeSse(responseChunks(response.body, signal))) {
    if (data === '[DONE]') break;

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

  for (const toolCall of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
    yield {type: 'tool_call_delta', ...toolCall};
  }

  if (finishReason !== undefined) {
    yield {type: 'finish', reason: finishReason, usage};
  }
}

export function createOpenAiCompatibleClient(
  config: HaochenConfig,
  apiKey: string,
  options: ClientOptions = {},
): ModelClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async *stream(request: ModelRequest, signal: AbortSignal) {
      const headers = new Headers(config.headers);
      headers.set('content-type', 'application/json');
      headers.set('authorization', `Bearer ${apiKey}`);
      const response = await fetchResponse(
        fetchImpl,
        sleep,
        `${config.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody(request)),
          signal,
        },
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelHttpError(
          response.status,
          httpErrorMessage(response, apiKey),
        );
      }

      yield* streamResponse(response, signal);
    },
  };
}
