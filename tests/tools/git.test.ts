import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {gitDiff, gitLog, gitStatus} from '../../src/tools/git.js';
import type {ToolContext} from '../../src/tools/types.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
}

describe('read-only git tools', () => {
  let root: string;
  let workspace: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'haochen-git-tools-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    context = {
      workspace,
      tempDir: join(root, 'tool-output'),
    };
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  async function initializeRepository(): Promise<void> {
    await runGit(workspace, ['init', '--quiet']);
    await runGit(workspace, ['config', 'user.email', 'test@example.com']);
    await runGit(workspace, ['config', 'user.name', 'Test User']);
    await writeFile(join(workspace, 'file.txt'), 'initial\n');
    await runGit(workspace, ['add', 'file.txt']);
    await runGit(workspace, ['commit', '--quiet', '-m', 'initial commit']);
  }

  it('returns porcelain status for a modified file', async () => {
    await initializeRepository();
    await writeFile(join(workspace, 'file.txt'), 'initial\nchanged\n');

    const result = await gitStatus(context);

    expect(result).toMatchObject({ok: true});
    expect(result.data?.porcelain).toContain(' M file.txt');
  });

  it('returns unstaged or staged diff through the fixed input switch', async () => {
    await initializeRepository();
    await writeFile(join(workspace, 'file.txt'), 'initial\nchanged\n');

    const unstaged = await gitDiff({staged: false}, context);
    await runGit(workspace, ['add', 'file.txt']);
    const staged = await gitDiff({staged: true}, context);
    const nowUnstaged = await gitDiff({staged: false}, context);

    expect(unstaged.data?.text).toContain('+changed');
    expect(staged.data?.text).toContain('+changed');
    expect(nowUnstaged.data?.text).toBe('');
  });

  it('returns structured commits with a bounded limit', async () => {
    await initializeRepository();

    const result = await gitLog({limit: 1}, context);

    expect(result).toMatchObject({
      ok: true,
      data: {
        commits: [{
          author: 'Test User',
          subject: 'initial commit',
        }],
      },
    });
    expect(result.data?.commits).toHaveLength(1);
    expect(result.data?.commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.data?.commits[0]?.date).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it.each([0, 101, 1.5])(
    'rejects an out-of-range log limit: %s',
    async (limit) => {
      await initializeRepository();

      const result = await gitLog({limit}, context);

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'INVALID_INPUT'},
      });
    },
  );

  it('rejects a non-boolean staged selector', async () => {
    await initializeRepository();

    const result = await gitDiff({
      staged: '--no-index',
    } as unknown as {staged: boolean}, context);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'INVALID_INPUT'},
    });
  });

  it('returns a structured error outside a Git repository', async () => {
    const status = await gitStatus(context);
    const diff = await gitDiff({staged: false}, context);
    const log = await gitLog({limit: 1}, context);

    for (const result of [status, diff, log]) {
      expect(result).toMatchObject({
        ok: false,
        error: {code: 'NOT_A_GIT_REPOSITORY'},
      });
    }
  });

  it('detects a non-repository independently of the Git message locale', async () => {
    const previousLocale = process.env.LC_ALL;
    const previousLanguage = process.env.LANGUAGE;
    process.env.LC_ALL = 'zh_CN.UTF-8';
    process.env.LANGUAGE = 'zh_CN';

    try {
      const status = await gitStatus(context);
      const diff = await gitDiff({staged: false}, context);
      const log = await gitLog({limit: 1}, context);

      for (const result of [status, diff, log]) {
        expect(result).toMatchObject({
          ok: false,
          error: {code: 'NOT_A_GIT_REPOSITORY'},
        });
      }
    } finally {
      if (previousLocale === undefined) {
        delete process.env.LC_ALL;
      } else {
        process.env.LC_ALL = previousLocale;
      }
      if (previousLanguage === undefined) {
        delete process.env.LANGUAGE;
      } else {
        process.env.LANGUAGE = previousLanguage;
      }
    }
  });

  it('does not misclassify a repository with a damaged index', async () => {
    await initializeRepository();
    await writeFile(join(workspace, '.git', 'index'), 'damaged index');

    const result = await gitStatus(context);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'GIT_COMMAND_FAILED'},
    });
  });

  it('classifies from the same real workspace used as the Git cwd', async () => {
    await initializeRepository();
    const outside = join(root, 'outside');
    const linkedWorkspace = join(workspace, 'linked-workspace');
    await mkdir(outside);
    await symlink(outside, linkedWorkspace, 'dir');
    const linkedContext: ToolContext = {
      workspace: linkedWorkspace,
      tempDir: context.tempDir,
    };

    const result = await gitStatus(linkedContext);

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'NOT_A_GIT_REPOSITORY'},
    });
  });
});
