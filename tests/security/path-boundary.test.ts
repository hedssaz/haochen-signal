import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  resolveWorkspacePath,
  toPortableRelativePath,
} from '../../src/security/path-boundary.js';

describe('resolveWorkspacePath', () => {
  let tempDirectory: string;
  let root: string;
  let outsideFile: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'haochen-path-boundary-'));
    root = join(tempDirectory, 'workspace');
    outsideFile = join(tempDirectory, 'secret.txt');
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(outsideFile, 'secret');
  });

  afterEach(async () => {
    await rm(tempDirectory, {recursive: true, force: true});
  });

  it('rejects traversal and a symlink escape', async () => {
    await expect(
      resolveWorkspacePath(root, '../secret.txt', 'existing'),
    ).rejects.toThrow('工作区外');

    await symlink(outsideFile, join(root, 'linked-secret'));
    await expect(
      resolveWorkspacePath(root, 'linked-secret', 'existing'),
    ).rejects.toThrow('符号链接');
  });

  it('allows a new file only when its real parent stays inside the workspace', async () => {
    const realRoot = await realpath(root);

    await expect(
      resolveWorkspacePath(root, 'src/new.ts', 'new'),
    ).resolves.toMatchObject({
      absolute: join(realRoot, 'src/new.ts'),
      relative: join('src', 'new.ts'),
    });

    await symlink(tempDirectory, join(root, 'outside-parent'));
    await expect(
      resolveWorkspacePath(root, 'outside-parent/new.ts', 'new'),
    ).rejects.toThrow('符号链接');
  });
});

describe('toPortableRelativePath', () => {
  it('normalizes only the active platform separator', () => {
    expect(toPortableRelativePath('src\\nested\\new.ts', '\\')).toBe(
      'src/nested/new.ts',
    );
    expect(toPortableRelativePath('src\\literal.ts', '/')).toBe(
      'src\\literal.ts',
    );
  });
});
