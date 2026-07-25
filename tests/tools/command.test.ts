import {constants} from 'node:fs';
import type {ChildProcess} from 'node:child_process';
import {getEventListeners} from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Writable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createWindowsProcessController,
  executableSearchCandidates,
  runCommand,
  type ProcessController,
  type WindowsProcessRecord,
  type WindowsProcessRunner,
} from '../../src/tools/command.js';
import type {ToolContext} from '../../src/tools/types.js';

const TEST_TIMEOUT_MS = 10_000;
const ROOT_PROCESS_CONTROLLER: ProcessController = {
  terminateTree(child) {
    child.kill('SIGTERM');
  },
  forceKillTree(child) {
    child.kill('SIGKILL');
  },
  treeExists() {
    return false;
  },
  async waitForTreeExit() {},
};

async function expectPosixMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  expect((await stat(path)).mode & 0o777).toBe(mode);
}

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

describe('executable identity resolution', () => {
  it.each(['npm', 'git'])(
    'does not let win32 implicitly select a forged cwd %s.cmd shim',
    (command) => {
      const cwd = 'C:\\repo';
      const candidates = executableSearchCandidates(
        command,
        cwd,
        {
          Path: [
            'C:\\Program Files\\nodejs',
            'C:\\Program Files\\Git\\cmd',
          ].join(';'),
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        'win32',
      );

      expect(candidates).not.toContain(`C:\\repo\\${command}.cmd`);
      expect(candidates.some(candidate => (
        candidate.toLowerCase() === `c:\\repo\\${command}.cmd`
      ))).toBe(false);
      expect(candidates.some(candidate => (
        candidate.toLowerCase().endsWith(`\\${command}.cmd`)
      ))).toBe(true);
    },
  );
});

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

  it('drops an incomplete UTF-8 tail while preserving its valid prefix', async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a😀")'],
      maxOutputBytes: 4,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      data: {stdout: 'a'},
    });
    await expect(
      readFile(result.data?.fullOutputPath ?? '', 'utf8'),
    ).resolves.toBe('a😀');
  });

  it.each(['EIO', 'ENOSPC'])(
    'removes a partial log and hides its path when streaming fails with %s',
    async (errorCode) => {
      let logPath: string | undefined;
      const result = await runCommand({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write("x".repeat(20000))',
        ],
        maxOutputBytes: 1_024,
      }, context, AbortSignal.timeout(TEST_TIMEOUT_MS), {
        processController: ROOT_PROCESS_CONTROLLER,
        async createOutputLog(path) {
          logPath = path;
          await mkdir(dirname(path), {recursive: true});
          await writeFile(path, 'partial');
          return new Writable({
            write(_chunk, _encoding, callback) {
              callback(Object.assign(new Error(errorCode), {code: errorCode}));
            },
          });
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'LOG_WRITE_FAILED'},
        truncated: true,
      });
      expect(result.data).not.toHaveProperty('fullOutputPath');
      expect(logPath).toBeDefined();
      await expect(access(logPath ?? '')).rejects.toMatchObject({code: 'ENOENT'});
    },
    TEST_TIMEOUT_MS,
  );

  it('retries failed log deletion, sanitizes the residue and reports cleanup status', async () => {
    let logPath: string | undefined;
    let outputLog: Writable | undefined;
    let removeAttempts = 0;
    const closedBeforeRemove: boolean[] = [];
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("secret-output")'],
      maxOutputBytes: 1,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS), {
      processController: ROOT_PROCESS_CONTROLLER,
      async createOutputLog(path) {
        logPath = path;
        await mkdir(dirname(path), {recursive: true});
        await writeFile(path, 'partial-secret', {mode: 0o644});
        outputLog = new Writable({
          write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error('disk failure'), {code: 'EIO'}));
          },
        });
        return outputLog;
      },
      async removeOutputLog() {
        removeAttempts += 1;
        closedBeforeRemove.push(outputLog?.closed === true);
        throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'OUTPUT_LOG_CLEANUP_FAILED'},
      data: {outputLogCleanup: 'sanitized'},
    });
    expect(result.data).not.toHaveProperty('fullOutputPath');
    expect(JSON.stringify(result)).not.toContain(logPath);
    expect(removeAttempts).toBe(3);
    expect(closedBeforeRemove).toEqual([true, true, true]);
    expect(logPath).toBeDefined();
    await expect(readFile(logPath ?? '', 'utf8')).resolves.toBe('');
    await expectPosixMode(logPath ?? '', 0o600);
  });

  it('reports sanitized cleanup status when output-log creation fails early', async () => {
    let logPath: string | undefined;
    const result = await runCommand({
      command: process.execPath,
    }, context, AbortSignal.timeout(TEST_TIMEOUT_MS), {
      async createOutputLog(path) {
        logPath = path;
        await mkdir(dirname(path), {recursive: true});
        await writeFile(path, 'early-secret', {mode: 0o644});
        throw new Error('creation failed');
      },
      async removeOutputLog() {
        throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'OUTPUT_LOG_CLEANUP_FAILED'},
      data: {outputLogCleanup: 'sanitized'},
    });
    expect(JSON.stringify(result)).not.toContain(logPath);
    await expect(readFile(logPath ?? '', 'utf8')).resolves.toBe('');
    await expectPosixMode(logPath ?? '', 0o600);
  });

  it('cancels the bounded output-log close timer after normal completion', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const result = await runCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("done")'],
      }, context, AbortSignal.timeout(TEST_TIMEOUT_MS));

      expect(result.ok).toBe(true);
      const closeTimers = setTimeoutSpy.mock.calls.flatMap((call, index) => (
        call[1] === 250
          ? [setTimeoutSpy.mock.results[index]?.value as NodeJS.Timeout]
          : []
      ));
      expect(closeTimers.length).toBeGreaterThan(0);
      for (const timer of closeTimers) {
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      }
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'cancels with SIGTERM and waits for graceful process cleanup',
    async () => {
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
    },
  );

  it('keeps a Windows tree force-kill timer after the parent closes', async () => {
    const readyPath = join(workspace, 'windows-controller.ready');
    const controller = new AbortController();
    const calls: string[] = [];
    const activeTimers = new Set<NodeJS.Timeout>();
    const timers = {
      setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout {
        const effectiveTimeout = timeoutMs === 2_000 ? 20 : timeoutMs;
        const timer = setTimeout(() => {
          activeTimers.delete(timer);
          callback();
        }, effectiveTimeout);
        activeTimers.add(timer);
        return timer;
      },
      clearTimeout(timer: NodeJS.Timeout): void {
        activeTimers.delete(timer);
        clearTimeout(timer);
      },
    };
    const processController = {
      terminateTree(child: {kill(signal: NodeJS.Signals): boolean}): void {
        calls.push('term');
        child.kill('SIGTERM');
      },
      forceKillTree(): void {
        calls.push('force');
      },
      treeExists(): boolean {
        return true;
      },
      async waitForTreeExit(): Promise<void> {
        calls.push('wait');
      },
    };
    const command = runCommand({
      command: process.execPath,
      args: [
        '-e',
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], "ready");',
          'process.on("SIGTERM", () => process.exit(0));',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        readyPath,
      ],
      timeoutMs: 5_000,
    }, context, controller.signal, {
      processController,
      timers,
    });

    await waitForFile(readyPath);
    controller.abort();
    const result = await command;

    expect(result.error?.code).toBe('ABORTED');
    expect(calls).toEqual(['term', 'force', 'wait']);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(activeTimers).toHaveLength(0);
  });

  it('tracks Windows descendants by creation identity after the parent PID is reused', async () => {
    const oldRoot: WindowsProcessRecord = {
      pid: 100,
      parentPid: 1,
      creationTime: '2026-07-25T01:00:00.000Z',
    };
    const childRecord: WindowsProcessRecord = {
      pid: 101,
      parentPid: 100,
      creationTime: '2026-07-25T01:00:01.000Z',
    };
    const grandchildRecord: WindowsProcessRecord = {
      pid: 102,
      parentPid: 101,
      creationTime: '2026-07-25T01:00:02.000Z',
    };
    const unrelatedRecord: WindowsProcessRecord = {
      pid: 200,
      parentPid: 1,
      creationTime: '2026-07-25T01:00:03.000Z',
    };
    const reusedRoot: WindowsProcessRecord = {
      pid: 100,
      parentPid: 1,
      creationTime: '2026-07-25T02:00:00.000Z',
    };
    let processes = [
      oldRoot,
      childRecord,
      grandchildRecord,
      unrelatedRecord,
    ];
    const taskkills: Array<{
      pid: number;
      tree: boolean;
      force: boolean;
    }> = [];
    const runner: WindowsProcessRunner = {
      async snapshotProcesses() {
        return processes.map((record) => ({...record}));
      },
      async taskkill(pid, options) {
        taskkills.push({pid, ...options});
        if (!options.force) {
          processes = [
            reusedRoot,
            childRecord,
            grandchildRecord,
            unrelatedRecord,
          ];
        } else {
          processes = processes.filter((record) => record.pid !== pid);
        }
        return {exitCode: 0};
      },
    };
    const controller = createWindowsProcessController(runner);
    const child = {pid: oldRoot.pid} as ChildProcess;

    await controller.trackTree?.(child);
    await controller.terminateTree(child);

    await expect(controller.treeExists(child)).resolves.toBe(true);
    await controller.forceKillTree(child);
    await controller.waitForTreeExit(child);

    expect(taskkills[0]).toEqual({
      pid: oldRoot.pid,
      tree: true,
      force: false,
    });
    expect(taskkills).not.toContainEqual({
      pid: reusedRoot.pid,
      tree: true,
      force: true,
    });
    expect(processes).toContainEqual(reusedRoot);
    expect(processes).toContainEqual(unrelatedRecord);
    expect(processes).not.toContainEqual(childRecord);
    expect(processes).not.toContainEqual(grandchildRecord);
  });

  it('fails Windows cleanup when taskkill is nonzero and the same process survives', async () => {
    const rootRecord: WindowsProcessRecord = {
      pid: 300,
      parentPid: 1,
      creationTime: '2026-07-25T03:00:00.000Z',
    };
    const childRecord: WindowsProcessRecord = {
      pid: 301,
      parentPid: 300,
      creationTime: '2026-07-25T03:00:01.000Z',
    };
    let processes = [rootRecord, childRecord];
    const runner: WindowsProcessRunner = {
      async snapshotProcesses() {
        return processes.map((record) => ({...record}));
      },
      async taskkill(_pid, options) {
        if (!options.force) {
          processes = [childRecord];
          return {exitCode: 0};
        }
        return {exitCode: 5};
      },
    };
    const controller = createWindowsProcessController(runner);
    const child = {pid: rootRecord.pid} as ChildProcess;

    await controller.trackTree?.(child);
    await controller.terminateTree(child);

    await expect(controller.forceKillTree(child)).rejects.toThrow(
      /taskkill.*5/i,
    );
  });

  it('rejects a Windows root identity captured after the original child exits', async () => {
    const reusedRoot: WindowsProcessRecord = {
      pid: 400,
      parentPid: 1,
      creationTime: '2026-07-25T04:00:00.000Z',
    };
    const taskkills: number[] = [];
    const runner: WindowsProcessRunner = {
      async snapshotProcesses() {
        return [reusedRoot];
      },
      async taskkill(pid) {
        taskkills.push(pid);
        return {exitCode: 0};
      },
    };
    const controller = createWindowsProcessController(runner);
    const exitedChild = {
      pid: reusedRoot.pid,
      exitCode: 0,
      signalCode: null,
    } as ChildProcess;

    await expect(controller.trackTree?.(exitedChild)).rejects.toThrow(
      /退出|身份/,
    );
    expect(taskkills).toEqual([]);
  });

  it.each(['track', 'terminate'] as const)(
    'bounds a hanging Windows %s phase and prevents late termination',
    async (hangingPhase) => {
    const readyPath = join(workspace, `hanging-${hangingPhase}.ready`);
    const controller = new AbortController();
    const calls: string[] = [];
    let releaseHangingPhase = (): void => {};
    const hanging = new Promise<void>((resolveHangingPhase) => {
      releaseHangingPhase = resolveHangingPhase;
    });
    const activeTimers = new Set<NodeJS.Timeout>();
    const timers = {
      setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout {
        const effectiveTimeout = timeoutMs === 2_000 ? 20 : timeoutMs;
        const timer = setTimeout(() => {
          activeTimers.delete(timer);
          callback();
        }, effectiveTimeout);
        activeTimers.add(timer);
        return timer;
      },
      clearTimeout(timer: NodeJS.Timeout): void {
        activeTimers.delete(timer);
        clearTimeout(timer);
      },
    };
    const failSafe = setTimeout(releaseHangingPhase, 500);

    try {
      const command = runCommand({
        command: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'fs.writeFileSync(process.argv[1], "ready");',
            'process.on("SIGTERM", () => process.exit(0));',
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          readyPath,
        ],
      }, context, controller.signal, {
        processController: {
          trackTree() {
            calls.push('track');
            return hangingPhase === 'track' ? hanging : undefined;
          },
          terminateTree(childProcess) {
            calls.push('terminate');
            if (hangingPhase === 'terminate') return hanging;
            childProcess.kill('SIGTERM');
          },
          forceKillTree() {
            calls.push('force');
          },
          treeExists() {
            calls.push('exists');
            return true;
          },
          async waitForTreeExit() {
            calls.push('wait');
          },
        },
        timers,
      });

      await waitForFile(readyPath);
      controller.abort();
      const result = await command;
      releaseHangingPhase();
      await delay(0);

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'PROCESS_TREE_CLEANUP_FAILED'},
      });
      expect(calls).toEqual(
        hangingPhase === 'track' ? ['track'] : ['track', 'terminate'],
      );
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(activeTimers).toHaveLength(0);
    } finally {
      clearTimeout(failSafe);
      releaseHangingPhase();
    }
    },
  );

  it.each(['force', 'wait'] as const)(
    'bounds a hanging %s cleanup phase',
    async (hangingPhase) => {
      const readyPath = join(workspace, `hanging-${hangingPhase}.ready`);
      const controller = new AbortController();
      const activeTimers = new Set<NodeJS.Timeout>();
      const timers = {
        setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout {
          const effectiveTimeout = timeoutMs === 2_000 ? 20 : timeoutMs;
          const timer = setTimeout(() => {
            activeTimers.delete(timer);
            callback();
          }, effectiveTimeout);
          activeTimers.add(timer);
          return timer;
        },
        clearTimeout(timer: NodeJS.Timeout): void {
          activeTimers.delete(timer);
          clearTimeout(timer);
        },
      };
      const never = new Promise<void>(() => {});
      const command = runCommand({
        command: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'fs.writeFileSync(process.argv[1], "ready");',
            'process.on("SIGTERM", () => process.exit(0));',
            'setInterval(() => {}, 1000);',
          ].join('\n'),
          readyPath,
        ],
      }, context, controller.signal, {
        processController: {
          trackTree() {},
          terminateTree(childProcess) {
            childProcess.kill('SIGTERM');
          },
          forceKillTree() {
            return hangingPhase === 'force' ? never : undefined;
          },
          treeExists() {
            return true;
          },
          waitForTreeExit() {
            return hangingPhase === 'wait' ? never : Promise.resolve();
          },
        },
        timers,
      });

      await waitForFile(readyPath);
      controller.abort();
      const result = await command;

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'PROCESS_TREE_CLEANUP_FAILED'},
      });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(activeTimers).toHaveLength(0);
    },
  );

  it('does not wait forever when force kill returns before the root exits', async () => {
    const readyPath = join(workspace, 'force-without-exit.ready');
    const controller = new AbortController();
    let spawnedChild: ChildProcess | undefined;
    const timers = {
      setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout {
        return setTimeout(callback, timeoutMs === 2_000 ? 20 : timeoutMs);
      },
      clearTimeout(timer: NodeJS.Timeout): void {
        clearTimeout(timer);
      },
    };
    const startedAt = Date.now();
    const command = runCommand({
      command: process.execPath,
      args: [
        '-e',
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], "ready");',
          'process.on("SIGTERM", () => {});',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        readyPath,
      ],
    }, context, controller.signal, {
      processController: {
        trackTree() {},
        terminateTree(childProcess) {
          spawnedChild = childProcess;
          childProcess.kill('SIGTERM');
        },
        forceKillTree() {},
        treeExists() {
          return true;
        },
        waitForTreeExit() {
          return new Promise<void>(() => {});
        },
      },
      timers,
    });
    const failSafe = setTimeout(() => {
      spawnedChild?.kill('SIGKILL');
    }, 500);

    try {
      await waitForFile(readyPath);
      controller.abort();
      const result = await command;

      expect(result).toMatchObject({
        ok: false,
        error: {code: 'PROCESS_TREE_CLEANUP_FAILED'},
      });
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      clearTimeout(failSafe);
      spawnedChild?.kill('SIGKILL');
    }
  });

  it('returns cleanup failure when process-tree exit cannot be proven', async () => {
    const readyPath = join(workspace, 'cleanup-failure.ready');
    const controller = new AbortController();
    const activeTimers = new Set<NodeJS.Timeout>();
    const timers = {
      setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout {
        const effectiveTimeout = timeoutMs === 2_000 ? 20 : timeoutMs;
        const timer = setTimeout(() => {
          activeTimers.delete(timer);
          callback();
        }, effectiveTimeout);
        activeTimers.add(timer);
        return timer;
      },
      clearTimeout(timer: NodeJS.Timeout): void {
        activeTimers.delete(timer);
        clearTimeout(timer);
      },
    };
    const command = runCommand({
      command: process.execPath,
      args: [
        '-e',
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], "ready");',
          'process.on("SIGTERM", () => process.exit(0));',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        readyPath,
      ],
    }, context, controller.signal, {
      processController: {
        terminateTree(childProcess) {
          childProcess.kill('SIGTERM');
        },
        forceKillTree() {},
        treeExists() {
          return true;
        },
        async waitForTreeExit() {
          throw new Error('cannot prove tree exit');
        },
      },
      timers,
    });

    await waitForFile(readyPath);
    controller.abort();
    const result = await command;

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'PROCESS_TREE_CLEANUP_FAILED'},
    });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(activeTimers).toHaveLength(0);
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
