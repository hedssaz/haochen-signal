import {createHash} from 'node:crypto';
import {readdirSync, statSync, writeFileSync} from 'node:fs';
import {
  chmod,
  link as linkFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  stat,
  symlink,
  unlink as unlinkFile,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  applyPatch,
  hasExcludedDirectory,
  listFiles,
  readFileTool,
  searchText,
  writeFile as writeFileTool,
} from '../../src/tools/files.js';
import type {PatchFileOperations} from '../../src/tools/files.js';
import type {ToolContext} from '../../src/tools/types.js';

const signal = AbortSignal.timeout(10_000);

async function expectPosixMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  expect((await stat(path)).mode & 0o777).toBe(mode);
}

describe('hasExcludedDirectory', () => {
  it('recognizes excluded directory segments with Windows separators', () => {
    expect(hasExcludedDirectory('node_modules\\package\\index.js', '\\')).toBe(
      true,
    );
    expect(hasExcludedDirectory('.git\\config', '\\')).toBe(true);
    expect(hasExcludedDirectory('src\\index.ts', '\\')).toBe(false);
  });
});

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
      data: {files: ['B.txt', 'a.txt', 'z.txt', 'src/a.txt']},
    });
    expect(explicitGit.data?.files).toEqual([]);
    expect(explicitDependency.data?.files).toEqual([]);
  });

  it('bounds recursive file listings and marks truncated results', async () => {
    await Promise.all(Array.from({length: 501}, (_, index) =>
      writeFile(join(workspace, `${String(index).padStart(3, '0')}.txt`), 'x'),
    ));

    const result = await listFiles({}, context, signal);

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.data?.files).toHaveLength(500);
    expect(result.summary).toContain('已截断');
  }, 15_000);

  it('does not mark a listing of exactly 500 files as truncated', async () => {
    await Promise.all(Array.from({length: 500}, (_, index) =>
      writeFile(join(workspace, `${String(index).padStart(3, '0')}.txt`), 'x'),
    ));

    const result = await listFiles({}, context, signal);

    expect(result.ok).toBe(true);
    expect(result.truncated).toBeUndefined();
    expect(result.data?.files).toHaveLength(500);
  });

  it('keeps shallow files when deep files exceed the listing limit', async () => {
    await mkdir(join(workspace, 'deep', 'nested'), {recursive: true});
    await writeFile(join(workspace, 'z-root.txt'), 'root');
    await Promise.all(Array.from({length: 500}, (_, index) =>
      writeFile(
        join(
          workspace,
          'deep',
          'nested',
          `${String(index).padStart(3, '0')}.txt`,
        ),
        'x',
      ),
    ));

    const result = await listFiles({}, context, signal);

    expect(result.truncated).toBe(true);
    expect(result.data?.files).toHaveLength(500);
    expect(result.data?.files[0]).toBe('z-root.txt');
  });

  it('orders files at the same depth by complete relative path', async () => {
    await mkdir(join(workspace, 'b'));
    await mkdir(join(workspace, 'a'));
    await writeFile(join(workspace, 'b', 'a.txt'), 'b');
    await writeFile(join(workspace, 'a', 'z.txt'), 'a');

    const result = await listFiles({}, context, signal);

    expect(result.data?.files).toEqual(['a/z.txt', 'b/a.txt']);
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

  it('bounds every search preview around its match', async () => {
    const longLine = `${'x'.repeat(500)}match${'y'.repeat(500)}`;
    await writeFile(
      join(workspace, 'long-matches.txt'),
      Array.from({length: 201}, () => longLine).join('\n'),
    );

    const result = await searchText({query: 'match'}, context, signal);

    expect(result.data?.matches).toHaveLength(200);
    for (const match of result.data?.matches ?? []) {
      expect(match.preview.length).toBeLessThanOrEqual(240);
      expect(match.preview).toContain('match');
      expect(match.preview.startsWith('…')).toBe(true);
      expect(match.preview.endsWith('…')).toBe(true);
      expect(match.column).toBe(501);
    }
    expect(JSON.stringify(result.data).length).toBeLessThan(70_000);
  });

  it('uses the shared CR, CRLF and LF line semantics for search', async () => {
    await writeFile(
      join(workspace, 'mixed-search.txt'),
      'first\rneedle\r\nlast\n',
    );

    const result = await searchText({query: 'needle'}, context, signal);

    expect(result.data?.matches).toEqual([{
      path: 'mixed-search.txt',
      line: 2,
      column: 1,
      preview: 'needle',
    }]);
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

  it('rejects a huge line at the read byte limit without returning its contents', async () => {
    await writeFile(
      join(workspace, 'huge-line.txt'),
      Buffer.alloc(2 * 1024 * 1024 + 1, 'x'),
    );

    const result = await readFileTool({
      path: 'huge-line.txt',
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'READ_LIMIT_EXCEEDED'},
    });
    expect(result.data).toBeUndefined();
  });

  it('paginates a long single line by Unicode code points', async () => {
    const text = `${'x'.repeat(65_535)}😀${'y'.repeat(5_000)}`;
    await writeFile(join(workspace, 'one-line.html'), text);

    const first = await readFileTool({
      path: 'one-line.html',
    }, context, signal);
    const second = await readFileTool({
      path: 'one-line.html',
      startCharacter: first.data!.nextCharacter,
    }, context, signal);

    expect(first.ok).toBe(true);
    expect(first.data!.content).not.toContain('\uFFFD');
    expect(Array.from(first.data!.content)).toHaveLength(65_536);
    expect(first.data).toMatchObject({
      startCharacter: 0,
      endCharacter: 65_536,
      totalCharacters: 70_536,
      nextCharacter: 65_536,
    });
    expect(second.data).toMatchObject({
      startCharacter: 65_536,
      endCharacter: 70_536,
      totalCharacters: 70_536,
    });
    expect(second.data!.nextCharacter).toBeUndefined();
    expect(first.data!.content + second.data!.content).toBe(text);
  });

  it('does not let an unselected long line affect a line-range request', async () => {
    await writeFile(
      join(workspace, 'unselected-long-line.txt'),
      `${'x'.repeat(65_537)}\nselected`,
    );

    const result = await readFileTool({
      path: 'unselected-long-line.txt',
      startLine: 2,
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: 'selected',
        startLine: 2,
        endLine: 2,
        totalLines: 2,
        startCharacter: 0,
        endCharacter: 8,
        totalCharacters: 8,
      },
      truncated: true,
    });
    expect(result.data!.nextCharacter).toBeUndefined();
  });

  it('returns consistent metadata for an empty file', async () => {
    await writeFile(join(workspace, 'empty.txt'), '');

    const result = await readFileTool({path: 'empty.txt'}, context, signal);

    expect(result).toEqual({
      ok: true,
      summary: '读取 empty.txt：空文件',
      data: {
        path: 'empty.txt',
        content: '',
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        startCharacter: 0,
        endCharacter: 0,
        totalCharacters: 0,
      },
      truncated: false,
    });
  });

  it('normalizes LF, CRLF and CR without a trailing phantom line', async () => {
    await writeFile(join(workspace, 'mixed-lines.txt'), 'one\rtwo\r\nthree\n');

    const result = await readFileTool({
      path: 'mixed-lines.txt',
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: 'one\ntwo\nthree',
        startLine: 1,
        endLine: 3,
        totalLines: 3,
      },
      truncated: false,
    });
  });

  it('recognizes CRLF split across read chunks as one line ending', async () => {
    await writeFile(
      join(workspace, 'chunk-boundary.txt'),
      `${'x'.repeat(64 * 1024 - 1)}\r\nsecond`,
    );

    const result = await readFileTool({
      path: 'chunk-boundary.txt',
      startLine: 2,
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: 'second',
        startLine: 2,
        endLine: 2,
        totalLines: 2,
      },
    });
  });

  it('does not count a deferred bare CR against the exact line limit', async () => {
    const line = 'x'.repeat(64 * 1024);
    await writeFile(join(workspace, 'bare-cr-limit.txt'), `${line}\r`);

    const result = await readFileTool({
      path: 'bare-cr-limit.txt',
    }, context, signal);

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: line,
        startLine: 1,
        endLine: 1,
        totalLines: 1,
      },
      truncated: false,
    });
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

  it('atomically creates a new UTF-8 file and reports its size', async () => {
    const content = '第一行\nsecond 😀\n';
    let targetWasHiddenUntilPublish = false;

    const result = await writeFileTool({
      path: 'created.txt',
      content,
    }, context, signal, {
      link: async (temporaryPath, targetPath) => {
        await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(temporaryPath, 'utf8')).resolves.toBe(content);
        targetWasHiddenUntilPublish = true;
        await linkFile(temporaryPath, targetPath);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: 'created.txt',
        additions: 2,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      },
    });
    expect(targetWasHiddenUntilPublish).toBe(true);
    await expect(readFile(join(workspace, 'created.txt'), 'utf8')).resolves.toBe(
      content,
    );
    await expect(readdir(workspace)).resolves.toEqual(['created.txt']);
  });

  it('refuses to overwrite an existing file with write_file', async () => {
    await writeFile(join(workspace, 'exists.txt'), 'original');

    const result = await writeFileTool({
      path: 'exists.txt',
      content: 'replacement',
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_EXISTS'},
    });
    await expect(readFile(join(workspace, 'exists.txt'), 'utf8')).resolves.toBe(
      'original',
    );
  });

  it('leaves no target or temp file when write_file sync fails', async () => {
    const result = await writeFileTool({
      path: 'atomic.txt',
      content: 'complete contents',
    }, context, signal, {
      sync: async () => {
        throw new Error('sync failed');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_OPERATION_FAILED'},
    });
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('does not create a file when write_file is already canceled', async () => {
    const controller = new AbortController();
    controller.abort('取消创建');

    const result = await writeFileTool({
      path: 'canceled.txt',
      content: 'must not be written',
    }, context, controller.signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'ABORTED'},
    });
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('removes the temp file when write_file is canceled before publish', async () => {
    const controller = new AbortController();
    const result = await writeFileTool({
      path: 'canceled-during-sync.txt',
      content: 'must not be published',
    }, context, controller.signal, {
      sync: async file => {
        await file.sync();
        controller.abort('同步后取消');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'ABORTED'},
    });
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('rechecks cancellation immediately after the final target validation', async () => {
    const controller = new AbortController();
    const cancelDuringFinalValidation: ToolContext = {
      tempDir: context.tempDir,
      get workspace() {
        if (readdirSync(workspace).some(name => (
          name.includes('.haochen-')
          && statSync(join(workspace, name)).size > 0
        ))) {
          controller.abort('最终目标复核期间取消');
        }
        return workspace;
      },
    };

    const result = await writeFileTool({
      path: 'last-moment-cancel.txt',
      content: 'must not be published',
    }, cancelDuringFinalValidation, controller.signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'ABORTED'},
    });
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('treats link publication as committed when canceled before link returns', async () => {
    const controller = new AbortController();
    let markPublished!: () => void;
    let releaseLink!: () => void;
    const published = new Promise<void>(resolve => { markPublished = resolve; });
    const linkGate = new Promise<void>(resolve => { releaseLink = resolve; });

    const running = writeFileTool({
      path: 'canceled-after-link.txt',
      content: 'must be rolled back',
    }, context, controller.signal, {
      link: async (temporaryPath, targetPath) => {
        await linkFile(temporaryPath, targetPath);
        markPublished();
        await linkGate;
      },
    });

    await published;
    controller.abort('link 发布后取消');
    releaseLink();
    const result = await running;

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: 'canceled-after-link.txt',
        bytesWritten: Buffer.byteLength('must be rolled back', 'utf8'),
      },
    });
    await expect(
      readFile(join(workspace, 'canceled-after-link.txt'), 'utf8'),
    ).resolves.toBe('must be rolled back');
    await expect(readdir(workspace)).resolves.toEqual([
      'canceled-after-link.txt',
    ]);
  });

  it('never attempts to unlink the published target after link starts', async () => {
    const controller = new AbortController();
    let targetPath = '';
    let targetUnlinkAttempts = 0;

    const result = await writeFileTool({
      path: 'committed-after-link.txt',
      content: 'tool contents',
    }, context, controller.signal, {
      link: async (temporaryPath, publishedPath) => {
        targetPath = publishedPath;
        await linkFile(temporaryPath, publishedPath);
        controller.abort('发布后取消');
      },
      unlink: async path => {
        if (path === targetPath) {
          targetUnlinkAttempts += 1;
          throw new Error('不得回滚已发布目标');
        }
        await unlinkFile(path);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {path: 'committed-after-link.txt'},
    });
    expect(targetUnlinkAttempts).toBe(0);
    await expect(
      readFile(join(workspace, 'committed-after-link.txt'), 'utf8'),
    ).resolves.toBe('tool contents');
    await expect(readdir(workspace)).resolves.toEqual([
      'committed-after-link.txt',
    ]);
  });

  it('rejects write_file traversal and symlink escapes', async () => {
    const outsideDirectory = join(tempDirectory, 'outside');
    await mkdir(outsideDirectory);
    const outsideTarget = join(outsideDirectory, 'target.txt');
    await writeFile(outsideTarget, 'outside');
    await symlink(outsideDirectory, join(workspace, 'linked-directory'));
    await symlink(outsideTarget, join(workspace, 'linked-target.txt'));

    for (const path of [
      '../outside/new.txt',
      'linked-directory/new.txt',
      'linked-target.txt',
    ]) {
      const result = await writeFileTool({
        path,
        content: 'must not escape',
      }, context, signal);

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'PATH_BOUNDARY'},
      });
    }
    await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('outside');
    await expect(readdir(outsideDirectory)).resolves.toEqual(['target.txt']);
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

  it.each(['write', 'truncate', 'sync', 'chmod', 'close', 'link'] as const)(
    'cleans a nested add temp file when %s fails',
    async (stage) => {
      const directory = join(workspace, 'nested');
      await mkdir(directory);
      const injected = (stage === 'close'
        ? {
            close: async (
              file: Parameters<PatchFileOperations['write']>[0],
            ) => {
              await file.close();
              throw new Error('close failed');
            },
          }
        : {
            [stage]: async () => {
              throw new Error(`${stage} failed`);
            },
          }) as Partial<PatchFileOperations>;

      const result = await applyPatch({
        operations: [{
          type: 'add',
          path: 'nested/new.txt',
          content: 'new contents',
        }],
      }, context, signal, injected);

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'FILE_OPERATION_FAILED'},
      });
      await expect(readdir(directory)).resolves.toEqual([]);
    },
  );

  it('reports add cleanup failure as a redacted warning after commit', async () => {
    const secret = 'sk-add-cleanup-secret-123456';
    let linkCalls = 0;
    let cleanupCalls = 0;
    const result = await applyPatch({
      operations: [{
        type: 'add',
        path: 'committed-add.txt',
        content: 'created',
      }],
    }, context, signal, {
      link: async (existingPath: string, newPath: string) => {
        linkCalls += 1;
        await linkFile(existingPath, newPath);
      },
      unlink: async () => {
        cleanupCalls += 1;
        throw `temp cleanup failed with ${secret}`;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [expect.stringContaining('[REDACTED]')],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(
      readFile(join(workspace, 'committed-add.txt'), 'utf8'),
    ).resolves.toBe('created');
    expect(linkCalls).toBe(1);
    expect(cleanupCalls).toBe(1);
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

  it.each(['write', 'truncate', 'sync', 'chmod', 'close', 'rename'] as const)(
    'preserves update target and cleans temp when %s fails',
    async (stage) => {
      const path = join(workspace, 'atomic-update.txt');
      const original = Buffer.from('before');
      await writeFile(path, original);
      await chmod(path, 0o640);
      const injected = (stage === 'close'
        ? {
            close: async (
              file: Parameters<PatchFileOperations['write']>[0],
            ) => {
              await file.close();
              throw new Error('close failed');
            },
          }
        : {
            [stage]: async () => {
              throw new Error(`${stage} failed`);
            },
          }) as Partial<PatchFileOperations>;

      const result = await applyPatch({
        operations: [{
          type: 'update',
          path: 'atomic-update.txt',
          expected: 'before',
          replacement: 'after',
        }],
      }, context, signal, injected);

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'FILE_OPERATION_FAILED'},
      });
      await expect(readFile(path)).resolves.toEqual(original);
      await expectPosixMode(path, 0o640);
      await expect(readdir(workspace)).resolves.toEqual(['atomic-update.txt']);
    },
  );

  it('reports an already committed rename error as a redacted warning', async () => {
    const path = join(workspace, 'committed-update.txt');
    const secret = 'sk-update-publish-secret-123456';
    let renameCalls = 0;
    await writeFile(path, 'before');

    const result = await applyPatch({
      operations: [{
        type: 'update',
        path: 'committed-update.txt',
        expected: 'before',
        replacement: 'after',
      }],
    }, context, signal, {
      rename: async (oldPath, newPath) => {
        renameCalls += 1;
        await renameFile(oldPath, newPath);
        throw `rename returned late error ${secret}`;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [expect.stringContaining('[REDACTED]')],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(readFile(path, 'utf8')).resolves.toBe('after');
    expect(renameCalls).toBe(1);
    await expect(readdir(workspace)).resolves.toEqual(['committed-update.txt']);
  });

  it.skipIf(process.platform === 'win32')(
    'atomically updates a file while preserving its mode',
    async () => {
      const path = join(workspace, 'mode-update.txt');
      await writeFile(path, 'before');
      await chmod(path, 0o640);

      const result = await applyPatch({
        operations: [{
          type: 'update',
          path: 'mode-update.txt',
          expected: 'before',
          replacement: 'after',
        }],
      }, context, signal);

      expect(result.ok).toBe(true);
      await expect(readFile(path, 'utf8')).resolves.toBe('after');
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      await expect(readdir(workspace)).resolves.toEqual(['mode-update.txt']);
    },
  );

  it('returns a ToolResult when a file operation throws null', async () => {
    const result = await applyPatch({
      operations: [{type: 'add', path: 'null-error.txt', content: 'contents'}],
    }, context, signal, {
      write: async () => {
        throw null;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_OPERATION_FAILED'},
    });
    expect(result.summary).toBeTypeOf('string');
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  it('redacts a non-Error thrown value from summary and error message', async () => {
    const path = join(workspace, 'redacted-error.txt');
    const secret = 'sk-test-secret-1234567890';
    await writeFile(path, 'before');

    const result = await applyPatch({
      operations: [{
        type: 'update',
        path: 'redacted-error.txt',
        expected: 'before',
        replacement: 'after',
      }],
    }, context, signal, {
      rename: async () => {
        throw `publication failed with ${secret}`;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'FILE_OPERATION_FAILED'},
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
    await expect(readFile(path, 'utf8')).resolves.toBe('before');
    await expect(readdir(workspace)).resolves.toEqual(['redacted-error.txt']);
  });

  it.each([
    ['null', null],
    ['sensitive string', 'authorization: Bearer abort-secret'],
  ])('returns a redacted ToolResult for %s abort reason', async (_name, reason) => {
    const controller = new AbortController();
    controller.abort(reason);

    const result = await listFiles({}, context, controller.signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'ABORTED'},
    });
    expect(JSON.stringify(result)).not.toContain('abort-secret');
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, ...Buffer.from('before')])],
    ['binary NUL', Buffer.from('before\0after')],
  ])('rejects %s update without rewriting bytes', async (_name, original) => {
    const path = join(workspace, 'binary-update.dat');
    await writeFile(path, original);

    const result = await applyPatch({
      operations: [{
        type: 'update',
        path: 'binary-update.dat',
        expected: 'before',
        replacement: 'changed',
      }],
    }, context, signal);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'BINARY_FILE'},
    });
    await expect(readFile(path)).resolves.toEqual(original);
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

  it('reports delete close failure as a redacted warning after commit', async () => {
    const path = join(workspace, 'committed-delete.txt');
    const secret = 'sk-delete-close-secret-123456';
    const currentSha = createHash('sha256').update('delete me').digest('hex');
    let deleteCalls = 0;
    let closeCalls = 0;
    await writeFile(path, 'delete me');

    const result = await applyPatch({
      operations: [{
        type: 'delete',
        path: 'committed-delete.txt',
        sha256: currentSha,
      }],
    }, context, signal, {
      unlink: async (targetPath: string) => {
        deleteCalls += 1;
        await unlinkFile(targetPath);
      },
      close: async (
        file: Parameters<PatchFileOperations['write']>[0],
      ) => {
        closeCalls += 1;
        await file.close();
        throw `close returned late error ${secret}`;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [expect.stringContaining('[REDACTED]')],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(deleteCalls).toBe(1);
    expect(closeCalls).toBe(1);
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
