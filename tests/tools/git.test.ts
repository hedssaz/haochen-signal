import {execFile} from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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

  async function createHelper(
    name: string,
    markerPath: string,
  ): Promise<string> {
    const helperPath = join(root, name);
    await writeFile(helperPath, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(markerPath)}, "called");`,
      'const input = process.argv[2];',
      'if (input && fs.existsSync(input)) process.stdout.write(fs.readFileSync(input));',
    ].join('\n'));
    await chmod(helperPath, 0o755);
    return helperPath;
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

  it('parses commit subjects containing record and field control characters', async () => {
    await initializeRepository();
    const subject = 'control-\x1e-record-\x1f-field';
    await writeFile(join(workspace, 'file.txt'), 'initial\nsecond\n');
    await runGit(workspace, ['add', 'file.txt']);
    await runGit(workspace, ['commit', '--quiet', '-m', subject]);

    const result = await gitLog({limit: 1}, context);

    expect(result).toMatchObject({
      ok: true,
      data: {commits: [{subject}]},
    });
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

  it('sanitizes inherited Git environment and config scope', async () => {
    await initializeRepository();
    await writeFile(join(workspace, 'file.txt'), 'initial\nworkspace\n');
    const decoy = join(root, 'decoy');
    await mkdir(decoy);
    await runGit(decoy, ['init', '--quiet']);
    const marker = join(root, 'inherited-helper.marker');
    const helper = await createHelper('inherited-helper', marker);
    const hostileConfig = join(root, 'hostile.gitconfig');
    await writeFile(hostileConfig, [
      '[core]',
      `\tfsmonitor = ${helper}`,
      '[diff]',
      `\texternal = ${helper}`,
    ].join('\n'));
    const keys = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_EXTERNAL_DIFF',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof keys)[number], string | undefined>;
    process.env.GIT_DIR = join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_EXTERNAL_DIFF = helper;
    process.env.GIT_CONFIG_SYSTEM = hostileConfig;
    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '0';

    try {
      const status = await gitStatus(context);
      const diff = await gitDiff({staged: false}, context);

      expect(status.data?.porcelain).toContain(' M file.txt');
      expect(diff.data?.text).toContain('+workspace');
      await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
  });

  it('disables local fsmonitor, external diff and textconv helpers', async () => {
    await initializeRepository();
    const marker = join(root, 'local-helper.marker');
    const helper = await createHelper('local-helper', marker);

    await runGit(workspace, ['config', 'core.fsmonitor', helper]);
    const status = await gitStatus(context);
    expect(status.ok).toBe(true);
    await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});

    await writeFile(join(workspace, 'file.txt'), 'initial\nfsmonitor\n');
    const fsmonitorDiff = await gitDiff({staged: false}, context);
    expect(fsmonitorDiff.data?.text).toContain('+fsmonitor');
    await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});

    await runGit(workspace, ['config', '--unset', 'core.fsmonitor']);

    await writeFile(join(workspace, 'file.txt'), 'initial\nexternal\n');
    await runGit(workspace, ['config', 'diff.external', helper]);
    const externalDiff = await gitDiff({staged: false}, context);
    expect(externalDiff.data?.text).toContain('+external');
    await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
    await runGit(workspace, ['config', '--unset', 'diff.external']);

    await writeFile(join(workspace, 'file.txt'), 'initial\n');
    await writeFile(join(workspace, '.gitattributes'), '*.txt diff=custom\n');
    await runGit(workspace, ['add', '.gitattributes']);
    await runGit(workspace, ['commit', '--quiet', '-m', 'add attributes']);
    await runGit(workspace, ['config', 'diff.custom.textconv', helper]);
    await writeFile(join(workspace, 'file.txt'), 'initial\ntextconv\n');

    const textconvDiff = await gitDiff({staged: false}, context);

    expect(textconvDiff.data?.text).toContain('+textconv');
    await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('preserves complete logs for truncated status, diff and log output', async () => {
    await initializeRepository();
    for (let index = 0; index < 700; index += 1) {
      const name = `untracked-${String(index).padStart(4, '0')}-${'x'.repeat(90)}`;
      await writeFile(join(workspace, name), '');
    }
    const status = await gitStatus(context);

    await writeFile(
      join(workspace, 'file.txt'),
      `initial\n${'changed\n'.repeat(12_000)}`,
    );
    const diff = await gitDiff({staged: false}, context);

    const messagePath = join(root, 'long-message.txt');
    await writeFile(messagePath, `${'subject'.repeat(11_000)}\n`);
    await runGit(workspace, ['add', 'file.txt']);
    await runGit(workspace, ['commit', '--quiet', '-F', messagePath]);
    const log = await gitLog({limit: 1}, context);

    expect(status).toMatchObject({ok: true, truncated: true});
    expect(diff).toMatchObject({ok: true, truncated: true});
    expect(log).toMatchObject({
      ok: false,
      truncated: true,
      error: {code: 'GIT_OUTPUT_TRUNCATED'},
    });
    const paths = [
      status.data?.fullOutputPath,
      diff.data?.fullOutputPath,
      log.data?.fullOutputPath,
    ];
    for (const path of paths) {
      expect(path).toBeDefined();
      await expect(access(path ?? '')).resolves.toBeUndefined();
      expect((await readFile(path ?? '')).byteLength).toBeGreaterThan(64 * 1024);
    }
  }, 20_000);
});
