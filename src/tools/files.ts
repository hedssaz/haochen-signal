import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {
  lstat,
  open,
  realpath,
  readdir,
  unlink,
} from 'node:fs/promises';
import {dirname, join, relative, sep} from 'node:path';
import {
  resolveWorkspacePath,
  type ResolvedPath,
} from '../security/path-boundary.js';
import type {ToolContext, ToolResult} from './types.js';

const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 400;
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const NO_FOLLOW = constants.O_NOFOLLOW;
// Darwin's open(2) exposes O_NOFOLLOW_ANY, but Node does not export it.
// It rejects symlinks in every path component, not only the final component.
const DARWIN_NO_FOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0;
const SECURE_OPEN_FLAGS = DARWIN_NO_FOLLOW_ANY || NO_FOLLOW;

export interface ListFilesInput {
  path?: string;
}

export interface ListFilesOutput {
  files: string[];
}

export interface SearchTextInput {
  query: string;
  path?: string;
  maxMatches?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchTextOutput {
  matches: SearchMatch[];
}

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadFileOutput {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export type PatchOperation =
  | {type: 'add'; path: string; content: string}
  | {type: 'update'; path: string; expected: string; replacement: string}
  | {type: 'delete'; path: string; sha256: string};

export interface ApplyPatchInput {
  operations: PatchOperation[];
}

export interface FileChange {
  path: string;
  type: PatchOperation['type'];
  additions: number;
  deletions: number;
}

export interface ApplyPatchOutput {
  changes: FileChange[];
}

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

interface PlannedAdd {
  type: 'add';
  path: string;
  resolved: ResolvedPath;
  content: string;
  parent: ResolvedPath;
  parentIdentity: FileIdentity;
}

interface PlannedUpdate {
  type: 'update';
  path: string;
  resolved: ResolvedPath;
  expected: string;
  replacement: string;
  snapshotSha256: string;
  additions: number;
  deletions: number;
}

interface PlannedDelete {
  type: 'delete';
  path: string;
  resolved: ResolvedPath;
  snapshotSha256: string;
  deletions: number;
}

type PlannedOperation = PlannedAdd | PlannedUpdate | PlannedDelete;

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

function failure<T>(error: unknown): ToolResult<T> {
  if (error instanceof FileToolError) {
    return {
      ok: false,
      summary: error.message,
      error: {code: error.code, message: error.message},
    };
  }

  if ((error as Error).name === 'AbortError') {
    const message = '文件操作已取消';
    return {
      ok: false,
      summary: message,
      error: {code: 'ABORTED', message},
    };
  }

  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code === 'ENOENT') {
    return {
      ok: false,
      summary: '文件或目录不存在',
      error: {code: 'NOT_FOUND', message: '文件或目录不存在'},
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('工作区外') || message.includes('符号链接')) {
    return {
      ok: false,
      summary: message,
      error: {code: 'PATH_BOUNDARY', message},
    };
  }

  return {
    ok: false,
    summary: message,
    error: {code: 'FILE_OPERATION_FAILED', message},
  };
}

function assertNotAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function toWorkspacePath(path: string): string {
  return path.split(sep).join('/');
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

async function collectRegularFiles(
  inputPath: string,
  context: ToolContext,
  signal: AbortSignal,
): Promise<string[]> {
  const root = await resolveWorkspacePath(
    context.workspace,
    inputPath,
    'existing',
  );
  if (root.relative.split(sep).some(
    (segment) => EXCLUDED_DIRECTORIES.has(segment),
  )) {
    return [];
  }
  const rootStat = await lstat(root.absolute);
  if (rootStat.isFile()) return [toWorkspacePath(root.relative)];
  if (!rootStat.isDirectory()) {
    throw new FileToolError('NOT_A_DIRECTORY', '请求路径不是目录');
  }

  const files: string[] = [];
  const walk = async (directory: ResolvedPath): Promise<void> => {
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
        await walk(resolved);
      } else if (stat.isFile()) {
        files.push(toWorkspacePath(resolved.relative));
      }
    }
  };

  await walk(root);
  files.sort(comparePaths);
  return files;
}

async function openVerifiedRegularFile(
  resolved: ResolvedPath,
  context: ToolContext,
  flags: number,
): Promise<{
  file: Awaited<ReturnType<typeof open>>;
  identity: FileIdentity;
}> {
  const file = await open(resolved.absolute, flags | SECURE_OPEN_FLAGS);
  try {
    const identity = await verifyOpenedRegularFile(file, resolved, context);
    return {file, identity};
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function verifyOpenedRegularFile(
  file: Awaited<ReturnType<typeof open>>,
  resolved: ResolvedPath,
  context: ToolContext,
): Promise<FileIdentity> {
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
  return openedIdentity;
}

async function readVerifiedFile(
  resolved: ResolvedPath,
  context: ToolContext,
): Promise<{
  contents: Buffer;
  identity: FileIdentity;
}> {
  const {file, identity} = await openVerifiedRegularFile(
    resolved,
    context,
    constants.O_RDONLY,
  );
  try {
    return {
      contents: await file.readFile(),
      identity,
    };
  } finally {
    await file.close();
  }
}

async function readSearchFile(
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

function isBinary(contents: Buffer): boolean {
  if (contents.includes(0)) return true;
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(contents);
  } catch {
    return true;
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
  return contents.length > 0 && controlBytes / contents.length > 0.1;
}

export async function listFiles(
  input: ListFilesInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult<ListFilesOutput>> {
  try {
    assertNotAborted(signal);
    const files = await collectRegularFiles(
      input.path ?? '.',
      context,
      signal,
    );
    return success(`找到 ${files.length} 个文件`, {files});
  } catch (error) {
    return failure(error);
  }
}

export async function searchText(
  input: SearchTextInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult<SearchTextOutput>> {
  try {
    assertNotAborted(signal);
    if (typeof input.query !== 'string' || input.query.length === 0) {
      throw new FileToolError('INVALID_INPUT', '搜索文本不能为空');
    }
    if (input.maxMatches !== undefined
      && (!Number.isInteger(input.maxMatches) || input.maxMatches < 1)) {
      throw new FileToolError('INVALID_INPUT', '搜索结果上限必须是正整数');
    }

    const limit = Math.min(input.maxMatches ?? MAX_SEARCH_MATCHES, MAX_SEARCH_MATCHES);
    const files = await collectRegularFiles(
      input.path ?? '.',
      context,
      signal,
    );
    const matches: SearchMatch[] = [];
    let truncated = false;

    search:
    for (const path of files) {
      assertNotAborted(signal);
      const resolved = await resolveWorkspacePath(
        context.workspace,
        path,
        'existing',
      );
      const contents = await readSearchFile(resolved, context);
      if (contents === undefined || isBinary(contents)) continue;

      const lines = contents.toString('utf8').split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const preview = lines[lineIndex] ?? '';
        let columnIndex = preview.indexOf(input.query);
        while (columnIndex !== -1) {
          if (matches.length === limit) {
            truncated = true;
            break search;
          }
          matches.push({
            path,
            line: lineIndex + 1,
            column: columnIndex + 1,
            preview,
          });
          columnIndex = preview.indexOf(input.query, columnIndex + 1);
        }
      }
    }

    return success(
      `找到 ${matches.length} 个匹配`,
      {matches},
      truncated,
    );
  } catch (error) {
    return failure(error);
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
    if (!Number.isInteger(startLine)
      || !Number.isInteger(requestedEndLine)
      || startLine < 1
      || requestedEndLine < startLine) {
      throw new FileToolError('INVALID_LINE_RANGE', '读取行范围无效');
    }

    const resolved = await resolveWorkspacePath(
      context.workspace,
      input.path,
      'existing',
    );
    const {contents} = await readVerifiedFile(resolved, context);
    const text = contents.toString('utf8');
    const lines = text.length === 0 ? [] : text.split(/\r?\n/);
    if (startLine > Math.max(lines.length, 1)) {
      throw new FileToolError('INVALID_LINE_RANGE', '起始行超出文件范围');
    }

    const endLine = Math.min(
      requestedEndLine,
      startLine + MAX_READ_LINES - 1,
      lines.length,
    );
    const content = endLine < startLine
      ? ''
      : lines.slice(startLine - 1, endLine).join('\n');
    const truncated = startLine > 1 || endLine < lines.length;

    return success(
      `读取 ${resolved.relative} 第 ${startLine}-${endLine} 行`,
      {
        path: toWorkspacePath(resolved.relative),
        content,
        startLine,
        endLine,
        totalLines: lines.length,
      },
      truncated,
    );
  } catch (error) {
    return failure(error);
  }
}

function countOccurrences(contents: string, expected: string): number {
  if (expected.length === 0) return Number.POSITIVE_INFINITY;
  let count = 0;
  let index = contents.indexOf(expected);
  while (index !== -1) {
    count += 1;
    if (count > 1) return count;
    index = contents.indexOf(expected, index + 1);
  }
  return count;
}

async function validateAdd(
  operation: Extract<PatchOperation, {type: 'add'}>,
  context: ToolContext,
): Promise<PlannedAdd> {
  const path = operation.path;
  assertString(path, 'path');
  const resolved = await resolveWorkspacePath(
    context.workspace,
    path,
    'new',
  );
  try {
    await lstat(resolved.absolute);
    throw new FileToolError('FILE_EXISTS', `文件已存在：${resolved.relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const parentRequested = relative(
    await realpath(context.workspace),
    dirname(resolved.absolute),
  ) || '.';
  const parent = await resolveWorkspacePath(
    context.workspace,
    parentRequested,
    'existing',
  );
  const parentStat = await lstat(parent.absolute);
  if (!parentStat.isDirectory()) {
    throw new FileToolError('PARENT_NOT_DIRECTORY', '新增文件的父路径不是目录');
  }
  const content = operation.content;
  assertString(content, 'content');

  return {
    type: 'add',
    path: toWorkspacePath(resolved.relative),
    resolved,
    content,
    parent,
    parentIdentity: fileIdentity(parentStat),
  };
}

async function validateUpdate(
  operation: Extract<PatchOperation, {type: 'update'}>,
  context: ToolContext,
): Promise<PlannedUpdate> {
  const path = operation.path;
  assertString(path, 'path');
  const resolved = await resolveWorkspacePath(
    context.workspace,
    path,
    'existing',
  );
  const {contents} = await readVerifiedFile(resolved, context);
  const text = contents.toString('utf8');
  const expected = operation.expected;
  const replacement = operation.replacement;
  assertString(expected, 'expected');
  assertString(replacement, 'replacement');
  if (countOccurrences(text, expected) !== 1) {
    throw new FileToolError(
      'EXPECTED_NOT_UNIQUE',
      `更新片段必须且只能出现一次：${resolved.relative}`,
    );
  }

  return {
    type: 'update',
    path: toWorkspacePath(resolved.relative),
    resolved,
    expected,
    replacement,
    snapshotSha256: sha256(contents),
    additions: countLines(replacement),
    deletions: countLines(expected),
  };
}

async function validateDelete(
  operation: Extract<PatchOperation, {type: 'delete'}>,
  context: ToolContext,
): Promise<PlannedDelete> {
  const path = operation.path;
  assertString(path, 'path');
  const resolved = await resolveWorkspacePath(
    context.workspace,
    path,
    'existing',
  );
  const {contents} = await readVerifiedFile(resolved, context);
  const expectedSha256 = operation.sha256;
  assertString(expectedSha256, 'sha256');
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new FileToolError('INVALID_INPUT', '删除操作需要有效的 SHA-256');
  }
  const currentSha256 = sha256(contents);
  if (currentSha256 !== expectedSha256.toLowerCase()) {
    throw new FileToolError(
      'SHA256_MISMATCH',
      `文件内容已变化，拒绝删除：${resolved.relative}`,
    );
  }

  return {
    type: 'delete',
    path: toWorkspacePath(resolved.relative),
    resolved,
    snapshotSha256: currentSha256,
    deletions: countLines(contents.toString('utf8')),
  };
}

async function validatePatch(
  input: ApplyPatchInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<PlannedOperation[]> {
  if (!Array.isArray(input.operations)) {
    throw new FileToolError('INVALID_INPUT', '补丁操作必须是数组');
  }

  const planned: PlannedOperation[] = [];
  const paths = new Set<string>();
  for (const operation of input.operations) {
    assertNotAborted(signal);
    let next: PlannedOperation;
    if (operation.type === 'add') {
      next = await validateAdd(operation, context);
    } else if (operation.type === 'update') {
      next = await validateUpdate(operation, context);
    } else if (operation.type === 'delete') {
      next = await validateDelete(operation, context);
    } else {
      throw new FileToolError('INVALID_INPUT', '未知的补丁操作类型');
    }

    if (paths.has(next.resolved.absolute)) {
      throw new FileToolError(
        'DUPLICATE_PATH',
        `同一补丁不能多次操作同一路径：${next.path}`,
      );
    }
    paths.add(next.resolved.absolute);
    planned.push(next);
  }
  return planned;
}

async function assertSecureWriteCapability(
  context: ToolContext,
): Promise<void> {
  if (DARWIN_NO_FOLLOW_ANY === 0) return;
  const workspace = await realpath(context.workspace);
  const directory = await open(
    workspace,
    constants.O_RDONLY | DARWIN_NO_FOLLOW_ANY,
  );
  try {
    if (!(await directory.stat()).isDirectory()) {
      throw new FileToolError('NOT_A_DIRECTORY', '工作区不是目录');
    }
  } finally {
    await directory.close();
  }
}

function assertPlansUnchanged(
  initial: PlannedOperation[],
  checked: PlannedOperation[],
): void {
  for (let index = 0; index < initial.length; index += 1) {
    const first = initial[index];
    const second = checked[index];
    if (first === undefined
      || second === undefined
      || first.type !== second.type
      || first.resolved.absolute !== second.resolved.absolute) {
      throw new FileToolError('FILE_CHANGED', '补丁路径在执行前已变化');
    }
    if (first.type === 'add' && second.type === 'add') {
      if (!sameIdentity(first.parentIdentity, second.parentIdentity)) {
        throw new FileToolError('FILE_CHANGED', '新增文件的父目录已变化');
      }
    } else if (first.type !== 'add' && second.type !== 'add') {
      if (first.snapshotSha256 !== second.snapshotSha256) {
        throw new FileToolError('FILE_CHANGED', '文件内容在执行前已变化');
      }
    }
  }
}

async function executeAdd(
  operation: PlannedAdd,
  context: ToolContext,
): Promise<FileChange> {
  const current = await resolveWorkspacePath(
    context.workspace,
    operation.path,
    'new',
  );
  if (current.absolute !== operation.resolved.absolute) {
    throw new FileToolError('FILE_CHANGED', '新增文件路径在执行前已变化');
  }
  const parent = await resolveWorkspacePath(
    context.workspace,
    operation.parent.relative,
    'existing',
  );
  const parentStat = await lstat(parent.absolute);
  if (!sameIdentity(operation.parentIdentity, fileIdentity(parentStat))) {
    throw new FileToolError('FILE_CHANGED', '新增文件的父目录已变化');
  }

  const file = await open(
    current.absolute,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | SECURE_OPEN_FLAGS,
    0o644,
  );
  try {
    await verifyOpenedRegularFile(file, current, context);
    await file.writeFile(operation.content, 'utf8');
  } finally {
    await file.close();
  }
  return {
    path: operation.path,
    type: 'add',
    additions: countLines(operation.content),
    deletions: 0,
  };
}

async function executeUpdate(
  operation: PlannedUpdate,
  context: ToolContext,
): Promise<FileChange> {
  const {file} = await openVerifiedRegularFile(
    operation.resolved,
    context,
    constants.O_RDWR,
  );
  try {
    const current = await file.readFile();
    if (sha256(current) !== operation.snapshotSha256) {
      throw new FileToolError('FILE_CHANGED', '文件内容在更新前已变化');
    }

    const text = current.toString('utf8');
    if (countOccurrences(text, operation.expected) !== 1) {
      throw new FileToolError(
        'FILE_CHANGED',
        '更新片段在执行前已变化',
      );
    }
    const updated = Buffer.from(
      text.replace(operation.expected, operation.replacement),
      'utf8',
    );
    let offset = 0;
    while (offset < updated.length) {
      const {bytesWritten} = await file.write(
        updated,
        offset,
        updated.length - offset,
        offset,
      );
      if (bytesWritten === 0) {
        throw new FileToolError('FILE_OPERATION_FAILED', '无法写入更新内容');
      }
      offset += bytesWritten;
    }
    await file.truncate(updated.length);
  } finally {
    await file.close();
  }

  return {
    path: operation.path,
    type: 'update',
    additions: operation.additions,
    deletions: operation.deletions,
  };
}

async function executeDelete(
  operation: PlannedDelete,
  context: ToolContext,
): Promise<FileChange> {
  const {file, identity} = await openVerifiedRegularFile(
    operation.resolved,
    context,
    constants.O_RDONLY,
  );
  try {
    const contents = await file.readFile();
    if (sha256(contents) !== operation.snapshotSha256) {
      throw new FileToolError('FILE_CHANGED', '文件内容在删除前已变化');
    }

    const current = await resolveWorkspacePath(
      context.workspace,
      operation.path,
      'existing',
    );
    const currentStat = await lstat(current.absolute);
    if (!sameIdentity(identity, fileIdentity(currentStat))) {
      throw new FileToolError('FILE_CHANGED', '文件在删除前已被替换');
    }
    await unlink(current.absolute);
  } finally {
    await file.close();
  }
  return {
    path: operation.path,
    type: 'delete',
    additions: 0,
    deletions: operation.deletions,
  };
}

export async function applyPatch(
  input: ApplyPatchInput,
  context: ToolContext,
  signal: AbortSignal,
): Promise<ToolResult<ApplyPatchOutput>> {
  try {
    assertNotAborted(signal);
    await assertSecureWriteCapability(context);
    const initial = await validatePatch(input, context, signal);
    const checked = await validatePatch(input, context, signal);
    assertPlansUnchanged(initial, checked);

    const changes: FileChange[] = [];
    for (const operation of checked) {
      assertNotAborted(signal);
      if (operation.type === 'add') {
        changes.push(await executeAdd(operation, context));
      } else if (operation.type === 'update') {
        changes.push(await executeUpdate(operation, context));
      } else {
        changes.push(await executeDelete(operation, context));
      }
    }
    return success(`已应用 ${changes.length} 个文件补丁`, {changes});
  } catch (error) {
    return failure(error);
  }
}
