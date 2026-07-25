import {randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {
  mkdir,
  open,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {TextDecoder} from 'node:util';
import crossSpawn from 'cross-spawn';
import {resolveExecutableIdentity} from '../security/executable-identity.js';
import {resolveWorkspacePath} from '../security/path-boundary.js';
import type {ToolContext, ToolResult} from './types.js';

export {executableSearchCandidates} from '../security/executable-identity.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const OUTPUT_LOG_CLOSE_TIMEOUT_MS = 250;
const OUTPUT_LOG_REMOVE_ATTEMPTS = 3;
const OUTPUT_LOG_REMOVE_RETRY_MS = 25;

export interface RunCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  fullOutputPath?: string;
  outputLogCleanup?: 'sanitized' | 'failed';
}

export interface ProcessController {
  trackTree?(child: ChildProcess, signal?: AbortSignal): void | Promise<void>;
  terminateTree(child: ChildProcess, signal?: AbortSignal): void | Promise<void>;
  forceKillTree(
    child: ChildProcess,
    signal?: AbortSignal,
  ): void | Promise<void>;
  treeExists(
    child: ChildProcess,
    signal?: AbortSignal,
  ): boolean | Promise<boolean>;
  waitForTreeExit(child: ChildProcess, signal?: AbortSignal): Promise<void>;
}

export interface WindowsProcessRecord {
  pid: number;
  parentPid: number;
  creationTime: string;
}

export interface WindowsTaskkillResult {
  exitCode: number | null;
}

export interface WindowsProcessRunner {
  snapshotProcesses(signal?: AbortSignal): Promise<WindowsProcessRecord[]>;
  taskkill(
    pid: number,
    options: {tree: boolean; force: boolean},
    signal?: AbortSignal,
  ): Promise<WindowsTaskkillResult>;
}

export interface CommandTimerController {
  setTimeout(callback: () => void, timeoutMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface RunCommandRuntimeOptions {
  createOutputLog?: (path: string) => Promise<Writable>;
  env?: NodeJS.ProcessEnv;
  processController?: ProcessController;
  removeOutputLog?: (path: string) => Promise<void>;
  sanitizeOutputLog?: (path: string) => Promise<void>;
  timers?: CommandTimerController;
}

type TerminationReason = 'aborted' | 'timeout' | 'output-log-failed';

interface ProcessOutcome {
  exitCode: number | null;
  spawnError?: unknown;
}

class CommandToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandToolError';
  }
}

function invalidInput(message: string): never {
  throw new CommandToolError('INVALID_INPUT', message);
}

function validateInput(input: RunCommandInput): void {
  if (!input || typeof input !== 'object') {
    invalidInput('命令输入必须是对象');
  }
  if (typeof input.command !== 'string' || input.command.length === 0) {
    invalidInput('command 必须是非空字符串');
  }
  if (input.args !== undefined
    && (!Array.isArray(input.args)
      || input.args.some((argument) => typeof argument !== 'string'))) {
    invalidInput('args 必须是字符串数组');
  }
  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    invalidInput('cwd 必须是字符串');
  }
  if (input.shell !== undefined && typeof input.shell !== 'boolean') {
    invalidInput('shell 必须是布尔值');
  }
  if (input.timeoutMs !== undefined
    && (!Number.isInteger(input.timeoutMs)
      || input.timeoutMs < 0
      || input.timeoutMs > MAX_TIMER_DELAY_MS)) {
    invalidInput(`timeoutMs 必须是 0 到 ${MAX_TIMER_DELAY_MS} 的整数`);
  }
  if (input.maxOutputBytes !== undefined
    && (!Number.isSafeInteger(input.maxOutputBytes)
      || input.maxOutputBytes < 0)) {
    invalidInput('maxOutputBytes 必须是非负安全整数');
  }
}

function failure<T>(
  code: string,
  message: string,
  data?: T,
  truncated?: boolean,
): ToolResult<T> {
  return {
    ok: false,
    summary: message,
    ...(data === undefined ? {} : {data}),
    error: {code, message},
    ...(truncated === undefined ? {} : {truncated}),
  };
}

function inputFailure<T>(error: unknown): ToolResult<T> {
  if (error instanceof CommandToolError) {
    return failure(error.code, error.message);
  }

  const nodeCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (nodeCode === 'ENOENT') {
    return failure('CWD_NOT_FOUND', '命令工作目录不存在');
  }
  if (nodeCode === 'ENOTDIR') {
    return failure('CWD_NOT_DIRECTORY', '命令工作目录不是目录');
  }

  const message = error instanceof Error ? error.message : '';
  if (message.includes('工作区外') || message.includes('符号链接')) {
    return failure('PATH_BOUNDARY', '命令工作目录超出工作区边界');
  }
  return failure('COMMAND_EXECUTION_FAILED', '无法准备命令执行');
}

function signalPosixProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
}

function processGroupExists(child: ChildProcess): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(child: ChildProcess): Promise<void> {
  while (processGroupExists(child)) {
    await delay(10);
  }
}

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

class ProcessTreeCleanupError extends Error {
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

const POSIX_PROCESS_CONTROLLER: ProcessController = {
  terminateTree(child) {
    signalPosixProcessGroup(child, 'SIGTERM');
  },
  forceKillTree(child) {
    signalPosixProcessGroup(child, 'SIGKILL');
  },
  treeExists(child) {
    return processGroupExists(child);
  },
  waitForTreeExit(child) {
    return waitForProcessGroupExit(child);
  },
};

const WINDOWS_PROCESS_CONTROLLER = createWindowsProcessController();

const DEFAULT_TIMERS: CommandTimerController = {
  setTimeout(callback, timeoutMs) {
    return setTimeout(callback, timeoutMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

function decode(chunks: Buffer[]): string {
  if (chunks.length === 0) return '';

  const bytes = Buffer.concat(chunks);
  const decoded = new TextDecoder('utf-8').decode(bytes, {stream: true});
  if (Buffer.byteLength(decoded, 'utf8') <= bytes.length) return decoded;

  let usedBytes = 0;
  let endIndex = 0;
  for (const character of decoded) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > bytes.length) break;
    usedBytes += characterBytes;
    endIndex += character.length;
  }
  return decoded.slice(0, endIndex);
}

async function ensureOutputLogClosed(
  outputLog: Writable,
  outputLogFinished: Promise<void>,
): Promise<boolean> {
  if (!outputLog.writableEnded && !outputLog.destroyed) outputLog.end();
  await new Promise<void>((complete) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      complete();
    };
    const timeout = setTimeout(finish, OUTPUT_LOG_CLOSE_TIMEOUT_MS);
    void outputLogFinished.then(finish);
  });
  if (outputLog.closed) return true;
  if (!outputLog.destroyed) outputLog.destroy();
  if (outputLog.closed) return true;

  return new Promise<boolean>((complete) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      outputLog.removeListener('close', onClose);
      complete(closed);
    };
    const onClose = (): void => finish(true);
    const timeout = setTimeout(
      () => finish(outputLog.closed),
      OUTPUT_LOG_CLOSE_TIMEOUT_MS,
    );
    outputLog.once('close', onClose);
  });
}

async function sanitizeOutputLogFile(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
  );
  let failed = false;
  try {
    try {
      await handle.truncate(0);
    } catch {
      failed = true;
    }
    try {
      await handle.chmod(0o600);
    } catch {
      failed = true;
    }
  } finally {
    await handle.close().catch(() => {
      failed = true;
    });
  }
  if (failed) throw new Error('output log sanitization failed');
}

async function cleanupOutputLogFile(
  path: string,
  removeOutputLog: (path: string) => Promise<void>,
  sanitizeOutputLog: (path: string) => Promise<void>,
): Promise<'removed' | 'sanitized' | 'failed'> {
  for (let attempt = 1; attempt <= OUTPUT_LOG_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await removeOutputLog(path);
      return 'removed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'removed';
      }
      if (attempt < OUTPUT_LOG_REMOVE_ATTEMPTS) {
        await delay(OUTPUT_LOG_REMOVE_RETRY_MS);
      }
    }
  }

  try {
    await sanitizeOutputLog(path);
    return 'sanitized';
  } catch {
    return 'failed';
  }
}

function outputLogCleanupData(
  outputLogCleanup: 'sanitized' | 'failed',
): CommandOutput {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    outputLogCleanup,
  };
}

export async function runCommand(
  input: RunCommandInput,
  context: ToolContext,
  signal: AbortSignal,
  runtime: RunCommandRuntimeOptions = {},
): Promise<ToolResult<CommandOutput>> {
  try {
    validateInput(input);
  } catch (error) {
    return inputFailure(error);
  }

  if (signal.aborted) {
    return failure('ABORTED', '命令执行已取消');
  }

  let cwd: string;
  try {
    const resolvedCwd = await resolveWorkspacePath(
      context.workspace,
      input.cwd ?? '.',
      'existing',
    );
    if (!(await stat(resolvedCwd.absolute)).isDirectory()) {
      throw new CommandToolError(
        'CWD_NOT_DIRECTORY',
        '命令工作目录不是目录',
      );
    }
    cwd = resolvedCwd.absolute;
  } catch (error) {
    return inputFailure(error);
  }

  if (signal.aborted) {
    return failure('ABORTED', '命令执行已取消');
  }

  let executable = input.command;
  if (!(input.shell ?? false)) {
    const resolvedExecutable = await resolveExecutableIdentity(
      input.command,
      cwd,
      runtime.env ?? process.env,
      process.platform,
    );
    if (resolvedExecutable === undefined) {
      return failure('COMMAND_NOT_FOUND', '无法解析命令的可信可执行文件');
    }
    if (context.approvedExecutableIdentity !== undefined
      && resolvedExecutable !== context.approvedExecutableIdentity) {
      return failure(
        'SCOPE_CHANGED',
        '命令可执行文件身份在审批后发生变化',
      );
    }
    executable = context.approvedExecutableIdentity ?? resolvedExecutable;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const processController = runtime.processController
    ?? (process.platform === 'win32'
      ? WINDOWS_PROCESS_CONTROLLER
      : POSIX_PROCESS_CONTROLLER);
  const timers = runtime.timers ?? DEFAULT_TIMERS;
  const tempDir = resolve(context.tempDir);
  const fullOutputPath = resolve(
    tempDir,
    `command-${randomUUID()}.log`,
  );

  const removeOutputLog = runtime.removeOutputLog
    ?? ((path: string) => rm(path, {force: true}));
  const sanitizeOutputLog = runtime.sanitizeOutputLog
    ?? sanitizeOutputLogFile;
  let outputHandle: FileHandle | undefined;
  let outputLog: Writable;
  try {
    await mkdir(tempDir, {recursive: true});
    if (runtime.createOutputLog === undefined) {
      outputHandle = await open(fullOutputPath, 'wx', 0o600);
      outputLog = outputHandle.createWriteStream();
      outputHandle = undefined;
    } else {
      outputLog = await runtime.createOutputLog(fullOutputPath);
    }
  } catch {
    let outputHandleClosed = true;
    await outputHandle?.close().catch(() => {
      outputHandleClosed = false;
    });
    const cleanup = outputHandleClosed
      ? await cleanupOutputLogFile(
        fullOutputPath,
        removeOutputLog,
        sanitizeOutputLog,
      )
      : 'failed';
    if (cleanup !== 'removed') {
      return failure(
        'OUTPUT_LOG_CLEANUP_FAILED',
        '无法完整清理命令输出日志',
        outputLogCleanupData(cleanup),
      );
    }
    return failure('OUTPUT_LOG_FAILED', '无法创建命令输出日志');
  }

  let outputLogError: unknown;
  const outputLogFinished = finished(outputLog).catch((error) => {
    outputLogError ??= error;
  });
  let child: ChildProcess;

  try {
    child = crossSpawn(executable, input.args ?? [], {
      cwd,
      shell: input.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(runtime.env === undefined ? {} : {env: runtime.env}),
    });
  } catch {
    const outputLogClosed = await ensureOutputLogClosed(
      outputLog,
      outputLogFinished,
    );
    const cleanup = outputLogClosed
      ? await cleanupOutputLogFile(
        fullOutputPath,
        removeOutputLog,
        sanitizeOutputLog,
      )
      : 'failed';
    if (cleanup !== 'removed') {
      return failure(
        'OUTPUT_LOG_CLEANUP_FAILED',
        '无法完整清理命令输出日志',
        outputLogCleanupData(cleanup),
      );
    }
    return failure('COMMAND_EXECUTION_FAILED', '无法启动命令');
  }

  const cleanupController = new AbortController();
  let trackingError: unknown;
  const trackingPromise = (async () => {
    await processController.trackTree?.(child, cleanupController.signal);
  })().catch((error) => {
    trackingError = error;
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let closed = false;
  let terminationReason: TerminationReason | undefined;
  let cleanupError: unknown;
  let terminationSettled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let forceKillPromise: Promise<void> | undefined;
  let forceKillStarted = false;
  let completeForceKill = (): void => {};
  let treeCheckController: AbortController | undefined;

  const capture = (target: Buffer[], chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, maxOutputBytes - capturedBytes);
    if (remaining > 0) {
      const captured = bytes.subarray(0, remaining);
      target.push(Buffer.from(captured));
      capturedBytes += captured.length;
    }
    if (bytes.length > remaining) truncated = true;
  };

  const emergencyKillRoot = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The original ChildProcess handle may already be closed.
    }
  };

  const requestTermination = (reason: TerminationReason): void => {
    if (terminationReason !== undefined || closed) return;
    terminationReason = reason;
    void (async () => {
      await trackingPromise;
      if (trackingError !== undefined) throw trackingError;
      if (cleanupController.signal.aborted) {
        throw new ProcessTreeCleanupError('进程树身份建立超过清理期限');
      }
      await processController.terminateTree(
        child,
        cleanupController.signal,
      );
    })().catch((error) => {
      cleanupError ??= error;
    }).finally(() => {
      terminationSettled = true;
    });
    forceKillPromise = new Promise<void>((complete) => {
      let forceCompleted = false;
      completeForceKill = (): void => {
        if (forceCompleted) return;
        forceCompleted = true;
        complete();
      };
      forceKillTimer = timers.setTimeout(() => {
        forceKillStarted = true;
        treeCheckController?.abort();
        if (!terminationSettled || cleanupError !== undefined) {
          cleanupController.abort();
          cleanupError ??= new ProcessTreeCleanupError(
            '初始进程树清理超过两秒期限',
          );
          emergencyKillRoot();
          completeForceKill();
          return;
        }

        const forceController = new AbortController();
        let forcePhaseTimer: NodeJS.Timeout | undefined;
        const forcePhaseTimeout = new Promise<void>((phaseComplete) => {
          forcePhaseTimer = timers.setTimeout(() => {
            forceController.abort();
            cleanupError ??= new ProcessTreeCleanupError(
              'Windows 强制清理超过期限',
            );
            emergencyKillRoot();
            phaseComplete();
          }, FORCE_KILL_DELAY_MS);
        });
        const forceOperation = Promise.resolve()
          .then(async () => {
            await processController.forceKillTree(
              child,
              forceController.signal,
            );
            await processController.waitForTreeExit(
              child,
              forceController.signal,
            );
          })
          .catch((error) => {
            cleanupError ??= error;
            emergencyKillRoot();
          })
          .then(() => undefined);
        void Promise.race([forceOperation, forcePhaseTimeout])
          .finally(() => {
            if (forcePhaseTimer !== undefined) {
              timers.clearTimeout(forcePhaseTimer);
            }
            completeForceKill();
          });
      }, FORCE_KILL_DELAY_MS);
    });
  };

  outputLog.once('error', (error) => {
    outputLogError = error;
    requestTermination('output-log-failed');
  });

  child.stdout?.on('data', (chunk: Buffer | string) => {
    capture(stdoutChunks, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    capture(stderrChunks, chunk);
  });

  let openOutputStreams = 0;
  const pipeToOutputLog = (
    stream: NodeJS.ReadableStream | null,
  ): void => {
    if (stream === null) return;
    openOutputStreams += 1;
    let done = false;
    const finishSource = (): void => {
      if (done) return;
      done = true;
      openOutputStreams -= 1;
      if (openOutputStreams === 0 && !outputLog.destroyed) outputLog.end();
    };
    stream.once('end', finishSource);
    stream.once('close', finishSource);
    stream.once('error', finishSource);
    stream.pipe(outputLog, {end: false});
  };

  pipeToOutputLog(child.stdout);
  pipeToOutputLog(child.stderr);
  if (openOutputStreams === 0) outputLog.end();

  const abort = (): void => requestTermination('aborted');
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();

  const timeout = timers.setTimeout(
    () => requestTermination('timeout'),
    timeoutMs,
  );

  const outcome = await new Promise<ProcessOutcome>((complete) => {
    let spawnError: unknown;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (exitCode) => {
      closed = true;
      complete({exitCode, spawnError});
    });
  });

  timers.clearTimeout(timeout);
  if (terminationReason === undefined) {
    cleanupController.abort();
  }
  if (forceKillTimer !== undefined && forceKillPromise !== undefined) {
    if (terminationSettled
      && cleanupError === undefined
      && !forceKillStarted) {
      treeCheckController = new AbortController();
      const treeCheck = Promise.resolve()
        .then(() => processController.treeExists(
          child,
          treeCheckController?.signal,
        ))
        .then(
        (exists) => ({kind: 'checked' as const, exists}),
        (error) => {
          if (!treeCheckController?.signal.aborted || !forceKillStarted) {
            cleanupError ??= error;
          }
          return {kind: 'checked' as const, exists: true};
        },
        );
      const first = await Promise.race([
        treeCheck,
        forceKillPromise.then(() => ({kind: 'forced' as const})),
      ]);
      if (first.kind === 'checked'
        && (cleanupError !== undefined || !first.exists)
        && !forceKillStarted) {
        timers.clearTimeout(forceKillTimer);
        completeForceKill();
      }
    }
    await forceKillPromise;
  }
  signal.removeEventListener('abort', abort);

  const logWriteFailed = terminationReason === 'output-log-failed'
    || outputLogError !== undefined;
  const outputLogClosed = await ensureOutputLogClosed(
    outputLog,
    outputLogFinished,
  );
  let outputLogCleanup: CommandOutput['outputLogCleanup'];
  if (!outputLogClosed) {
    outputLogCleanup = 'failed';
  } else if (!truncated || logWriteFailed) {
    const cleanup = await cleanupOutputLogFile(
      fullOutputPath,
      removeOutputLog,
      sanitizeOutputLog,
    );
    if (cleanup !== 'removed') outputLogCleanup = cleanup;
  }

  const data: CommandOutput = {
    exitCode: outcome.exitCode,
    stdout: decode(stdoutChunks),
    stderr: decode(stderrChunks),
    ...(truncated && !logWriteFailed && outputLogCleanup === undefined
      ? {fullOutputPath}
      : {}),
    ...(outputLogCleanup === undefined ? {} : {outputLogCleanup}),
  };

  if (cleanupError !== undefined) {
    return failure(
      'PROCESS_TREE_CLEANUP_FAILED',
      '无法确认命令进程树已完整退出',
      data,
      truncated,
    );
  }
  if (outputLogCleanup !== undefined) {
    return failure(
      'OUTPUT_LOG_CLEANUP_FAILED',
      '无法完整清理命令输出日志',
      data,
      truncated,
    );
  }
  if (terminationReason === 'aborted') {
    return failure('ABORTED', '命令执行已取消', data, truncated);
  }
  if (terminationReason === 'timeout') {
    return failure(
      'TIMEOUT',
      `命令执行超过 ${timeoutMs} 毫秒`,
      data,
      truncated,
    );
  }
  if (logWriteFailed) {
    return failure(
      'LOG_WRITE_FAILED',
      '写入命令输出日志失败',
      data,
      truncated,
    );
  }
  if (outcome.spawnError) {
    const nodeCode = (outcome.spawnError as NodeJS.ErrnoException).code;
    const code = nodeCode === 'ENOENT'
      ? 'COMMAND_NOT_FOUND'
      : 'COMMAND_EXECUTION_FAILED';
    return failure(code, '无法启动命令', data, truncated);
  }

  return {
    ok: true,
    summary: `命令执行完成，退出码 ${outcome.exitCode ?? 'null'}`,
    data,
    truncated,
  };
}
