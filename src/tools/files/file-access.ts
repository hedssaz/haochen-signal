import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {
  resolveWorkspacePath,
  type ResolvedPath,
} from '../../security/path-boundary.js';
import type {ToolContext} from '../types.js';
import {
  FileToolError,
  fileIdentity,
  sameIdentity,
} from './common.js';

const NO_FOLLOW = constants.O_NOFOLLOW;
// Darwin's open(2) exposes O_NOFOLLOW_ANY, but Node does not export it.
// It rejects symlinks in every path component, not only the final component.
export const DARWIN_NO_FOLLOW_ANY = process.platform === 'darwin'
  ? 0x20000000
  : 0;
export const SECURE_OPEN_FLAGS = DARWIN_NO_FOLLOW_ANY || NO_FOLLOW;

type OpenFileHandle = Awaited<ReturnType<typeof open>>;

export interface FileIdentity {
  dev: number;
  ino: number;
}

export async function openVerifiedRegularFile(
  resolved: ResolvedPath,
  context: ToolContext,
  flags: number,
): Promise<{
  file: OpenFileHandle;
  identity: FileIdentity;
  mode: number;
}> {
  const file = await open(resolved.absolute, flags | SECURE_OPEN_FLAGS);
  try {
    const verified = await verifyOpenedRegularFile(file, resolved, context);
    return {file, ...verified};
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function verifyOpenedRegularFile(
  file: OpenFileHandle,
  resolved: ResolvedPath,
  context: ToolContext,
): Promise<{identity: FileIdentity; mode: number}> {
  const openedStat = await file.stat();
  if (!openedStat.isFile()) {
    throw new FileToolError('NOT_A_FILE', '请求路径不是常规文件');
  }

  const current = await resolveWorkspacePath(
    context.workspace,
    resolved.relative,
    'existing',
  );
  if (current.absolute !== resolved.absolute) {
    throw new FileToolError('FILE_CHANGED', '文件路径在操作前已变化');
  }

  const currentStat = await lstat(current.absolute);
  const openedIdentity = fileIdentity(openedStat);
  if (!sameIdentity(openedIdentity, fileIdentity(currentStat))) {
    throw new FileToolError('FILE_CHANGED', '文件在操作前已被替换');
  }
  return {
    identity: openedIdentity,
    mode: openedStat.mode & 0o7777,
  };
}

export async function readVerifiedFile(
  resolved: ResolvedPath,
  context: ToolContext,
): Promise<{
  contents: Buffer;
  identity: FileIdentity;
  mode: number;
}> {
  const {file, identity, mode} = await openVerifiedRegularFile(
    resolved,
    context,
    constants.O_RDONLY,
  );
  try {
    return {
      contents: await file.readFile(),
      identity,
      mode,
    };
  } finally {
    await file.close();
  }
}

export function decodeUtf8Text(contents: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(contents);
  } catch {
    throw new FileToolError('BINARY_FILE', '文件不是有效的 UTF-8 文本');
  }

  let controlBytes = 0;
  for (const byte of contents) {
    if ((byte < 0x20
        && byte !== 0x09
        && byte !== 0x0a
        && byte !== 0x0c
        && byte !== 0x0d)
      || byte === 0x7f) {
      controlBytes += 1;
    }
  }
  if (contents.includes(0)
    || (contents.length > 0 && controlBytes / contents.length > 0.1)) {
    throw new FileToolError('BINARY_FILE', '文件包含二进制内容');
  }
  return text;
}

export function isBinary(contents: Buffer): boolean {
  try {
    decodeUtf8Text(contents);
    return false;
  } catch (error) {
    if (error instanceof FileToolError && error.code === 'BINARY_FILE') {
      return true;
    }
    throw error;
  }
}
