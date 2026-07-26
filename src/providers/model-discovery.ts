import type {ProviderProfile} from '../config/schema.js';
import {redactValue} from '../security/redact.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface DiscoverModelsOptions {
  provider: Pick<ProviderProfile, 'baseUrl' | 'headers'>;
  apiKey: string;
  timeoutMs: number;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

interface OperationSignal {
  signal: AbortSignal;
  failure(): InternalFailure | undefined;
  dispose(): void;
}

export type ModelDiscoveryErrorCode =
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'
  | 'INVALID_TIMEOUT'
  | 'MISSING_API_KEY'
  | 'RESPONSE_TOO_LARGE'
  | 'TRANSPORT_ERROR';

export class ModelDiscoveryError extends Error {
  readonly code!: ModelDiscoveryErrorCode;

  constructor(
    message: string,
    code: ModelDiscoveryErrorCode = 'TRANSPORT_ERROR',
  ) {
    super(message);
    this.name = 'ModelDiscoveryError';
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
}

type InternalFailure =
  | {code: 'ABORTED'}
  | {code: 'HTTP_ERROR'; status: number}
  | {code: 'INVALID_JSON'}
  | {
    code: 'INVALID_RESPONSE';
    reason: 'EMPTY_DATA' | 'INVALID_ID' | 'MISSING_DATA';
  }
  | {code: 'INVALID_TIMEOUT'}
  | {code: 'MISSING_API_KEY'}
  | {code: 'RESPONSE_TOO_LARGE'}
  | {code: 'TIMEOUT'; timeoutMs: number};

const internalFailures = new WeakMap<object, Readonly<InternalFailure>>();

function internalFailure(failure: InternalFailure): Error {
  const error = new Error('Internal model discovery failure');
  internalFailures.set(error, Object.freeze({...failure}));
  return error;
}

function failureMessage(failure: Readonly<InternalFailure>): string {
  switch (failure.code) {
    case 'ABORTED':
      return '已取消获取模型。';
    case 'HTTP_ERROR':
      return `获取模型失败：HTTP ${failure.status}。`;
    case 'INVALID_JSON':
      return '模型列表响应不是有效 JSON。';
    case 'INVALID_RESPONSE':
      switch (failure.reason) {
        case 'EMPTY_DATA':
          return '模型列表响应格式无效：data 不能为空。';
        case 'INVALID_ID':
          return '模型列表响应格式无效：data[].id 必须是非空字符串。';
        case 'MISSING_DATA':
          return '模型列表响应格式无效：缺少 data 数组。';
      }
    case 'INVALID_TIMEOUT':
      return '获取模型超时时间无效。';
    case 'MISSING_API_KEY':
      return '获取模型需要 API Key。';
    case 'RESPONSE_TOO_LARGE':
      return '模型列表响应超过 2 MiB。';
    case 'TIMEOUT':
      return `获取模型请求超过 ${failure.timeoutMs} 毫秒。`;
  }
}

function createOperationSignal(
  callerSignal: AbortSignal,
  timeoutMs: number,
): OperationSignal {
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw internalFailure({code: 'INVALID_TIMEOUT'});
  }

  const controller = new AbortController();
  let abortFailure: InternalFailure | undefined;
  const abortWith = (failure: InternalFailure) => {
    if (controller.signal.aborted) return;
    abortFailure = Object.freeze({...failure});
    controller.abort();
  };
  const onCallerAbort = () => abortWith({code: 'ABORTED'});
  if (callerSignal.aborted) {
    onCallerAbort();
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, {once: true});
  }
  const timeout = setTimeout(() => {
    abortWith({code: 'TIMEOUT', timeoutMs});
  }, timeoutMs);

  return {
    signal: controller.signal,
    failure() {
      return abortFailure;
    },
    dispose() {
      clearTimeout(timeout);
      callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
}

function sanitizedMessage(
  raw: string,
  apiKey: string,
): string {
  const generallyRedacted = redactValue(raw);
  const message = typeof generallyRedacted === 'string'
    ? generallyRedacted
    : '未知错误';
  return apiKey.length === 0
    ? message
    : message.replaceAll(apiKey, '[REDACTED]');
}

function sanitizedErrorDescription(
  error: unknown,
  apiKey: string,
): string {
  let description: string;
  try {
    if (
      (typeof error === 'object' && error !== null)
      || typeof error === 'function'
    ) {
      const candidate = error as {
        name?: unknown;
        message?: unknown;
      };
      const name = candidate.name;
      const message = candidate.message;
      if (typeof name === 'string' && typeof message === 'string') {
        description = `${name}: ${message}`;
      } else if (typeof message === 'string') {
        description = message;
      } else {
        description = String(error);
      }
    } else {
      description = String(error);
    }
  } catch {
    description = '模型列表请求失败';
  }
  return sanitizedMessage(description, apiKey);
}

function publicFailure(
  failure: Readonly<InternalFailure>,
  apiKey: string,
): Error {
  const message = sanitizedMessage(failureMessage(failure), apiKey);
  if (failure.code === 'ABORTED') {
    return new DOMException(message, 'AbortError');
  }
  if (failure.code === 'TIMEOUT') {
    return new DOMException(message, 'TimeoutError');
  }
  return new ModelDiscoveryError(message, failure.code);
}

function publicTransportError(
  error: unknown,
  apiKey: string,
): ModelDiscoveryError {
  return new ModelDiscoveryError(
    sanitizedMessage(
      `获取模型失败：${sanitizedErrorDescription(error, apiKey)}`,
      apiKey,
    ),
    'TRANSPORT_ERROR',
  );
}

function compareModelIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateModelList(payload: unknown): string[] {
  if (
    typeof payload !== 'object'
    || payload === null
    || Array.isArray(payload)
    || !Array.isArray((payload as {data?: unknown}).data)
  ) {
    throw internalFailure({
      code: 'INVALID_RESPONSE',
      reason: 'MISSING_DATA',
    });
  }

  const data = (payload as {data: unknown[]}).data;
  if (data.length === 0) {
    throw internalFailure({
      code: 'INVALID_RESPONSE',
      reason: 'EMPTY_DATA',
    });
  }

  const modelIds = new Set<string>();
  for (const entry of data) {
    if (
      typeof entry !== 'object'
      || entry === null
      || typeof (entry as {id?: unknown}).id !== 'string'
    ) {
      throw internalFailure({
        code: 'INVALID_RESPONSE',
        reason: 'INVALID_ID',
      });
    }
    const id = (entry as {id: string}).id.trim();
    if (id.length === 0) {
      throw internalFailure({
        code: 'INVALID_RESPONSE',
        reason: 'INVALID_ID',
      });
    }
    modelIds.add(id);
  }

  return [...modelIds].sort(compareModelIds);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // Response cleanup must not replace the bounded discovery error.
  }
}

function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      Number.isFinite(parsedLength)
      && parsedLength > MAX_RESPONSE_BYTES
    ) {
      cancelBody(response.body);
      throw internalFailure({code: 'RESPONSE_TOO_LARGE'});
    }
  }

  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let readerCancelled = false;
  const cancelReader = (reason: unknown) => {
    if (readerCancelled) return;
    readerCancelled = true;
    try {
      void reader.cancel(reason).catch(() => {});
    } catch {
      // Best-effort cancellation; the caller receives the original error.
    }
  };
  const onAbort = () => cancelReader(signal.reason);
  signal.addEventListener('abort', onAbort, {once: true});

  try {
    while (true) {
      signal.throwIfAborted();
      const next = await waitForAbortable(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        cancelReader(new Error('模型列表响应超过上限'));
        throw internalFailure({code: 'RESPONSE_TOO_LARGE'});
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  return Buffer.concat(chunks, bytes).toString('utf8');
}

export async function discoverModels(
  options: DiscoverModelsOptions,
): Promise<string[]> {
  let apiKey = '';
  let operation: OperationSignal | undefined;
  try {
    apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw internalFailure({code: 'MISSING_API_KEY'});
    }
    operation = createOperationSignal(options.signal, options.timeoutMs);
    operation.signal.throwIfAborted();
    const headers = new Headers(options.provider.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${apiKey}`);
    const url = `${options.provider.baseUrl.replace(/\/+$/, '')}/models`;
    const response = await waitForAbortable(
      (options.fetch ?? globalThis.fetch)(url, {
        method: 'GET',
        headers,
        signal: operation.signal,
      }),
      operation.signal,
    );
    operation.signal.throwIfAborted();

    if (!response.ok) {
      cancelBody(response.body);
      const status = Number.isInteger(response.status)
        ? response.status
        : 0;
      throw internalFailure({code: 'HTTP_ERROR', status});
    }

    const responseText = await readBoundedResponse(
      response,
      operation.signal,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw internalFailure({code: 'INVALID_JSON'});
    }
    return validateModelList(payload);
  } catch (error) {
    const operationFailure = operation?.failure();
    if (operationFailure !== undefined) {
      throw publicFailure(operationFailure, apiKey);
    }
    const failure =
      (typeof error === 'object' && error !== null)
      || typeof error === 'function'
        ? internalFailures.get(error)
        : undefined;
    if (failure !== undefined) {
      throw publicFailure(failure, apiKey);
    }
    throw publicTransportError(error, apiKey);
  } finally {
    operation?.dispose();
  }
}
