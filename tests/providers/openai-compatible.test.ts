import {describe, expect, it, vi} from 'vitest';
import {parseConfig} from '../../src/config/schema.js';
import {
  createOpenAiCompatibleClient,
  ModelHttpError,
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
        '[DONE]',
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
    expect(sleep).toHaveBeenCalledWith(0, controller.signal);
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
    expect(receivedSignal).toBe(controller.signal);
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
