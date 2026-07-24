import {constants} from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runCommand} from '../../src/tools/command.js';
import type {ToolContext} from '../../src/tools/types.js';

const TEST_TIMEOUT_MS = 10_000;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`等待文件超时：${path}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await delay(10);
  }
  throw new Error(`进程仍在运行：${pid}`);
}

describe('foreground command tool', () => {
  let root: string;
  let workspace: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'haochen-command-tools-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    workspace = await realpath(workspace);
    context = {
      workspace,
      tempDir: join(root, 'tool-output'),
    };
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('captures exit code, stdout and stderr', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: [
        '-e',
        'console.log("out"); console.error("err"); process.exit(3)',
      ],
      timeoutMs: 5_000,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(result).toMatchObject({
      ok: true,
      data: {exitCode: 3, stdout: 'out\n', stderr: 'err\n'},
      truncated: false,
    });
    expect(result.data).not.toHaveProperty('env');
  });

  it('defaults cwd to the workspace and resolves an explicit cwd inside it', async () => {
    const nested = join(workspace, 'nested');
    await mkdir(nested);

    const defaultResult = await runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd())'],
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));
    const nestedResult = await runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: 'nested',
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(defaultResult.data?.stdout).toBe(workspace);
    expect(nestedResult.data?.stdout).toBe(nested);
  });

  it('rejects a cwd outside the workspace before spawning', async () => {
    const marker = join(root, 'spawned.txt');

    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "yes")', marker],
      cwd: '..',
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'PATH_BOUNDARY'},
    });
    await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('truncates total output by bytes and writes complete output to a temp log', async () => {
    const fullOutput = 'x'.repeat(20_000);

    const result = await runCommand({
      command: process.execPath,
      args: ['-e', `process.stdout.write("x".repeat(${fullOutput.length}))`],
      maxOutputBytes: 1_024,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      data: {
        exitCode: 0,
        stdout: 'x'.repeat(1_024),
        stderr: '',
      },
    });
    expect(result.data?.fullOutputPath).toBeDefined();
    const logPath = result.data?.fullOutputPath ?? '';
    expect(relative(context.tempDir, logPath)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(dirname(logPath)).toBe(context.tempDir);
    await expect(readFile(logPath, 'utf8')).resolves.toBe(fullOutput);
  });

  it('does not expand a split UTF-8 character past the byte limit', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("😀")'],
      maxOutputBytes: 1,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.data?.stdout ?? '', 'utf8')).toBeLessThanOrEqual(1);
    await expect(
      readFile(result.data?.fullOutputPath ?? '', 'utf8'),
    ).resolves.toBe('😀');
  });

  it('cancels with SIGTERM and waits for graceful process cleanup', async () => {
    const pidPath = join(workspace, 'cancel.pid');
    const termPath = join(workspace, 'cancel.term');
    const controller = new AbortController();
    const command = runCommand({
      command: process.execPath,
      args: [
        '-e',
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], String(process.pid));',
          'process.on("SIGTERM", () => {',
          '  fs.writeFileSync(process.argv[2], "term");',
          '  process.exit(0);',
          '});',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        pidPath,
        termPath,
      ],
    }, context, controller.signal);

    await waitForFile(pidPath);
    const pid = Number(await readFile(pidPath, 'utf8'));
    controller.abort();
    const result = await command;

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'ABORTED'},
      data: {exitCode: 0},
    });
    await expect(readFile(termPath, 'utf8')).resolves.toBe('term');
    await waitForProcessExit(pid);
  });

  it.skipIf(process.platform === 'win32')(
    'kills a surviving descendant after its parent exits on SIGTERM',
    async () => {
      const pidsPath = join(workspace, 'orphan-pids.json');
      const readyPath = join(workspace, 'orphan-child.ready');
      const childSource = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(process.argv[1], "ready");',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const parentSource = [
        'const fs = require("node:fs");',
        'const {spawn} = require("node:child_process");',
        'const child = spawn(',
        '  process.execPath,',
        `  ["-e", ${JSON.stringify(childSource)}, process.argv[2]],`,
        '  {stdio: "ignore"},',
        ');',
        'fs.writeFileSync(',
        '  process.argv[1],',
        '  JSON.stringify({parent: process.pid, child: child.pid}),',
        ');',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const controller = new AbortController();
      let childPid: number | undefined;

      try {
        const command = runCommand({
          command: process.execPath,
          args: ['-e', parentSource, pidsPath, readyPath],
        }, context, controller.signal);
        await waitForFile(pidsPath);
        await waitForFile(readyPath);
        const pids = JSON.parse(await readFile(pidsPath, 'utf8')) as {
          parent: number;
          child: number;
        };
        childPid = pids.child;

        controller.abort();
        const result = await command;

        expect(result).toMatchObject({
          ok: false,
          error: {code: 'ABORTED'},
        });
        await waitForProcessExit(pids.parent);
        await waitForProcessExit(pids.child, 3_000);
      } finally {
        if (childPid !== undefined && isProcessRunning(childPid)) {
          process.kill(childPid, 'SIGKILL');
          await waitForProcessExit(childPid);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === 'win32')(
    'kills the process group after a timed-out parent ignores SIGTERM',
    async () => {
      const pidsPath = join(workspace, 'timeout-pids.json');
      const childSource = 'setInterval(() => {}, 1000);';
      const parentSource = [
        'const fs = require("node:fs");',
        'const {spawn} = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}]);`,
        'fs.writeFileSync(',
        '  process.argv[1],',
        '  JSON.stringify({parent: process.pid, child: child.pid}),',
        ');',
        'process.on("SIGTERM", () => {});',
        'setInterval(() => {}, 1000);',
      ].join('\n');

      const result = await runCommand({
        command: process.execPath,
        args: ['-e', parentSource, pidsPath],
        timeoutMs: 250,
      }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));
      await waitForFile(pidsPath);
      const pids = JSON.parse(await readFile(pidsPath, 'utf8')) as {
        parent: number;
        child: number;
      };

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'TIMEOUT'},
        data: {exitCode: null},
      });
      await waitForProcessExit(pids.parent);
      await waitForProcessExit(pids.child);
    },
    TEST_TIMEOUT_MS,
  );

  it('rejects invalid limits without spawning the command', async () => {
    const marker = join(workspace, 'invalid-limit.txt');

    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "yes")', marker],
      maxOutputBytes: -1,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'INVALID_INPUT'},
    });
    await expect(access(marker)).rejects.toMatchObject({code: 'ENOENT'});
  });
});
