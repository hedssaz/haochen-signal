import {randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, open, rm, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {TextDecoder} from 'node:util';
import {resolveWorkspacePath} from '../security/path-boundary.js';
import type {ToolContext, ToolResult} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
}

export interface ProcessController {
  terminateTree(child: ChildProcess): void | Promise<void>;
  forceKillTree(child: ChildProcess): void | Promise<void>;
  treeExists(child: ChildProcess): boolean | Promise<boolean>;
  waitForTreeExit(child: ChildProcess): Promise<void>;
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

async function runTaskkill(
  child: ChildProcess,
  force: boolean,
): Promise<void> {
  if (child.pid === undefined) return;
  const args = ['/PID', String(child.pid), '/T'];
  if (force) args.push('/F');

  await new Promise<void>((complete) => {
    const killer = spawn('taskkill', args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => complete());
    killer.once('close', () => complete());
  });
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

const WINDOWS_PROCESS_CONTROLLER: ProcessController = {
  terminateTree(child) {
    return runTaskkill(child, false);
  },
  forceKillTree(child) {
    return runTaskkill(child, true);
  },
  treeExists(child) {
    return child.pid !== undefined;
  },
  async waitForTreeExit() {
    // forceKillTree waits for the fixed taskkill process to finish.
  },
};

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
  let outputLog: Writable;
  try {
    await mkdir(tempDir, {recursive: true});
    if (runtime.createOutputLog === undefined) {
      const outputHandle = await open(fullOutputPath, 'wx', 0o600);
      outputLog = outputHandle.createWriteStream();
    } else {
      outputLog = await runtime.createOutputLog(fullOutputPath);
    }
  } catch {
    await removeOutputLog(fullOutputPath).catch(() => undefined);
    return failure('OUTPUT_LOG_FAILED', '无法创建命令输出日志');
  }

  let outputLogError: unknown;
  const outputLogFinished = finished(outputLog).catch((error) => {
    outputLogError ??= error;
  });
  let child: ChildProcess;

  try {
    child = spawn(input.command, input.args ?? [], {
      cwd,
      shell: input.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(runtime.env === undefined ? {} : {env: runtime.env}),
    });
  } catch {
    outputLog.end();
    await outputLogFinished;
    await removeOutputLog(fullOutputPath).catch(() => undefined);
    return failure('COMMAND_EXECUTION_FAILED', '无法启动命令');
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let closed = false;
  let terminationReason: TerminationReason | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let forceKillPromise: Promise<void> | undefined;

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

  const requestTermination = (reason: TerminationReason): void => {
    if (terminationReason !== undefined || closed) return;
    terminationReason = reason;
    void Promise.resolve(processController.terminateTree(child))
      .catch(() => undefined);
    forceKillPromise = new Promise<void>((complete) => {
      forceKillTimer = timers.setTimeout(() => {
        void Promise.resolve(processController.forceKillTree(child))
          .then(complete, complete);
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
  if (forceKillTimer !== undefined) {
    let treeExists = true;
    try {
      treeExists = await processController.treeExists(child);
    } catch {
      treeExists = true;
    }
    if (treeExists) {
      await forceKillPromise;
      await processController.waitForTreeExit(child);
    } else {
      timers.clearTimeout(forceKillTimer);
    }
  }
  signal.removeEventListener('abort', abort);

  await outputLogFinished;

  const logWriteFailed = terminationReason === 'output-log-failed'
    || outputLogError !== undefined;
  const data: CommandOutput = {
    exitCode: outcome.exitCode,
    stdout: decode(stdoutChunks),
    stderr: decode(stderrChunks),
    ...(truncated && !logWriteFailed ? {fullOutputPath} : {}),
  };

  if (!truncated || logWriteFailed) {
    await removeOutputLog(fullOutputPath).catch(() => undefined);
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
