import {expect, it} from 'vitest';
import {decodeSse} from '../../src/providers/sse.js';

it('decodes split SSE frames and ignores comments', async () => {
  const chunks = ['data: {"a":', '1}\n\n: ping\n\ndata: [DONE]\n\n'];
  const events: string[] = [];

  for await (const event of decodeSse(chunks)) events.push(event);

  expect(events).toEqual(['{"a":1}', '[DONE]']);
});

it('preserves UTF-8 code points split across byte chunks', async () => {
  const encoded = new TextEncoder().encode('data: 狼\n\n');
  const chunks = [encoded.slice(0, 7), encoded.slice(7)];
  const events: string[] = [];

  for await (const event of decodeSse(chunks)) events.push(event);

  expect(events).toEqual(['狼']);
});

it('joins multiple data lines and ignores non-data fields', async () => {
  const chunks = ['event: message\ndata: first\ndata: second\nid: 7\n\n'];
  const events: string[] = [];

  for await (const event of decodeSse(chunks)) events.push(event);

  expect(events).toEqual(['first\nsecond']);
});

it('emits the final frame when the stream ends without an empty line', async () => {
  const events: string[] = [];

  for await (const event of decodeSse(['data: tail'])) events.push(event);

  expect(events).toEqual(['tail']);
});

it('recognizes CRLF empty-line frame boundaries', async () => {
  const events: string[] = [];

  for await (const event of decodeSse(['data: one\r\n\r\ndata: two\r\n\r\n'])) {
    events.push(event);
  }

  expect(events).toEqual(['one', 'two']);
});

it('recognizes CR-only empty-line frame boundaries', async () => {
  const events: string[] = [];

  for await (const event of decodeSse(['data: one\r\rdata: two\r\r'])) {
    events.push(event);
  }

  expect(events).toEqual(['one', 'two']);
});
