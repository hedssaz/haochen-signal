import {describe, expect, it} from 'vitest';
import {parseConfig} from '../../src/config/schema.js';
import {createOpenAiCompatibleClient} from '../../src/providers/openai-compatible.js';
import type {ModelEvent} from '../../src/providers/types.js';
import {
  mockTextResponse,
  mockToolCallResponse,
  startMockOpenAiServer,
} from '../fixtures/mock-openai-server.js';

describe('OpenAI-compatible 本地模拟服务器', () => {
  it('依次返回分片工具调用与文本，并保留收到的请求', async () => {
    const server = await startMockOpenAiServer([
      mockToolCallResponse({
        id: 'call_read',
        name: 'read_file',
        arguments: {path: 'src/example.ts'},
      }),
      mockTextResponse('任务完成'),
    ]);

    try {
      const client = createOpenAiCompatibleClient(parseConfig({
        baseUrl: server.baseUrl,
        model: 'signal-main',
      }), 'mock-api-key');
      const firstEvents: ModelEvent[] = [];
      const secondEvents: ModelEvent[] = [];

      for await (const event of client.stream({
        model: 'signal-main',
        messages: [{role: 'user', content: '读取文件'}],
      }, new AbortController().signal)) {
        firstEvents.push(event);
      }
      for await (const event of client.stream({
        model: 'signal-main',
        messages: [{role: 'user', content: '继续'}],
      }, new AbortController().signal)) {
        secondEvents.push(event);
      }

      expect(firstEvents).toEqual([
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_read',
          name: 'read_file',
          arguments: '{"path":"src/example.ts"}',
        },
        {type: 'finish', reason: 'tool_calls', usage: undefined},
      ]);
      expect(secondEvents).toEqual([
        {type: 'text_delta', text: '任务完成'},
        {type: 'finish', reason: 'stop', usage: undefined},
      ]);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]).toMatchObject({
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: 'Bearer mock-api-key',
        body: {
          model: 'signal-main',
          stream: true,
          messages: [{role: 'user', content: '读取文件'}],
        },
      });
    } finally {
      await server.close();
    }
  });
});
