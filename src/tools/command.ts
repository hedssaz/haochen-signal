import {randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdir, open, rm, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {finished} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
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

function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;

  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
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

function decode(chunks: Buffer[]): string {
  if (chunks.length === 0) return '';

  const bytes = Buffer.concat(chunks);
  const decoded = bytes.toString('utf8');
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
  const tempDir = resolve(context.tempDir);
  const fullOutputPath = resolve(
    tempDir,
    `command-${randomUUID()}.log`,
  );

  let outputHandle: Awaited<ReturnType<typeof open>>;
  try {
    await mkdir(tempDir, {recursive: true});
    outputHandle = await open(fullOutputPath, 'wx', 0o600);
  } catch {
    return failure('OUTPUT_LOG_FAILED', '无法创建命令输出日志');
  }

  const outputLog = outputHandle.createWriteStream();
  const outputLogFinished = finished(outputLog);
  let outputLogError: unknown;
  let child: ChildProcess;

  try {
    child = spawn(input.command, input.args ?? [], {
      cwd,
      shell: input.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    outputLog.end();
    await outputLogFinished.catch(() => undefined);
    await rm(fullOutputPath, {force: true}).catch(() => undefined);
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
    signalProcessTree(child, 'SIGTERM');
    forceKillPromise = new Promise<void>((complete) => {
      forceKillTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL');
        complete();
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

  const timeout = setTimeout(
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

  clearTimeout(timeout);
  if (forceKillTimer !== undefined) {
    if (processGroupExists(child)) {
      await forceKillPromise;
      await waitForProcessGroupExit(child);
    } else {
      clearTimeout(forceKillTimer);
    }
  }
  signal.removeEventListener('abort', abort);

  await outputLogFinished.catch((error) => {
    outputLogError ??= error;
  });

  const data: CommandOutput = {
    exitCode: outcome.exitCode,
    stdout: decode(stdoutChunks),
    stderr: decode(stderrChunks),
    ...(truncated ? {fullOutputPath} : {}),
  };

  if (!truncated) {
    await rm(fullOutputPath, {force: true}).catch(() => undefined);
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
  if (terminationReason === 'output-log-failed' || outputLogError) {
    return failure(
      'OUTPUT_LOG_FAILED',
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
