import {
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
import {AuditStore, workspaceId} from '../../src/sessions/audit.js';

it('derives stable workspace IDs from normalized absolute paths', () => {
  const originalPath = '/private/projects/haochen';
  const samePath = '/private/projects/./haochen/';
  const differentPath = '/private/projects/another';
  const id = workspaceId(originalPath);

  expect(id).toMatch(/^[0-9a-f]{64}$/);
  expect(workspaceId(samePath)).toBe(id);
  expect(workspaceId(differentPath)).not.toBe(id);
  expect(id).not.toContain(originalPath);
});

it('keeps safe workspace IDs inside the store and rejects unsafe IDs', () => {
  const store = new AuditStore('/tmp/haochen-audit-root');

  expect(store.pathFor('workspace-1')).toBe(
    '/tmp/haochen-audit-root/workspace-1.jsonl',
  );
  for (const id of ['', '.', '..', '../escape', 'nested/id', 'nested\\id', '/tmp/escape']) {
    expect(() => store.pathFor(id)).toThrow(/invalid workspace id/i);
  }
});

it('rejects an audit file symlink that escapes the store root', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-audit-'));
  const root = join(tempDir, 'store');
  const victim = join(tempDir, 'victim.jsonl');
  const store = new AuditStore(root);

  try {
    await mkdir(root);
    await writeFile(victim, 'do-not-change');
    await symlink(victim, join(root, 'workspace-link.jsonl'));

    expect(() => store.pathFor('workspace-link')).toThrow(/invalid workspace id/i);
    await expect(store.append('workspace-link', {
      at: 1,
      tool: 'run_command',
      input: {},
      decision: 'allow',
      result: 'must-not-append',
    })).rejects.toThrow(/invalid workspace id/i);
    await expect(readFile(victim, 'utf8')).resolves.toBe('do-not-change');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

it('redacts audit entries before writing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'haochen-audit-'));
  const store = new AuditStore(tempDir);

  try {
    await store.append('workspace-1', {
      at: 1,
      tool: 'run_command',
      input: {authorization: 'Bearer secret'},
      decision: 'allow',
      result: 'ok with ghp_1234567890abcdef',
    });
    const contents = await readFile(store.pathFor('workspace-1'), 'utf8');

    expect(contents).not.toContain('secret');
    expect(contents).not.toContain('ghp_');
    expect(contents.endsWith('\n')).toBe(true);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
