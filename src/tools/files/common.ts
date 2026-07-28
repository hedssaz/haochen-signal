import {createHash} from 'node:crypto';
import {sep} from 'node:path';
import {toPortableRelativePath} from '../../security/path-boundary.js';
import {redactValue} from '../../security/redact.js';
import type {ToolResult} from '../types.js';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);

class FileToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileToolError';
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function success<T>(
  summary: string,
  data: T,
  truncated?: boolean,
): ToolResult<T> {
  return {
    ok: true,
    summary,
    data,
    ...(truncated === undefined ? {} : {truncated}),
  };
}

function safeProperty(value: unknown, property: string): unknown {
  if (value === null
    || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function safeRedactedMessage(value: unknown, fallback: string): string {
  try {
    const messageProperty = safeProperty(value, 'message');
    let raw: unknown = typeof messageProperty === 'string'
      ? messageProperty
      : value;
    if (raw === null || raw === undefined || raw === '') raw = fallback;
    const redacted = redactValue(raw);
    if (typeof redacted === 'string') return redacted;
    try {
      return JSON.stringify(redacted) ?? fallback;
    } catch {
      try {
        const stringValue = String(redacted);
        const safeString = redactValue(stringValue);
        return typeof safeString === 'string' ? safeString : fallback;
      } catch {
        return fallback;
      }
    }
  } catch {
    return fallback;
  }
}

function postCommitWarning(
  action: string,
  error: unknown,
): string {
  const detail = safeRedactedMessage(error, '后置操作失败');
  return safeRedactedMessage(
    `${action}，但后置操作失败：${detail}`,
    '操作已提交，但后置操作失败',
  );
}

function failure<T>(
  error: unknown,
  signal?: AbortSignal,
): ToolResult<T> {
  try {
    let code = 'FILE_OPERATION_FAILED';
    let message = safeRedactedMessage(error, '文件操作失败');
    const name = safeProperty(error, 'name');
    const nodeCode = safeProperty(error, 'code');

    if (signal?.aborted || name === 'AbortError') {
      code = 'ABORTED';
      const reason = signal?.aborted ? signal.reason : error;
      const detail = safeRedactedMessage(reason, '');
      message = detail ? `文件操作已取消：${detail}` : '文件操作已取消';
    } else if (error instanceof FileToolError) {
      code = error.code;
    } else if (nodeCode === 'ENOENT') {
      code = 'NOT_FOUND';
      message = '文件或目录不存在';
    } else if (nodeCode === 'EEXIST') {
      code = 'FILE_EXISTS';
      message = '文件已存在';
    } else if (message.includes('工作区外') || message.includes('符号链接')) {
      code = 'PATH_BOUNDARY';
    }

    const safeMessage = safeRedactedMessage(message, '文件操作失败');
    return {
      ok: false,
      summary: safeMessage,
      error: {code, message: safeMessage},
    };
  } catch {
    const message = '文件操作失败';
    return {
      ok: false,
      summary: message,
      error: {code: 'FILE_OPERATION_FAILED', message},
    };
  }
}

function assertNotAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function toWorkspacePath(path: string): string {
  return toPortableRelativePath(path);
}

function hasExcludedDirectory(
  path: string,
  platformSeparator = sep,
): boolean {
  return path.split(platformSeparator).some(
    segment => isExcludedDirectory(segment),
  );
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name);
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fileIdentity(stat: {dev: number; ino: number}): FileIdentity {
  return {dev: stat.dev, ino: stat.ino};
}

function sameIdentity(
  first: FileIdentity,
  second: FileIdentity,
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  const breaks = contents.match(/\r\n|\r|\n/g)?.length ?? 0;
  return breaks + (/(?:\r\n|\r|\n)$/.test(contents) ? 0 : 1);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new FileToolError('INVALID_INPUT', `${field} 必须是字符串`);
  }
}

export {
  FileToolError,
  assertNotAborted,
  assertString,
  comparePaths,
  countLines,
  failure,
  fileIdentity,
  hasExcludedDirectory,
  isExcludedDirectory,
  postCommitWarning,
  safeProperty,
  safeRedactedMessage,
  sameIdentity,
  sha256,
  success,
  toWorkspacePath,
};
