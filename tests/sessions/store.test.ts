import {appendFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {createSessionId, SessionStore} from '../../src/sessions/store.js';

it('creates unique UUID session IDs', () => {
  const first = createSessionId();
  const second = createSessionId();

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(second).not.toBe(first);
});

it('restores complete events and ignores a truncated final line', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await store.append('session-1', {type: 'user', at: 1, text: '修复测试'});
    await appendFile(store.pathFor('session-1'), '{"type":"broken"');

    await expect(store.read('session-1')).resolves.toEqual([
      {type: 'user', at: 1, text: '修复测试'},
    ]);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('redacts each event before appending one newline-terminated JSON record', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const event = {
    type: 'tool' as const,
    at: 2,
    tool: 'run_command',
    input: {authorization: 'Bearer session-secret'},
    result: 'used sk-test-1234567890',
  };

  try {
    await store.append('session-1', event);
    const contents = await readFile(store.pathFor('session-1'), 'utf8');

    expect(contents).toBe(
      `${JSON.stringify({
        ...event,
        input: {authorization: '[REDACTED]'},
        result: 'used [REDACTED]',
      })}\n`,
    );
    expect(event.input.authorization).toBe('Bearer session-secret');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('reports the line number for malformed complete records', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(
      store.pathFor('middle-broken'),
      '{"type":"user","at":1,"text":"ok"}\n{"type":broken}\n{"type":"summary","at":3,"text":"ok"}\n',
    );
    await expect(store.read('middle-broken')).rejects.toThrow(/line 2/i);

    await writeFile(
      store.pathFor('final-complete-broken'),
      '{"type":"user","at":1,"text":"ok"}\n{"type":broken}\n',
    );
    await expect(store.read('final-complete-broken')).rejects.toThrow(/line 2/i);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('reads a valid final record without a newline but rejects non-truncated corruption', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(
      store.pathFor('valid-no-newline'),
      '{"type":"user","at":1,"text":"完整"}',
    );
    await expect(store.read('valid-no-newline')).resolves.toEqual([
      {type: 'user', at: 1, text: '完整'},
    ]);

    await writeFile(
      store.pathFor('invalid-no-newline'),
      '{"type":broken}',
    );
    await expect(store.read('invalid-no-newline')).rejects.toThrow(/line 1/i);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('lists sessions by their final event time in descending order', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await store.append('session-a', {type: 'user', at: 100, text: 'first'});
    await store.append('session-a', {type: 'assistant', at: 10, text: 'last'});
    await store.append('session-b', {type: 'summary', at: 50, text: 'last'});

    await expect(store.list()).resolves.toEqual([
      {id: 'session-b', updatedAt: 50},
      {id: 'session-a', updatedAt: 10},
    ]);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
