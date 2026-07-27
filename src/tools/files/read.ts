import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {
  resolveWorkspacePath,
  type ResolvedPath,
} from '../../security/path-boundary.js';
import type {ToolContext, ToolResult} from '../types.js';
import {
  FileToolError,
  assertNotAborted,
  comparePaths,
  failure,
  fileIdentity,
  hasExcludedDirectory,
  sameIdentity,
  success,
  toWorkspacePath,
} from './common.js';
import type {
  ListFilesInput,
  ListFilesOutput,
  ReadFileInput,
  ReadFileOutput,
} from './types.js';

const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_FILES = 500;
const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READ_CHARACTERS = 65_536;
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const NO_FOLLOW = constants.O_NOFOLLOW;
// Darwin's open(2) exposes O_NOFOLLOW_ANY, but Node does not export it.
// It rejects symlinks in every path component, not only the final component.
const DARWIN_NO_FOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0;
const SECURE_OPEN_FLAGS = DARWIN_NO_FOLLOW_ANY || NO_FOLLOW;

type OpenFileHandle = Awaited<ReturnType<typeof open>>;

interface FileIdentity {
  dev: number;
  ino: number;
}

export async function collectRegularFiles(
  inputPath: string,
  context: ToolContext,
  signal: AbortSignal,
  maxFiles = Number.POSITIVE_INFINITY,
): Promise<{files: string[]; truncated: boolean}> {
  const root = await resolveWorkspacePath(
    context.workspace,
    inputPath,
    'existing',
  );
  if (hasExcludedDirectory(root.relative)) {
    return {files: [], truncated: false};
  }
  const rootStat = await lstat(root.absolute);
  if (rootStat.isFile()) {
    return {files: [toWorkspacePath(root.relative)], truncated: false};
  }
  if (!rootStat.isDirectory()) {
    throw new FileToolError('NOT_A_DIRECTORY', '请求路径不是目录');
  }

  const files: string[] = [];
  let directories = [root];
  while (directories.length > 0) {
    const nextDirectories: ResolvedPath[] = [];
    directories.sort((left, right) => comparePaths(
      left.relative,
      right.relative,
    ));
    for (const directory of directories) {
      assertNotAborted(signal);
      const entries = await readdir(directory.absolute, {withFileTypes: true});
      entries.sort((left, right) => comparePaths(left.name, right.name));

      for (const entry of entries) {
        assertNotAborted(signal);
        if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) {
          continue;
        }

        const requested = directory.relative === '.'
          ? entry.name
          : join(directory.relative, entry.name);
        const resolved = await resolveWorkspacePath(
          context.workspace,
          requested,
          'existing',
        );
        const stat = await lstat(resolved.absolute);
        if (stat.isDirectory()) {
          nextDirectories.push(resolved);
        } else if (stat.isFile()) {
          if (files.length >= maxFiles) {
            return {files, truncated: true};
          }
          files.push(toWorkspacePath(resolved.relative));
        }
      }
    }
    directories = nextDirectories;
  }

  return {files, truncated: false};
}

async function openVerifiedRegularFile(
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

async function verifyOpenedRegularFile(
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


export async function readSearchFile(
  resolved: ResolvedPath,
  context: ToolContext,
): Promise<Buffer | undefined> {
  const {file} = await openVerifiedRegularFile(
    resolved,
    context,
    constants.O_RDONLY,
  );
  try {
    const stat = await file.stat();
    if (stat.size > MAX_SEARCH_FILE_BYTES) return undefined;

    const buffer = Buffer.alloc(MAX_SEARCH_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SEARCH_FILE_BYTES) return undefined;
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}


interface TextLineState {
  pending: string;
}

function consumeTextLines(
  state: TextLineState,
  text: string,
  eof: boolean,
  onLine: (line: string) => void,
): void {
  state.pending += text;
  let start = 0;
  let index = 0;
  while (index < state.pending.length) {
    const character = state.pending[index];
    if (character !== '\r' && character !== '\n') {
      index += 1;
      continue;
    }
    if (character === '\r'
      && index + 1 === state.pending.length
      && !eof) {
      break;
    }

    onLine(state.pending.slice(start, index));
    index += character === '\r' && state.pending[index + 1] === '\n' ? 2 : 1;
    start = index;
  }

  state.pending = state.pending.slice(start);
  if (eof && state.pending.length > 0) {
    onLine(state.pending);
    state.pending = '';
  }
}


async function readLinesWithinLimit(
  resolved: ResolvedPath,
  context: ToolContext,
  signal: AbortSignal,
  startLine: number,
  endLine: number,
): Promise<{lines: string[]; totalLines: number}> {
  const {file} = await openVerifiedRegularFile(
    resolved,
    context,
    constants.O_RDONLY,
  );
  try {
    if ((await file.stat()).size > MAX_READ_BYTES) {
      throw new FileToolError(
        'READ_LIMIT_EXCEEDED',
        `文件超过读取上限 ${MAX_READ_BYTES} 字节`,
      );
    }

    const decoder = new TextDecoder('utf-8', {fatal: true});
    const state: TextLineState = {pending: ''};
    const selected: string[] = [];
    let totalLines = 0;
    let position = 0;
    const accept = (line: string): void => {
      totalLines += 1;
      if (totalLines >= startLine && totalLines <= endLine) {
        selected.push(line);
      }
    };

    while (true) {
      assertNotAborted(signal);
      const remaining = MAX_READ_BYTES - position;
      if (remaining < 0) {
        throw new FileToolError(
          'READ_LIMIT_EXCEEDED',
          `文件超过读取上限 ${MAX_READ_BYTES} 字节`,
        );
      }
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining + 1));
      const {bytesRead} = await file.read(
        chunk,
        0,
        chunk.length,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > MAX_READ_BYTES) {
        throw new FileToolError(
          'READ_LIMIT_EXCEEDED',
          `文件超过读取上限 ${MAX_READ_BYTES} 字节`,
        );
      }
      try {
        consumeTextLines(
          state,
          decoder.decode(chunk.subarray(0, bytesRead), {stream: true}),
          false,
          accept,
        );
      } catch (error) {
        if (error instanceof FileToolError) throw error;
        throw new FileToolError('BINARY_FILE', '文件不是有效的 UTF-8 文本');
      }
    }

    try {
      consumeTextLines(
        state,
        decoder.decode(),
        true,
        accept,
      );
    } catch {
      throw new FileToolError('BINARY_FILE', '文件不是有效的 UTF-8 文本');
    }
    return {lines: selected, totalLines};
  } finally {
    await file.close();
  }
}

export async function listFiles(
  input: ListFilesInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult<ListFilesOutput>> {
  try {
    assertNotAborted(signal);
    const {files, truncated} = await collectRegularFiles(
      input.path ?? '.',
      context,
      signal,
      MAX_LIST_FILES,
    );
    return success(
      truncated
        ? `找到前 ${files.length} 个文件（已截断）`
        : `找到 ${files.length} 个文件`,
      {files},
      truncated || undefined,
    );
  } catch (error) {
    return failure(error, signal);
  }
}


export async function readFileTool(
  input: ReadFileInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult<ReadFileOutput>> {
  try {
    assertNotAborted(signal);
    const startLine = input.startLine ?? 1;
    const requestedEndLine = input.endLine ?? startLine + MAX_READ_LINES - 1;
    const startCharacter = input.startCharacter ?? 0;
    const maxCharacters = input.maxCharacters ?? MAX_READ_CHARACTERS;
    if (!Number.isInteger(startLine)
      || !Number.isInteger(requestedEndLine)
      || startLine < 1
      || requestedEndLine < startLine) {
      throw new FileToolError('INVALID_LINE_RANGE', '读取行范围无效');
    }
    if (!Number.isSafeInteger(startCharacter)
      || !Number.isSafeInteger(maxCharacters)
      || startCharacter < 0
      || maxCharacters < 1
      || maxCharacters > MAX_READ_CHARACTERS) {
      throw new FileToolError('INVALID_CHARACTER_RANGE', '读取字符范围无效');
    }

    const resolved = await resolveWorkspacePath(
      context.workspace,
      input.path,
      'existing',
    );
    const cappedEndLine = Math.min(
      requestedEndLine,
      startLine + MAX_READ_LINES - 1,
    );
    const {lines, totalLines} = await readLinesWithinLimit(
      resolved,
      context,
      signal,
      startLine,
      cappedEndLine,
    );
    if (totalLines === 0) {
      if (startCharacter > 0) {
        throw new FileToolError('INVALID_CHARACTER_RANGE', '起始字符超出文件范围');
      }
      return success(
        `读取 ${toWorkspacePath(resolved.relative)}：空文件`,
        {
          path: toWorkspacePath(resolved.relative),
          content: '',
          startLine: 0,
          endLine: 0,
          totalLines: 0,
          startCharacter: 0,
          endCharacter: 0,
          totalCharacters: 0,
        },
        false,
      );
    }
    if (startLine > totalLines) {
      throw new FileToolError('INVALID_LINE_RANGE', '起始行超出文件范围');
    }

    const endLine = Math.min(
      cappedEndLine,
      totalLines,
    );
    const characters = Array.from(lines.join('\n'));
    const totalCharacters = characters.length;
    if (startCharacter > totalCharacters) {
      throw new FileToolError('INVALID_CHARACTER_RANGE', '起始字符超出文件范围');
    }
    const endCharacter = Math.min(
      startCharacter + maxCharacters,
      totalCharacters,
    );
    const content = characters.slice(startCharacter, endCharacter).join('');
    const truncated = startLine > 1
      || endLine < totalLines
      || startCharacter > 0
      || endCharacter < totalCharacters;

    return success(
      `读取 ${
        toWorkspacePath(resolved.relative)
      } 第 ${startLine}-${endLine} 行`,
      {
        path: toWorkspacePath(resolved.relative),
        content,
        startLine,
        endLine,
        totalLines,
        startCharacter,
        endCharacter,
        totalCharacters,
        ...(endCharacter < totalCharacters ? {nextCharacter: endCharacter} : {}),
      },
      truncated,
    );
  } catch (error) {
    return failure(error, signal);
  }
}
