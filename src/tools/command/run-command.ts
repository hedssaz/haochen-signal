import {randomUUID} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
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
import crossSpawn from 'cross-spawn';
import {resolveExecutableIdentity} from '../../security/executable-identity.js';
import {resolveWorkspacePath} from '../../security/path-boundary.js';
import type {ToolContext, ToolResult} from '../types.js';
import {
  CommandToolError,
  failure,
  inputFailure,
  validateInput,
} from './errors.js';
import {
  cleanupOutputLogFile,
  decode,
  ensureOutputLogClosed,
  outputLogCleanupData,
  sanitizeOutputLogFile,
} from './output-log.js';
import {
  processGroupExists,
  signalPosixProcessGroup,
  waitForProcessGroupExit,
} from './process-controller.js';
import type {
  CommandOutput,
  CommandTimerController,
  ProcessController,
  ProcessOutcome,
  RunCommandInput,
  RunCommandRuntimeOptions,
  TerminationReason,
} from './types.js';
import {
  ProcessTreeCleanupError,
  WINDOWS_PROCESS_CONTROLLER,
} from './windows-process-tree.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 2_000;

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

const DEFAULT_TIMERS: CommandTimerController = {
  setTimeout(callback, timeoutMs) {
    return setTimeout(callback, timeoutMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

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
