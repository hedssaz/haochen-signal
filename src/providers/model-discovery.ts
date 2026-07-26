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
  dispose(): void;
}

export class ModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

class InternalModelDiscoveryError extends ModelDiscoveryError {}

function discoveryError(message: string): InternalModelDiscoveryError {
  return new InternalModelDiscoveryError(message);
}

function safeAbortError(): DOMException {
  return new DOMException('已取消获取模型。', 'AbortError');
}

function safeTimeoutError(timeoutMs: number): DOMException {
  return new DOMException(
    `获取模型请求超过 ${timeoutMs} 毫秒。`,
    'TimeoutError',
  );
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
    throw discoveryError('获取模型超时时间无效。');
  }

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(safeAbortError());
  if (callerSignal.aborted) {
    onCallerAbort();
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, {once: true});
  }
  const timeout = setTimeout(() => {
    controller.abort(safeTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
}

function sanitizedErrorDescription(
  error: unknown,
  apiKey: string,
): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  const generallyRedacted = redactValue(raw);
  const message = typeof generallyRedacted === 'string'
    ? generallyRedacted
    : '未知错误';
  return apiKey.length === 0
    ? message
    : message.replaceAll(apiKey, '[REDACTED]');
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
    throw discoveryError('模型列表响应格式无效：缺少 data 数组。');
  }

  const data = (payload as {data: unknown[]}).data;
  if (data.length === 0) {
    throw discoveryError('模型列表响应格式无效：data 不能为空。');
  }

  const modelIds = new Set<string>();
  for (const entry of data) {
    if (
      typeof entry !== 'object'
      || entry === null
      || typeof (entry as {id?: unknown}).id !== 'string'
    ) {
      throw discoveryError(
        '模型列表响应格式无效：data[].id 必须是非空字符串。',
      );
    }
    const id = (entry as {id: string}).id.trim();
    if (id.length === 0) {
      throw discoveryError(
        '模型列表响应格式无效：data[].id 必须是非空字符串。',
      );
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
      throw discoveryError('模型列表响应超过 2 MiB。');
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
        throw discoveryError('模型列表响应超过 2 MiB。');
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
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw discoveryError('获取模型需要 API Key。');
  }

  const operation = createOperationSignal(options.signal, options.timeoutMs);
  try {
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
      throw discoveryError(
        `获取模型失败：HTTP ${response.status}。`,
      );
    }

    const responseText = await readBoundedResponse(
      response,
      operation.signal,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw discoveryError('模型列表响应不是有效 JSON。');
    }
    return validateModelList(payload);
  } catch (error) {
    if (operation.signal.aborted) {
      const reason = operation.signal.reason;
      if (reason instanceof DOMException) throw reason;
      throw safeAbortError();
    }
    if (error instanceof InternalModelDiscoveryError) throw error;
    throw discoveryError(
      `获取模型失败：${sanitizedErrorDescription(error, apiKey)}`,
    );
  } finally {
    operation.dispose();
  }
}
