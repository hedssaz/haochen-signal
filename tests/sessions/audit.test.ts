import {mkdtemp, readFile, rm} from 'node:fs/promises';
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
