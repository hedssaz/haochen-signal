import {spawn, type ChildProcess} from 'node:child_process';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {
  ProcessController,
  WindowsProcessRecord,
  WindowsProcessRunner,
} from './types.js';

interface WindowsUtilityResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface WindowsTreeState {
  root: WindowsProcessRecord;
  tree?: Map<number, WindowsProcessRecord>;
}

const WINDOWS_TREE_WAIT_TIMEOUT_MS = 5_000;
const WINDOWS_TREE_WAIT_INTERVAL_MS = 25;
const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$items = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{',
  '    pid = [int]$_.ProcessId',
  '    parentPid = [int]$_.ParentProcessId',
  '    creationTime = $_.CreationDate.ToUniversalTime().ToString("o")',
  '  }',
  '})',
  'ConvertTo-Json -InputObject $items -Compress',
].join('\n');

export class ProcessTreeCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessTreeCleanupError';
  }
}

function windowsSystemExecutable(
  ...segments: string[]
): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return resolve(systemRoot, 'System32', ...segments);
}

async function runWindowsUtility(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<WindowsUtilityResult> {
  return new Promise<WindowsUtilityResult>((complete, reject) => {
    const utility = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(signal === undefined ? {} : {signal}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    utility.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    utility.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    utility.once('error', reject);
    utility.once('close', (exitCode) => {
      complete({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseWindowsProcessSnapshot(
  stdout: string,
): WindowsProcessRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ProcessTreeCleanupError('无法解析 Windows 进程树快照');
  }
  if (!Array.isArray(value)) {
    throw new ProcessTreeCleanupError('Windows 进程树快照格式无效');
  }

  const seen = new Set<number>();
  return value.map((record) => {
    if (!record || typeof record !== 'object') {
      throw new ProcessTreeCleanupError('Windows 进程树快照记录无效');
    }
    const candidate = record as Record<string, unknown>;
    const pid = candidate.pid;
    const parentPid = candidate.parentPid;
    const creationTime = candidate.creationTime;
    if (!Number.isInteger(pid)
      || (pid as number) <= 0
      || !Number.isInteger(parentPid)
      || (parentPid as number) < 0
      || typeof creationTime !== 'string'
      || !Number.isFinite(Date.parse(creationTime))) {
      throw new ProcessTreeCleanupError('Windows 进程树快照身份无效');
    }
    if (seen.has(pid as number)) {
      throw new ProcessTreeCleanupError('Windows 进程树快照包含重复 PID');
    }
    seen.add(pid as number);
    return {
      pid: pid as number,
      parentPid: parentPid as number,
      creationTime,
    };
  });
}

const DEFAULT_WINDOWS_PROCESS_RUNNER: WindowsProcessRunner = {
  async snapshotProcesses(signal) {
    const result = await runWindowsUtility(
      windowsSystemExecutable(
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
      ],
      signal,
    );
    if (result.exitCode !== 0) {
      throw new ProcessTreeCleanupError(
        `Windows 进程树快照失败，退出码 ${result.exitCode ?? 'null'}`,
      );
    }
    return parseWindowsProcessSnapshot(result.stdout);
  },
  async taskkill(pid, options, signal) {
    const args = ['/PID', String(pid)];
    if (options.tree) args.push('/T');
    if (options.force) args.push('/F');
    const result = await runWindowsUtility(
      windowsSystemExecutable('taskkill.exe'),
      args,
      signal,
    );
    return {exitCode: result.exitCode};
  },
};

function sameWindowsProcess(
  left: WindowsProcessRecord,
  right: WindowsProcessRecord | undefined,
): boolean {
  return right !== undefined
    && left.pid === right.pid
    && left.creationTime === right.creationTime;
}

function findWindowsProcess(
  identity: WindowsProcessRecord,
  processes: WindowsProcessRecord[],
): WindowsProcessRecord | undefined {
  return processes.find((processRecord) => (
    sameWindowsProcess(identity, processRecord)
  ));
}

function snapshotWindowsTree(
  root: WindowsProcessRecord,
  processes: WindowsProcessRecord[],
): Map<number, WindowsProcessRecord> {
  const currentRoot = findWindowsProcess(root, processes);
  if (currentRoot === undefined) {
    throw new ProcessTreeCleanupError(
      '首次 taskkill 前无法确认 Windows 根进程身份',
    );
  }

  const children = new Map<number, WindowsProcessRecord[]>();
  for (const processRecord of processes) {
    const records = children.get(processRecord.parentPid) ?? [];
    records.push(processRecord);
    children.set(processRecord.parentPid, records);
  }

  const tree = new Map<number, WindowsProcessRecord>();
  const pending = [currentRoot];
  while (pending.length > 0) {
    const processRecord = pending.shift();
    if (processRecord === undefined || tree.has(processRecord.pid)) continue;
    tree.set(processRecord.pid, processRecord);

    for (const child of children.get(processRecord.pid) ?? []) {
      if (Date.parse(child.creationTime) < Date.parse(processRecord.creationTime)) {
        continue;
      }
      pending.push(child);
    }
  }
  return tree;
}

function survivingWindowsProcesses(
  tree: Map<number, WindowsProcessRecord>,
  processes: WindowsProcessRecord[],
): WindowsProcessRecord[] {
  return [...tree.values()].filter((identity) => (
    findWindowsProcess(identity, processes) !== undefined
  ));
}

function requireActiveCleanupSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProcessTreeCleanupError('Windows 进程树清理已超过期限');
  }
}

export function createWindowsProcessController(
  runner: WindowsProcessRunner = DEFAULT_WINDOWS_PROCESS_RUNNER,
): ProcessController {
  const states = new WeakMap<ChildProcess, WindowsTreeState>();

  const getState = (child: ChildProcess): WindowsTreeState => {
    const state = states.get(child);
    if (state === undefined) {
      throw new ProcessTreeCleanupError('Windows 进程树尚未建立身份快照');
    }
    return state;
  };

  return {
    async trackTree(child, signal) {
      if (child.pid === undefined) {
        throw new ProcessTreeCleanupError('Windows 子进程没有 PID');
      }
      if ((child.exitCode !== null && child.exitCode !== undefined)
        || (child.signalCode !== null && child.signalCode !== undefined)) {
        throw new ProcessTreeCleanupError(
          'Windows 子进程已退出，无法确认原始 PID 身份',
        );
      }
      requireActiveCleanupSignal(signal);
      const processes = await runner.snapshotProcesses(signal);
      requireActiveCleanupSignal(signal);
      if ((child.exitCode !== null && child.exitCode !== undefined)
        || (child.signalCode !== null && child.signalCode !== undefined)) {
        throw new ProcessTreeCleanupError(
          'Windows 子进程在身份快照期间退出',
        );
      }
      const root = processes.find((processRecord) => (
        processRecord.pid === child.pid
      ));
      if (root === undefined) {
        throw new ProcessTreeCleanupError('无法确认 Windows 子进程身份');
      }
      states.set(child, {root});
    },
    async terminateTree(child, signal) {
      const state = getState(child);
      const processes = await runner.snapshotProcesses(signal);
      state.tree = snapshotWindowsTree(state.root, processes);
      requireActiveCleanupSignal(signal);
      const result = await runner.taskkill(state.root.pid, {
        tree: true,
        force: false,
      }, signal);
      if (result.exitCode !== 0) {
        const current = await runner.snapshotProcesses(signal);
        if (survivingWindowsProcesses(state.tree, current).length === 0) {
          return;
        }
      }
    },
    async forceKillTree(child, signal) {
      const state = getState(child);
      if (state.tree === undefined) {
        throw new ProcessTreeCleanupError(
          'Windows 进程树未在首次 taskkill 前完成快照',
        );
      }

      const identities = [...state.tree.values()].reverse();
      for (const identity of identities) {
        const before = await runner.snapshotProcesses(signal);
        if (findWindowsProcess(identity, before) === undefined) continue;

        requireActiveCleanupSignal(signal);
        const result = await runner.taskkill(identity.pid, {
          tree: true,
          force: true,
        }, signal);
        if (result.exitCode !== 0) {
          const after = await runner.snapshotProcesses(signal);
          if (findWindowsProcess(identity, after) !== undefined) {
            throw new ProcessTreeCleanupError(
              `taskkill /F 失败，PID ${identity.pid}，退出码 ${
                result.exitCode ?? 'null'
              }`,
            );
          }
        }
      }
    },
    async treeExists(child, signal) {
      const state = getState(child);
      if (state.tree === undefined) {
        throw new ProcessTreeCleanupError('Windows 进程树快照不存在');
      }
      const processes = await runner.snapshotProcesses(signal);
      return survivingWindowsProcesses(state.tree, processes).length > 0;
    },
    async waitForTreeExit(child, signal) {
      const state = getState(child);
      if (state.tree === undefined) {
        throw new ProcessTreeCleanupError('Windows 进程树快照不存在');
      }
      const deadline = Date.now() + WINDOWS_TREE_WAIT_TIMEOUT_MS;
      while (true) {
        const processes = await runner.snapshotProcesses(signal);
        if (survivingWindowsProcesses(state.tree, processes).length === 0) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new ProcessTreeCleanupError(
            '无法证明 Windows 进程树已完整退出',
          );
        }
        await delay(WINDOWS_TREE_WAIT_INTERVAL_MS);
      }
    },
  };
}

export const WINDOWS_PROCESS_CONTROLLER: ProcessController = createWindowsProcessController();
