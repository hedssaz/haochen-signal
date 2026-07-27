import type {ToolResult} from '../types.js';
import type {RunCommandInput} from './types.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class CommandToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandToolError';
  }
}

export function invalidInput(message: string): never {
  throw new CommandToolError('INVALID_INPUT', message);
}

export function validateInput(input: RunCommandInput): void {
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

export function failure<T>(
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

export function inputFailure<T>(error: unknown): ToolResult<T> {
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
