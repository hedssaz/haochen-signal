import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {jsonPrefixStatus} from '../../src/sessions/json-prefix.js';
import {createSessionId, SessionStore} from '../../src/sessions/store.js';

it('creates unique UUID session IDs', () => {
  const first = createSessionId();
  const second = createSessionId();

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(second).not.toBe(first);
});

it('keeps safe session IDs inside the store and rejects unsafe IDs', () => {
  const store = new SessionStore('/tmp/haochen-session-root');

  expect(store.pathFor('session-1')).toBe(
    '/tmp/haochen-session-root/session-1.jsonl',
  );
  for (const id of ['', '.', '..', '../escape', 'nested/id', 'nested\\id', '/tmp/escape']) {
    expect(() => store.pathFor(id)).toThrow(/invalid session id/i);
  }
});

it('rejects a session file symlink that escapes the store root', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const root = join(tempDir, 'store');
  const victim = join(tempDir, 'victim.jsonl');
  const store = new SessionStore(root);

  try {
    await mkdir(root);
    await writeFile(victim, 'do-not-change');
    await symlink(victim, join(root, 'session-link.jsonl'));

    expect(() => store.pathFor('session-link')).toThrow(/invalid session id/i);
    await expect(store.append(
      'session-link',
      {type: 'user', at: 1, text: 'must-not-append'},
    )).rejects.toThrow(/invalid session id/i);
    await expect(readFile(victim, 'utf8')).resolves.toBe('do-not-change');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('reads an empty session and appends its first event', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(store.pathFor('empty-session'), '');

    await expect(store.read('empty-session')).resolves.toEqual([]);

    await store.append(
      'empty-session',
      {type: 'user', at: 1, text: 'first'},
    );
    await expect(store.read('empty-session')).resolves.toEqual([
      {type: 'user', at: 1, text: 'first'},
    ]);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('lists an empty session with a stable zero update time', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(store.pathFor('empty-session'), '');
    await store.append(
      'active-session',
      {type: 'user', at: 1, text: 'active'},
    );

    await expect(store.list()).resolves.toEqual([
      {id: 'active-session', updatedAt: 1, preview: 'active'},
      {id: 'empty-session', updatedAt: 0, preview: '空白会话'},
    ]);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('initializes workspace metadata and lists safe conversation previews', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const currentWorkspace = 'a'.repeat(64);
  const otherWorkspace = 'b'.repeat(64);

  try {
    await store.initialize('current', currentWorkspace, 1);
    await store.append('current', {
      type: 'user',
      at: 3,
      text: `  ${'修复登录问题'.repeat(20)}  `,
    });
    await store.initialize('other', otherWorkspace, 2);
    await store.append('legacy', {type: 'user', at: 4, text: '旧版会话'});

    const sessions = await store.list();

    expect(sessions.find(session => session.id === 'current')).toMatchObject({
      workspaceId: currentWorkspace,
      updatedAt: 3,
      preview: expect.stringMatching(/^修复登录问题/),
    });
    expect(Array.from(sessions.find(session => session.id === 'current')!.preview))
      .toHaveLength(80);
    expect(sessions.find(session => session.id === 'other')).toMatchObject({
      workspaceId: otherWorkspace,
      preview: '空白会话',
    });
    expect(sessions.find(session => session.id === 'legacy')).toEqual({
      id: 'legacy',
      updatedAt: 4,
      preview: '旧版会话',
    });
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('keeps workspace initialization idempotent and rejects conflicting metadata', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const currentWorkspace = 'a'.repeat(64);

  try {
    await store.initialize('session-1', currentWorkspace, 1);
    await store.initialize('session-1', currentWorkspace, 2);

    await expect(store.read('session-1')).resolves.toEqual([
      {type: 'session_meta', at: 1, workspaceId: currentWorkspace},
    ]);
    await expect(
      store.initialize('session-1', 'b'.repeat(64), 3),
    ).rejects.toThrow(/workspace/i);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
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

it('removes a structurally truncated final line before appending', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await store.append('session-1', {type: 'user', at: 1, text: 'first'});
    await appendFile(
      store.pathFor('session-1'),
      '{"type":"assistant","at":2,"text":"unfinished \\" } ]',
    );

    await store.append('session-1', {type: 'assistant', at: 3, text: 'recovered'});

    await expect(store.read('session-1')).resolves.toEqual([
      {type: 'user', at: 1, text: 'first'},
      {type: 'assistant', at: 3, text: 'recovered'},
    ]);
    expect(await readFile(store.pathFor('session-1'), 'utf8')).not.toContain('unfinished');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('preserves a complete final JSON record without a newline before appending', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(
      store.pathFor('session-1'),
      '{"type":"user","at":1,"text":"first"}',
    );

    await store.append('session-1', {type: 'assistant', at: 2, text: 'second'});

    await expect(store.read('session-1')).resolves.toEqual([
      {type: 'user', at: 1, text: 'first'},
      {type: 'assistant', at: 2, text: 'second'},
    ]);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('rejects balanced invalid final JSON without changing the file', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const contents =
    '{"type":"user","at":1,"text":"first"}\n{"type":"assistant","at":2,}';

  try {
    await writeFile(store.pathFor('session-1'), contents);

    await expect(store.append(
      'session-1',
      {type: 'assistant', at: 3, text: 'must-not-append'},
    )).rejects.toThrow(/line 2/i);
    await expect(readFile(store.pathFor('session-1'), 'utf8')).resolves.toBe(contents);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('rejects an invalid string escape instead of treating it as truncation', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const contents =
    '{"type":"user","at":1,"text":"first"}\n{"type":"assistant","at":2,"text":"bad\\q';

  try {
    await writeFile(store.pathFor('session-1'), contents);

    await expect(store.append(
      'session-1',
      {type: 'assistant', at: 3, text: 'must-not-append'},
    )).rejects.toThrow(/line 2/i);
    await expect(readFile(store.pathFor('session-1'), 'utf8')).resolves.toBe(contents);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('rejects a trailing fragment after a complete JSON value', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const contents =
    '{"type":"user","at":1,"text":"first"}\n'
    + '{"type":"assistant","at":2,"text":"complete"}{"type":';

  try {
    await writeFile(store.pathFor('session-1'), contents);

    await expect(store.append(
      'session-1',
      {type: 'assistant', at: 3, text: 'must-not-append'},
    )).rejects.toThrow(/line 2/i);
    await expect(readFile(store.pathFor('session-1'), 'utf8')).resolves.toBe(contents);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it.each([
  '{"type":oops',
  '{"type":"assistant",???',
])('rejects a final line that is not a valid JSON prefix: %s', async (invalidPrefix) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const contents = `{"type":"user","at":1,"text":"first"}\n${invalidPrefix}`;

  try {
    await writeFile(store.pathFor('session-1'), contents);

    await expect(store.append(
      'session-1',
      {type: 'assistant', at: 3, text: 'must-not-append'},
    )).rejects.toThrow(/line 2/i);
    await expect(readFile(store.pathFor('session-1'), 'utf8')).resolves.toBe(contents);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it.each([
  ['NBSP', '\u00a0'],
  ['vertical tab', '\u000b'],
  ['form feed', '\u000c'],
  ['BOM', '\ufeff'],
  ['line separator', '\u2028'],
])('rejects non-JSON whitespace in a final line: %s', async (_name, whitespace) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);
  const contents = `{"type"${whitespace}:`;

  try {
    await writeFile(store.pathFor('session-1'), contents);

    expect(jsonPrefixStatus(contents)).toBe('invalid');
    await expect(store.read('session-1')).rejects.toThrow(/line 1/i);
    await expect(store.append(
      'session-1',
      {type: 'assistant', at: 2, text: 'must-not-append'},
    )).rejects.toThrow(/line 1/i);
    await expect(readFile(store.pathFor('session-1'), 'utf8')).resolves.toBe(contents);
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

it.each([
  ['empty object', '{}'],
  ['scalar', '42'],
  ['invalid timestamp', '{"type":"user","at":"1","text":"wrong"}'],
  ['missing field', '{"type":"assistant","at":1}'],
  ['unknown field', '{"type":"summary","at":1,"text":"ok","extra":true}'],
])('rejects a structurally invalid session event: %s', async (_name, invalidEvent) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(
      store.pathFor('invalid-event'),
      `{"type":"user","at":1,"text":"valid"}\n${invalidEvent}\n`,
    );

    await expect(store.read('invalid-event')).rejects.toThrow(/line 2/i);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('validates session event structure while listing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-sessions-'));
  const store = new SessionStore(tempDir);

  try {
    await writeFile(
      store.pathFor('invalid-event'),
      '{"type":"user","at":1,"text":"valid"}\n{}\n',
    );

    await expect(store.list()).rejects.toThrow(/line 2/i);
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
      {id: 'session-b', updatedAt: 50, preview: '空白会话'},
      {id: 'session-a', updatedAt: 10, preview: 'first'},
    ]);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
