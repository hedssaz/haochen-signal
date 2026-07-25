import {createServer} from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import type {AddressInfo} from 'node:net';

export interface MockOpenAiRequest {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface MockOpenAiResponse {
  status?: number;
  events: unknown[];
}

export interface MockToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface MockOpenAiServer {
  baseUrl: string;
  requests: MockOpenAiRequest[];
  close(): Promise<void>;
}

function completionChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl_mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [{index: 0, delta, finish_reason: finishReason}],
  };
}

export function mockToolCallResponse(
  call: MockToolCall,
): MockOpenAiResponse {
  const argumentsJson = JSON.stringify(call.arguments);
  const splitAt = Math.max(1, Math.floor(argumentsJson.length / 2));

  return {
    events: [
      completionChunk({
        tool_calls: [{
          index: 0,
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: argumentsJson.slice(0, splitAt),
          },
        }],
      }),
      completionChunk({
        tool_calls: [{
          index: 0,
          function: {arguments: argumentsJson.slice(splitAt)},
        }],
      }),
      completionChunk({}, 'tool_calls'),
      '[DONE]',
    ],
  };
}

export function mockTextResponse(text: string): MockOpenAiResponse {
  return {
    events: [
      completionChunk({content: text}),
      completionChunk({}, 'stop'),
      '[DONE]',
    ],
  };
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Mock OpenAI request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function writeScriptedResponse(
  response: ServerResponse,
  scripted: MockOpenAiResponse,
): void {
  response.writeHead(scripted.status ?? 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  });

  for (const event of scripted.events) {
    const data = typeof event === 'string' ? event : JSON.stringify(event);
    response.write(`data: ${data}\n\n`);
  }
  response.end();
}

export async function startMockOpenAiServer(
  responses: readonly MockOpenAiResponse[],
): Promise<MockOpenAiServer> {
  const queue = [...responses];
  const requests: MockOpenAiRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== 'POST'
        || request.url !== '/v1/chat/completions'
      ) {
        response.writeHead(404).end();
        return;
      }

      try {
        const body = await readJsonBody(request);
        requests.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          headers: {...request.headers},
          body,
        });
        const scripted = queue.shift();
        if (scripted === undefined) {
          response.writeHead(500, {'content-type': 'text/plain'});
          response.end('Mock OpenAI responses exhausted');
          return;
        }
        writeScriptedResponse(response, scripted);
      } catch (error) {
        response.writeHead(400, {'content-type': 'text/plain'});
        response.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
  };
}
