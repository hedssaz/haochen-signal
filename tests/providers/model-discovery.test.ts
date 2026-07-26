import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  discoverModels,
  ModelDiscoveryError,
} from '../../src/providers/model-discovery.js';

const TWO_MEBIBYTES = 2 * 1024 * 1024;
const API_KEY = 'discovery-secret-key';
const provider = {
  baseUrl: 'https://models.example.test/v1',
  headers: {'x-tenant': 'alpha'},
};

function options(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof discoverModels>[0]> = {},
): Parameters<typeof discoverModels>[0] {
  return {
    provider,
    apiKey: API_KEY,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    fetch: fetchImpl,
    ...overrides,
  };
}

function mockFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return vi.fn(implementation) as unknown as typeof fetch;
}

function sizedModelList(size: number): string {
  const prefix = '{"data":[{"id":"model-a"}],"padding":"';
  const suffix = '"}';
  return `${prefix}${'x'.repeat(size - prefix.length - suffix.length)}${suffix}`;
}

describe('discoverModels', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests OpenAI-compatible /models with provider headers and Bearer auth', async () => {
    const fetchImpl = mockFetch(async () => new Response(
      JSON.stringify({data: [{id: 'model-a'}]}),
      {status: 200},
    ));

    await expect(discoverModels(options(fetchImpl))).resolves.toEqual(['model-a']);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (
      fetchImpl as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://models.example.test/v1/models');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers)).toEqual(new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'x-tenant': 'alpha',
    }));
  });

  it('trims IDs, removes duplicates and returns deterministic dictionary order', async () => {
    const fetchImpl = mockFetch(async () => new Response(JSON.stringify({
      data: [
        {id: 'zeta'},
        {id: ' beta '},
        {id: 'alpha'},
        {id: 'beta'},
        {id: 'Alpha'},
      ],
    })));

    await expect(discoverModels(options(fetchImpl))).resolves.toEqual([
      'Alpha',
      'alpha',
      'beta',
      'zeta',
    ]);
  });

  it.each([
    ['a non-object response', '[]'],
    ['missing data', '{}'],
    ['non-array data', '{"data":{}}'],
    ['an empty list', '{"data":[]}'],
    ['an entry without id', '{"data":[{}]}'],
    ['a non-string id', '{"data":[{"id":7}]}'],
    ['a blank id', '{"data":[{"id":"  "}]}'],
  ])('rejects %s', async (_name, body) => {
    const fetchImpl = mockFetch(async () => new Response(body));

    await expect(discoverModels(options(fetchImpl))).rejects.toThrow(
      '模型列表响应格式无效',
    );
  });

  it('rejects invalid JSON without including response contents or the API key', async () => {
    const fetchImpl = mockFetch(async () => new Response(
      `not-json ${API_KEY}`,
    ));

    const error = await discoverModels(options(fetchImpl)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('不是有效 JSON');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('rejects non-success status without exposing status text containing the API key', async () => {
    const fetchImpl = mockFetch(async () => new Response('denied', {
      status: 401,
      statusText: `Denied ${API_KEY}`,
    }));

    const error = await discoverModels(options(fetchImpl)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it.each([
    ['an ordinary Error', () => new Error(API_KEY)],
    ['a public ModelDiscoveryError', () => new ModelDiscoveryError(API_KEY)],
  ])('redacts the API key from %s thrown by the transport', async (_name, createError) => {
    const fetchImpl = mockFetch(async () => {
      throw createError();
    });

    const error = await discoverModels(options(fetchImpl)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('获取模型失败');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('redacts the API key from an injected response body error', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new ModelDiscoveryError(API_KEY);
      },
    }, {highWaterMark: 0});
    const fetchImpl = mockFetch(async () => new Response(body));

    const error = await discoverModels(options(fetchImpl)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('获取模型失败');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('rebuilds and sanitizes a previously returned internal error after its message is mutated', async () => {
    const invalidFetch = mockFetch(async () => new Response(
      JSON.stringify({data: []}),
    ));
    const previous = await discoverModels(options(invalidFetch)).catch(
      (caught: unknown) => caught,
    ) as ModelDiscoveryError;
    expect(previous.code).toBe('INVALID_RESPONSE');
    previous.message = API_KEY;

    const injectedFetch = mockFetch(async () => {
      throw previous;
    });
    const error = await discoverModels(options(injectedFetch)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ModelDiscoveryError);
    expect(error).not.toBe(previous);
    expect((error as ModelDiscoveryError).code).toBe('TRANSPORT_ERROR');
    expect((error as ModelDiscoveryError).message).not.toContain(API_KEY);
    expect(Object.getOwnPropertyDescriptor(error, 'code')?.writable).toBe(false);
  });

  it('accepts a JSON response exactly at the 2 MiB limit', async () => {
    const body = sizedModelList(TWO_MEBIBYTES);
    expect(Buffer.byteLength(body)).toBe(TWO_MEBIBYTES);
    const fetchImpl = mockFetch(async () => new Response(body));

    await expect(discoverModels(options(fetchImpl))).resolves.toEqual(['model-a']);
  });

  it('rejects a streamed response that exceeds 2 MiB', async () => {
    const fetchImpl = mockFetch(async () => new Response(
      sizedModelList(TWO_MEBIBYTES + 1),
    ));

    await expect(discoverModels(options(fetchImpl))).rejects.toThrow(
      '模型列表响应超过 2 MiB',
    );
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    }, {highWaterMark: 0});
    const fetchImpl = mockFetch(async () => new Response(body, {
      headers: {'content-length': String(TWO_MEBIBYTES + 1)},
    }));

    await expect(discoverModels(options(fetchImpl))).rejects.toThrow(
      '模型列表响应超过 2 MiB',
    );
    expect(pullCount).toBe(0);
  });

  it('honors caller cancellation without exposing an API key in the abort reason', async () => {
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const fetchImpl = mockFetch(async (_input, init) => {
      transportSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        transportSignal!.addEventListener(
          'abort',
          () => reject(transportSignal!.reason),
          {once: true},
        );
      });
    });

    const pending = discoverModels(options(fetchImpl, {
      signal: caller.signal,
    }));
    caller.abort(new Error(`cancel ${API_KEY}`));
    const error = await pending.catch((caught: unknown) => caught);

    expect(transportSignal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('times out a request and aborts the transport signal', async () => {
    vi.useFakeTimers();
    let transportSignal: AbortSignal | undefined;
    const fetchImpl = mockFetch(async (_input, init) => {
      transportSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        transportSignal!.addEventListener(
          'abort',
          () => reject(transportSignal!.reason),
          {once: true},
        );
      });
    });

    const pending = discoverModels(options(fetchImpl, {timeoutMs: 25}));
    const rejection = pending.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(25);
    const error = await rejection;

    expect(transportSignal?.aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('TimeoutError');
    expect((error as Error).message).toContain('25');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('settles on timeout even when an injected transport ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const fetchImpl = mockFetch(async () => new Promise<Response>(() => {}));
    const rejection = discoverModels(options(fetchImpl, {
      timeoutMs: 25,
    })).catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(25);
    const result = await Promise.race([
      rejection,
      Promise.resolve('still pending'),
    ]);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe('TimeoutError');
  });
});
