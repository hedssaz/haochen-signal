import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
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
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  applyPatch,
  listFiles,
  readFileTool,
  searchText,
} from '../../src/tools/files.js';
import type {ToolContext} from '../../src/tools/types.js';

const signal = AbortSignal.timeout(10_000);

describe('workspace file tools', () => {
  let tempDirectory: string;
  let workspace: string;
  let context: ToolContext;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'haochen-file-tools-'));
    workspace = join(tempDirectory, 'workspace');
    await mkdir(workspace);
    context = {
      workspace,
      tempDir: join(tempDirectory, 'tool-output'),
    };
  });

  afterEach(async () => {
    await rm(tempDirectory, {recursive: true, force: true});
  });

  it('lists regular files in stable order and excludes .git and node_modules', async () => {
    await mkdir(join(workspace, 'src'));
    await mkdir(join(workspace, '.git'));
    await mkdir(join(workspace, 'node_modules', 'package'), {recursive: true});
    await writeFile(join(workspace, 'B.txt'), 'B');
    await writeFile(join(workspace, 'a.txt'), 'a');
    await writeFile(join(workspace, 'z.txt'), 'z');
    await writeFile(join(workspace, 'src', 'a.txt'), 'a');
    await writeFile(join(workspace, '.git', 'config'), 'secret');
    await writeFile(join(workspace, 'node_modules', 'package', 'index.js'), 'ignored');

    const result = await listFiles({}, context, signal);
    const explicitGit = await listFiles({path: '.git'}, context, signal);
    const explicitDependency = await listFiles({
      path: 'node_modules/package/index.js',
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {files: ['B.txt', 'a.txt', 'src/a.txt', 'z.txt']},
    });
    expect(explicitGit.data?.files).toEqual([]);
    expect(explicitDependency.data?.files).toEqual([]);
  });

  it('searches text with one-based locations and skips binary and oversized files', async () => {
    await writeFile(
      join(workspace, 'readme.txt'),
      'alpha\nfind this and find this again\nomega\n',
    );
    await writeFile(
      join(workspace, 'binary.dat'),
      Buffer.from([0x66, 0x69, 0x6e, 0x64, 0, 0x74, 0x68, 0x69, 0x73]),
    );
    await writeFile(
      join(workspace, 'invalid-utf8.dat'),
      Buffer.from([0xff, 0x66, 0x69, 0x6e, 0x64]),
    );
    await writeFile(
      join(workspace, 'oversized.txt'),
      Buffer.alloc(2 * 1024 * 1024 + 1, 'f'),
    );

    const result = await searchText({query: 'find'}, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            path: 'readme.txt',
            line: 2,
            column: 1,
            preview: 'find this and find this again',
          },
          {
            path: 'readme.txt',
            line: 2,
            column: 15,
            preview: 'find this and find this again',
          },
        ],
      },
    });
  });

  it('returns at most 200 search matches', async () => {
    await writeFile(
      join(workspace, 'many.txt'),
      Array.from({length: 201}, () => 'match').join('\n'),
    );

    const result = await searchText({query: 'match'}, context, signal);

    expect(result.data?.matches).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('reads an inclusive line range and limits the default response to 400 lines', async () => {
    await writeFile(
      join(workspace, 'lines.txt'),
      Array.from({length: 405}, (_, index) => `line-${index + 1}`).join('\n'),
    );

    const range = await readFileTool({
      path: 'lines.txt',
      startLine: 2,
      endLine: 3,
    }, context, signal);
    const limited = await readFileTool({path: 'lines.txt'}, context, signal);

    expect(range).toMatchObject({
      ok: true,
      data: {
        path: 'lines.txt',
        content: 'line-2\nline-3',
        startLine: 2,
        endLine: 3,
        totalLines: 405,
      },
    });
    expect(limited.data?.content.split('\n')).toHaveLength(400);
    expect(limited.truncated).toBe(true);
  });

  it('requires update expected text to appear exactly once', async () => {
    await writeFile(join(workspace, 'repeat.txt'), 'same same');

    const result = await applyPatch({
      operations: [{
        type: 'update',
        path: 'repeat.txt',
        expected: 'same',
        replacement: 'changed',
      }],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'EXPECTED_NOT_UNIQUE'},
    });
    await expect(readFile(join(workspace, 'repeat.txt'), 'utf8')).resolves.toBe(
      'same same',
    );
  });

  it('validates every patch operation before changing any file', async () => {
    await writeFile(join(workspace, 'first.txt'), 'before');
    await writeFile(join(workspace, 'exists.txt'), 'keep');

    const result = await applyPatch({
      operations: [
        {
          type: 'update',
          path: 'first.txt',
          expected: 'before',
          replacement: 'after',
        },
        {type: 'add', path: 'exists.txt', content: 'overwrite'},
      ],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_EXISTS'},
    });
    await expect(readFile(join(workspace, 'first.txt'), 'utf8')).resolves.toBe(
      'before',
    );
    await expect(readFile(join(workspace, 'exists.txt'), 'utf8')).resolves.toBe(
      'keep',
    );
  });

  it('does not overwrite an existing file with add', async () => {
    await writeFile(join(workspace, 'exists.txt'), 'original');

    const result = await applyPatch({
      operations: [{type: 'add', path: 'exists.txt', content: 'replacement'}],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_EXISTS'},
    });
    await expect(readFile(join(workspace, 'exists.txt'), 'utf8')).resolves.toBe(
      'original',
    );
  });

  it('rejects invalid add content before creating the file', async () => {
    const result = await applyPatch({
      operations: [{
        type: 'add',
        path: 'invalid.txt',
        content: 42,
      } as unknown as {
        type: 'add';
        path: string;
        content: string;
      }],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'INVALID_INPUT'},
    });
    await expect(
      readFile(join(workspace, 'invalid.txt'), 'utf8'),
    ).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('adds a new file and reports its line counts', async () => {
    const result = await applyPatch({
      operations: [{
        type: 'add',
        path: 'new.txt',
        content: 'first\nsecond\n',
      }],
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        changes: [{
          path: 'new.txt',
          type: 'add',
          additions: 2,
          deletions: 0,
        }],
      },
    });
    await expect(readFile(join(workspace, 'new.txt'), 'utf8')).resolves.toBe(
      'first\nsecond\n',
    );
  });

  it('updates one exact fragment and reports its line counts', async () => {
    await writeFile(join(workspace, 'update.txt'), 'header\nbefore\nfooter\n');

    const result = await applyPatch({
      operations: [{
        type: 'update',
        path: 'update.txt',
        expected: 'before',
        replacement: 'after\nmore',
      }],
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        changes: [{
          path: 'update.txt',
          type: 'update',
          additions: 2,
          deletions: 1,
        }],
      },
    });
    await expect(readFile(join(workspace, 'update.txt'), 'utf8')).resolves.toBe(
      'header\nafter\nmore\nfooter\n',
    );
  });

  it('rechecks update contents immediately before writing', async () => {
    const path = join(workspace, 'racing-update.txt');
    await writeFile(path, 'before');
    let replacementReads = 0;
    const racingOperation = {
      type: 'update' as const,
      path: 'racing-update.txt',
      expected: 'before',
      get replacement(): string {
        replacementReads += 1;
        if (replacementReads === 2) writeFileSync(path, 'raced');
        return 'after';
      },
    };

    const result = await applyPatch({
      operations: [racingOperation],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_CHANGED'},
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('raced');
  });

  it('deletes only when the current SHA-256 matches', async () => {
    const path = join(workspace, 'delete.txt');
    await writeFile(path, 'original');
    const originalSha = createHash('sha256').update('original').digest('hex');
    await writeFile(path, 'changed');

    const changed = await applyPatch({
      operations: [{type: 'delete', path: 'delete.txt', sha256: originalSha}],
    }, context, signal);
    expect(changed).toMatchObject({
      ok: false,
      error: {code: 'SHA256_MISMATCH'},
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('changed');

    const currentSha = createHash('sha256').update('changed').digest('hex');
    const deleted = await applyPatch({
      operations: [{type: 'delete', path: 'delete.txt', sha256: currentSha}],
    }, context, signal);
    expect(deleted).toMatchObject({
      ok: true,
      data: {
        changes: [{
          path: 'delete.txt',
          type: 'delete',
          additions: 0,
          deletions: 1,
        }],
      },
    });
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects patch paths that use a symlink without changing the target', async () => {
    const outside = join(tempDirectory, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(workspace, 'linked.txt'));

    const result = await applyPatch({
      operations: [{
        type: 'update',
        path: 'linked.txt',
        expected: 'outside',
        replacement: 'changed',
      }],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'PATH_BOUNDARY'},
    });
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside');
  });
});
