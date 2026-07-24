import {describe, expect, it, vi} from 'vitest';
import {parseConfig} from '../../src/config/schema.js';
import {
  createOpenAiCompatibleClient,
  ModelHttpError,
  ModelProviderError,
} from '../../src/providers/openai-compatible.js';
import type {ModelEvent} from '../../src/providers/types.js';
import {
  scriptedModel,
  textResponse,
  toolResponse,
} from '../helpers/scripted-model.js';

function sseResponse(events: unknown[]): Response {
  const body = events
    .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');

  return new Response(body, {
    status: 200,
    headers: {'content-type': 'text/event-stream'},
  });
}

describe('OpenAI-compatible chat completions client', () => {
  it('posts chat completions and streams text plus an assembled tool call', async () => {
    let receivedUrl: string | undefined;
    let receivedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedInit = init;
      return sseResponse([
        {choices: [{delta: {content: '正在'}}]},
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {name: 'read_file', arguments: '{"path":'},
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: {arguments: '"README.md"}'},
              }],
            },
          }],
        },
        {choices: [{delta: {}, finish_reason: 'tool_calls'}]},
        '[DONE]',
      ]);
    }) as typeof fetch;
    const config = parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      headers: {
        authorization: 'Bearer configured-key',
        'x-project': 'haochen',
      },
    });
    const client = createOpenAiCompatibleClient(config, 'test-key', {fetch: fetchImpl});
    const events: ModelEvent[] = [];

    for await (const event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '读取项目'}],
    }, new AbortController().signal)) {
      events.push(event);
    }

    expect(receivedUrl).toBe('https://example.test/v1/chat/completions');
    expect(receivedInit?.method).toBe('POST');
    expect(JSON.parse(String(receivedInit?.body))).toMatchObject({
      model: 'wolf-1',
      stream: true,
      messages: [{role: 'user', content: '读取项目'}],
    });
    expect(Object.fromEntries(new Headers(receivedInit?.headers).entries())).toMatchObject({
      authorization: 'Bearer test-key',
      'x-project': 'haochen',
    });
    expect(events).toEqual([
      {type: 'text_delta', text: '正在'},
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      {type: 'finish', reason: 'tool_calls', usage: undefined},
    ]);
  });

  it('requests and maps token usage onto the finish event', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {choices: [{delta: {content: '完成'}}]},
        {choices: [{delta: {}, finish_reason: 'stop'}]},
        {choices: [], usage: {prompt_tokens: 12, completion_tokens: 3}},
      ]);
    }) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});
    const events: ModelEvent[] = [];

    for await (const event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '完成任务'}],
    }, new AbortController().signal)) {
      events.push(event);
    }

    expect(receivedBody).toMatchObject({
      stream_options: {include_usage: true},
    });
    expect(events).toEqual([
      {type: 'text_delta', text: '完成'},
      {
        type: 'finish',
        reason: 'stop',
        usage: {inputTokens: 12, outputTokens: 3},
      },
    ]);
  });

  it('serializes tools, tool choice, and assistant tool-call history', async () => {
    let receivedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {choices: [{delta: {}, finish_reason: 'stop'}]},
        '[DONE]',
      ]);
    }) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    for await (const _event of client.stream({
      model: 'wolf-1',
      messages: [
        {role: 'user', content: '读取项目'},
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {name: 'read_file', arguments: '{"path":"README.md"}'},
          }],
        },
        {role: 'tool', tool_call_id: 'call_1', content: '# 项目'},
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
          parameters: {
            type: 'object',
            properties: {path: {type: 'string'}},
            required: ['path'],
          },
        },
      }],
      toolChoice: 'auto',
    }, new AbortController().signal)) {
      // The request body is asserted after the stream is consumed.
    }

    expect(receivedBody).toMatchObject({
      messages: [
        {role: 'user', content: '读取项目'},
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {name: 'read_file', arguments: '{"path":"README.md"}'},
          }],
        },
        {role: 'tool', tool_call_id: 'call_1', content: '# 项目'},
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
        },
      }],
      tool_choice: 'auto',
    });
  });

  it('retries a 429 response using Retry-After before streaming success', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: {'retry-after': '0'},
        });
      }
      return sseResponse([
        {choices: [{delta: {content: '重试成功'}}]},
        {choices: [{delta: {}, finish_reason: 'stop'}]},
        '[DONE]',
      ]);
    }) as typeof fetch;
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl, sleep});
    const controller = new AbortController();
    const events: ModelEvent[] = [];

    for await (const event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '重试'}],
    }, controller.signal)) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [delay, retrySignal] = sleep.mock.calls[0] ?? [];
    expect(delay).toBe(0);
    expect(retrySignal).toBeInstanceOf(AbortSignal);
    expect(retrySignal?.aborted).toBe(false);
    expect(events).toEqual([
      {type: 'text_delta', text: '重试成功'},
      {type: 'finish', reason: 'stop', usage: undefined},
    ]);
  });

  it('stops after two retries and redacts authentication from HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('still limited', {
      status: 429,
      statusText: 'Authentication failed for top-secret',
      headers: {'retry-after': '0'},
    })) as typeof fetch;
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'top-secret', {fetch: fetchImpl, sleep});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '重试'}],
      }, new AbortController().signal)) {
        // A terminal HTTP error must not yield model events.
      }
    } catch (error) {
      thrown = error;
    }

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(thrown).toBeInstanceOf(ModelHttpError);
    expect(thrown).toMatchObject({status: 429});
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('top-secret');
  });

  it('redacts an actual x-api-key value echoed by HTTP status text', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', {
      status: 401,
      statusText: 'provider rejected header-secret and bearer-secret',
    })) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      headers: {'x-api-key': 'header-secret'},
    }), 'bearer-secret', {fetch: fetchImpl});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // A terminal HTTP error must not yield model events.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelHttpError);
    expect(thrown).toMatchObject({status: 401});
    expect((thrown as Error).message).toContain('status 401');
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('header-secret');
    expect((thrown as Error).message).not.toContain('bearer-secret');
  });

  it('redacts every supported sensitive header class', async () => {
    const sensitiveHeaders = {
      'proxy-authorization': 'proxy-value',
      cookie: 'cookie-value',
      'set-cookie': 'set-cookie-value',
      'api-key': 'api-value',
      'encryption-key': 'key-value',
      'x-token': 'token-value',
      'client-secret': 'secret-value',
    };
    const fetchImpl = vi.fn(async () => new Response('denied', {
      status: 401,
      statusText: `rejected ${Object.values(sensitiveHeaders).join(' ')}`,
    })) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      headers: sensitiveHeaders,
    }), 'auth-secret', {fetch: fetchImpl});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // A terminal HTTP error must not yield model events.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelHttpError);
    expect((thrown as Error).message).toContain('status 401');
    for (const secret of Object.values(sensitiveHeaders)) {
      expect((thrown as Error).message).not.toContain(secret);
    }
  });

  it('wraps and redacts fetch rejections', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket failed for fetch-secret and auth-secret');
    }) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      headers: {'api-key': 'fetch-secret'},
    }), 'auth-secret', {fetch: fetchImpl});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // A failed fetch must not yield model events.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toContain('Model fetch failed');
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('fetch-secret');
    expect((thrown as Error).message).not.toContain('auth-secret');
  });

  it('wraps and redacts response reader errors', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(
          'reader failed for reader-secret and auth-secret',
        ));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      headers: {'x-api-key': 'reader-secret'},
    }), 'auth-secret', {fetch: fetchImpl});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // A failed reader must not yield model events.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toContain('Model response stream failed');
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('reader-secret');
    expect((thrown as Error).message).not.toContain('auth-secret');
  });

  it('wraps and redacts malformed JSON errors', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'data: parse-secret\n\n',
      {status: 200, headers: {'content-type': 'text/event-stream'}},
    )) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      headers: {'x-api-key': 'parse-secret'},
    }), 'auth-secret', {fetch: fetchImpl});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // Malformed JSON must not yield model events.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toContain('Model response stream failed');
    expect((thrown as Error).message).toContain('[REDACTED]');
    expect((thrown as Error).message).not.toContain('parse-secret');
    expect((thrown as Error).message).not.toContain('auth-secret');
  });

  it('rejects natural EOF before a finish reason', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `data: ${JSON.stringify({choices: [{delta: {content: '未完成'}}]})}\n\n`,
      {status: 200, headers: {'content-type': 'text/event-stream'}},
    )) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});
    const events: ModelEvent[] = [];
    let thrown: unknown;

    try {
      for await (const event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    expect(events).toEqual([{type: 'text_delta', text: '未完成'}]);
    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toContain('finish_reason');
  });

  it('rejects DONE before a finish reason', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      {choices: [{delta: {content: '未完成'}}]},
      '[DONE]',
    ])) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});
    const events: ModelEvent[] = [];
    let thrown: unknown;

    try {
      for await (const event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    expect(events).toEqual([{type: 'text_delta', text: '未完成'}]);
    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toContain('[DONE]');
    expect((thrown as Error).message).toContain('finish_reason');
  });

  it('rejects an SSE frame not terminated by an empty line', async () => {
    const finalChunk = {
      choices: [{delta: {}, finish_reason: 'stop'}],
    };
    const fetchImpl = vi.fn(async () => new Response(
      `data: ${JSON.stringify(finalChunk)}`,
      {status: 200, headers: {'content-type': 'text/event-stream'}},
    )) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});
    let thrown: unknown;

    try {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // An incomplete final frame must not yield a finish event.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ModelProviderError);
    expect((thrown as Error).message).toContain('incomplete SSE frame');
  });

  it('cancels the response body after a valid DONE event', async () => {
    let canceled = false;
    const payload = [
      `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    for await (const _event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '请求'}],
    }, new AbortController().signal)) {
      // Consume the response through its DONE event.
    }

    expect(canceled).toBe(true);
  });

  it('cancels the response body after a JSON parse error', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: not-json\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    await expect((async () => {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // Malformed JSON must not yield model events.
      }
    })()).rejects.toBeInstanceOf(ModelProviderError);

    expect(canceled).toBe(true);
  });

  it('cancels the response body after a protocol error', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    await expect((async () => {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '请求'}],
      }, new AbortController().signal)) {
        // DONE before finish_reason must not yield model events.
      }
    })()).rejects.toBeInstanceOf(ModelProviderError);

    expect(canceled).toBe(true);
  });

  it('cancels the response body when the consumer stops early', async () => {
    let canceled = false;
    const payload =
      `data: ${JSON.stringify({choices: [{delta: {content: '第一段'}}]})}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    for await (const _event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '请求'}],
    }, new AbortController().signal)) {
      break;
    }

    expect(canceled).toBe(true);
  });

  it('does not cancel a response body that reaches natural EOF', async () => {
    let canceled = false;
    const payload =
      `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    for await (const _event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '请求'}],
    }, new AbortController().signal)) {
      // Consume through natural EOF.
    }

    expect(canceled).toBe(false);
  });

  it.each([502, 503, 504])('retries transient HTTP status %i', async (status) => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('temporary failure', {status})
        : sseResponse([
          {choices: [{delta: {}, finish_reason: 'stop'}]},
          '[DONE]',
        ]);
    }) as typeof fetch;
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl, sleep});
    const events: ModelEvent[] = [];

    for await (const event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '重试'}],
    }, new AbortController().signal)) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {type: 'finish', reason: 'stop', usage: undefined},
    ]);
  });

  it('uses an HTTP-date Retry-After value relative to the injected clock', async () => {
    const now = Date.parse('2026-07-25T00:00:00.000Z');
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('temporary failure', {
          status: 503,
          headers: {
            'retry-after': new Date(now + 3_000).toUTCString(),
          },
        });
      }
      return sseResponse([
        {choices: [{delta: {}, finish_reason: 'stop'}]},
        '[DONE]',
      ]);
    }) as typeof fetch;
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {
      fetch: fetchImpl,
      sleep,
      now: () => now,
    });

    for await (const _event of client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '重试'}],
    }, new AbortController().signal)) {
      // Consume the successful retry.
    }

    const [delay] = sleep.mock.calls[0] ?? [];
    expect(delay).toBe(3_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('aborts the default retry wait before issuing another request', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal;
      controller.abort();
      return new Response('rate limited', {
        status: 429,
        headers: {'retry-after': '0'},
      });
    }) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});

    const consume = async () => {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '取消'}],
      }, controller.signal)) {
        // An aborted request must not yield model events.
      }
    };

    await expect(consume()).rejects.toMatchObject({name: 'AbortError'});
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe(controller.signal.reason);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after an injected retry wait resolves', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response('rate limited', {
      status: 429,
      headers: {'retry-after': '0'},
    })) as typeof fetch;
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl, sleep});

    const consume = async () => {
      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '取消'}],
      }, controller.signal)) {
        // An aborted request must not yield model events.
      }
    };

    await expect(consume()).rejects.toMatchObject({name: 'AbortError'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops consuming an open response stream after cancellation', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({choices: [{delta: {content: '第一段'}}]})}\n\n`,
        ));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {
      status: 200,
      headers: {'content-type': 'text/event-stream'},
    })) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});
    const controller = new AbortController();
    const iterator = client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '取消'}],
    }, controller.signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {type: 'text_delta', text: '第一段'},
    });

    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({name: 'AbortError'});
  });

  it('cancels a response body when aborted during a pending read', async () => {
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        responseController = controller;
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({choices: [{delta: {content: '第一段'}}]})}\n\n`,
        ));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
    const client = createOpenAiCompatibleClient(parseConfig({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
    }), 'test-key', {fetch: fetchImpl});
    const controller = new AbortController();
    const iterator = client.stream({
      model: 'wolf-1',
      messages: [{role: 'user', content: '取消'}],
    }, controller.signal)[Symbol.asyncIterator]();
    await iterator.next();

    const pendingResult = iterator.next().then(
      () => ({kind: 'resolved' as const}),
      error => ({kind: 'rejected' as const, error}),
    );
    controller.abort();
    const outcome = await Promise.race([
      pendingResult,
      new Promise<{kind: 'timeout'}>(resolve => {
        setTimeout(() => resolve({kind: 'timeout'}), 20);
      }),
    ]);

    if (outcome.kind === 'timeout') {
      responseController?.error(new Error('test cleanup'));
      await pendingResult;
    }

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toMatchObject({name: 'AbortError'});
    }
    expect(cancelReason).toBe(controller.signal.reason);
  });

  it('times out a pending fetch with the configured timeout', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let transportSignal: AbortSignal | undefined;

    try {
      const fetchImpl = vi.fn((
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => new Promise<Response>((_resolve, reject) => {
        transportSignal = init?.signal ?? undefined;
        transportSignal?.addEventListener('abort', () => {
          reject(transportSignal?.reason);
        }, {once: true});
      })) as typeof fetch;
      const client = createOpenAiCompatibleClient(parseConfig({
        baseUrl: 'https://example.test/v1',
        model: 'wolf-1',
        timeoutMs: 1_000,
      }), 'test-key', {fetch: fetchImpl});
      const outcomePromise = (async () => {
        for await (const _event of client.stream({
          model: 'wolf-1',
          messages: [{role: 'user', content: '等待'}],
        }, caller.signal)) {
          // A pending fetch cannot produce model events.
        }
      })().then(
        () => ({kind: 'resolved' as const}),
        error => ({kind: 'rejected' as const, error}),
      );

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      const timedOut = transportSignal?.aborted ?? false;
      if (!timedOut) caller.abort();
      const outcome = await outcomePromise;

      expect(timedOut).toBe(true);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.error).toMatchObject({name: 'TimeoutError'});
      }
    } finally {
      caller.abort();
      vi.useRealTimers();
    }
  });

  it('times out and cancels a pending response-body read', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let cancelReason: unknown;

    try {
      const body = new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelReason = reason;
        },
      });
      const fetchImpl = vi.fn(async () => new Response(body, {status: 200})) as typeof fetch;
      const client = createOpenAiCompatibleClient(parseConfig({
        baseUrl: 'https://example.test/v1',
        model: 'wolf-1',
        timeoutMs: 1_000,
      }), 'test-key', {fetch: fetchImpl});
      const outcomePromise = (async () => {
        for await (const _event of client.stream({
          model: 'wolf-1',
          messages: [{role: 'user', content: '等待'}],
        }, caller.signal)) {
          // A pending response body cannot produce model events.
        }
      })().then(
        () => ({kind: 'resolved' as const}),
        error => ({kind: 'rejected' as const, error}),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const timedOut = cancelReason !== undefined;
      if (!timedOut) caller.abort();
      const outcome = await outcomePromise;

      expect(cancelReason).toMatchObject({name: 'TimeoutError'});
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.error).toMatchObject({name: 'TimeoutError'});
      }
    } finally {
      caller.abort();
      vi.useRealTimers();
    }
  });

  it('clears the configured timeout when streaming finishes', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();

    try {
      let timersDuringFetch: number | undefined;
      const fetchImpl = vi.fn(async () => {
        timersDuringFetch = vi.getTimerCount();
        return sseResponse([
          {choices: [{delta: {}, finish_reason: 'stop'}]},
          '[DONE]',
        ]);
      }) as typeof fetch;
      const client = createOpenAiCompatibleClient(parseConfig({
        baseUrl: 'https://example.test/v1',
        model: 'wolf-1',
        timeoutMs: 1_000,
      }), 'test-key', {fetch: fetchImpl});

      for await (const _event of client.stream({
        model: 'wolf-1',
        messages: [{role: 'user', content: '完成'}],
      }, caller.signal)) {
        // Consume the complete response.
      }

      expect(timersDuringFetch).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      caller.abort();
      vi.useRealTimers();
    }
  });
});

describe('scripted model test helper', () => {
  it('builds complete text and tool-call responses', () => {
    expect(textResponse('完成')).toEqual([
      {type: 'text_delta', text: '完成'},
      {type: 'finish', reason: 'stop', usage: undefined},
    ]);
    expect(toolResponse([{
      id: 'call_1',
      name: 'read_file',
      arguments: {path: 'README.md'},
    }])).toEqual([
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      {type: 'finish', reason: 'tool_calls', usage: undefined},
    ]);
  });

  it('pops responses in order and fails clearly when exhausted', async () => {
    const client = scriptedModel([
      textResponse('第一条'),
      textResponse('第二条'),
    ]);
    const request = {
      model: 'scripted',
      messages: [{role: 'user' as const, content: '继续'}],
    };
    const signal = new AbortController().signal;
    const collect = async () => {
      const events: ModelEvent[] = [];
      for await (const event of client.stream(request, signal)) events.push(event);
      return events;
    };

    await expect(collect()).resolves.toEqual(textResponse('第一条'));
    await expect(collect()).resolves.toEqual(textResponse('第二条'));
    await expect(collect()).rejects.toThrow('Scripted model responses exhausted');
  });
});
