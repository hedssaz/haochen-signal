import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import {basename, dirname, join, relative} from 'node:path';
import {
  resolveWorkspacePath,
  type ResolvedPath,
} from '../../security/path-boundary.js';
import type {ToolContext, ToolResult} from '../types.js';
import {
  FileToolError,
  assertNotAborted,
  assertString,
  countLines,
  failure,
  fileIdentity,
  postCommitWarning,
  sameIdentity,
  sha256,
  success,
  toWorkspacePath,
} from './common.js';
import type {
  ApplyPatchInput,
  ApplyPatchOutput,
  FileChange,
  PatchFileOperations,
  PatchOperation,
} from './types.js';

const NO_FOLLOW = constants.O_NOFOLLOW;
// Darwin's open(2) exposes O_NOFOLLOW_ANY, but Node does not export it.
// It rejects symlinks in every path component, not only the final component.
const DARWIN_NO_FOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0;
const SECURE_OPEN_FLAGS = DARWIN_NO_FOLLOW_ANY || NO_FOLLOW;

type OpenFileHandle = Awaited<ReturnType<typeof open>>;

const DEFAULT_PATCH_FILE_OPERATIONS: PatchFileOperations = {
  async write(file, contents) {
    let offset = 0;
    while (offset < contents.length) {
      const {bytesWritten} = await file.write(
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (bytesWritten === 0) {
        throw new FileToolError('FILE_OPERATION_FAILED', '无法写入临时文件');
      }
      offset += bytesWritten;
    }
  },
  async truncate(file, length) {
    await file.truncate(length);
  },
  async sync(file) {
    await file.sync();
  },
  async chmod(file, mode) {
    await file.chmod(mode);
  },
  async link(existingPath, newPath) {
    await link(existingPath, newPath);
  },
  async rename(oldPath, newPath) {
    await rename(oldPath, newPath);
  },
  async unlink(path) {
    await unlink(path);
  },
  async close(file) {
    await file.close();
  },
};


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
  mode: number;
  parent: ResolvedPath;
  parentIdentity: FileIdentity;
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

interface ExecutedChange {
  change: FileChange;
  warning?: string;
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

async function readVerifiedFile(
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

function decodeUtf8Text(contents: Buffer): string {
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

async function resolveExistingParent(
  resolved: ResolvedPath,
  context: ToolContext,
): Promise<{parent: ResolvedPath; identity: FileIdentity}> {
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
    throw new FileToolError('PARENT_NOT_DIRECTORY', '文件的父路径不是目录');
  }
  return {parent, identity: fileIdentity(parentStat)};
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
    throw new FileToolError(
      'FILE_EXISTS',
      `文件已存在：${toWorkspacePath(resolved.relative)}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const {parent, identity: parentIdentity} = await resolveExistingParent(
    resolved,
    context,
  );
  const content = operation.content;
  assertString(content, 'content');

  return {
    type: 'add',
    path: toWorkspacePath(resolved.relative),
    resolved,
    content,
    parent,
    parentIdentity,
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
  const {contents, mode} = await readVerifiedFile(resolved, context);
  const text = decodeUtf8Text(contents);
  const expected = operation.expected;
  const replacement = operation.replacement;
  assertString(expected, 'expected');
  assertString(replacement, 'replacement');
  if (countOccurrences(text, expected) !== 1) {
    throw new FileToolError(
      'EXPECTED_NOT_UNIQUE',
      `更新片段必须且只能出现一次：${
        toWorkspacePath(resolved.relative)
      }`,
    );
  }
  const {parent, identity: parentIdentity} = await resolveExistingParent(
    resolved,
    context,
  );

  return {
    type: 'update',
    path: toWorkspacePath(resolved.relative),
    resolved,
    expected,
    replacement,
    snapshotSha256: sha256(contents),
    mode,
    parent,
    parentIdentity,
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
      `文件内容已变化，拒绝删除：${toWorkspacePath(resolved.relative)}`,
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
      if (first.type === 'update'
        && second.type === 'update'
        && (first.mode !== second.mode
          || !sameIdentity(first.parentIdentity, second.parentIdentity))) {
        throw new FileToolError('FILE_CHANGED', '文件权限或父目录在执行前已变化');
      }
    }
  }
}

async function assertParentUnchanged(
  parent: ResolvedPath,
  expectedIdentity: FileIdentity,
  context: ToolContext,
): Promise<void> {
  const current = await resolveWorkspacePath(
    context.workspace,
    parent.relative,
    'existing',
  );
  if (current.absolute !== parent.absolute) {
    throw new FileToolError('FILE_CHANGED', '文件父目录路径已变化');
  }
  const stat = await lstat(current.absolute);
  if (!stat.isDirectory()
    || !sameIdentity(expectedIdentity, fileIdentity(stat))) {
    throw new FileToolError('FILE_CHANGED', '文件父目录已变化');
  }
}

async function removeTempFile(
  path: string,
  fileOperations: PatchFileOperations,
): Promise<void> {
  try {
    await fileOperations.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function prepareTempFile(
  target: ResolvedPath,
  parent: ResolvedPath,
  parentIdentity: FileIdentity,
  mode: number,
  contents: Buffer,
  context: ToolContext,
  fileOperations: PatchFileOperations,
): Promise<ResolvedPath> {
  await assertParentUnchanged(parent, parentIdentity, context);
  const name = `.${basename(target.absolute)}.haochen-${randomUUID()}.tmp`;
  const requested = parent.relative === '.' ? name : join(parent.relative, name);
  const temp = await resolveWorkspacePath(context.workspace, requested, 'new');
  if (dirname(temp.absolute) !== parent.absolute) {
    throw new FileToolError('PATH_BOUNDARY', '临时文件必须位于目标文件同目录');
  }

  const file = await open(
    temp.absolute,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | SECURE_OPEN_FLAGS,
    mode,
  );
  try {
    await verifyOpenedRegularFile(file, temp, context);
    await fileOperations.write(file, contents);
    await fileOperations.truncate(file, contents.length);
    await fileOperations.chmod(file, mode);
    await fileOperations.sync(file);
    await fileOperations.close(file);
    return temp;
  } catch (error) {
    try {
      await file.close();
    } finally {
      await removeTempFile(temp.absolute, fileOperations);
    }
    throw error;
  }
}

async function assertAddTargetUnchanged(
  operation: PlannedAdd,
  context: ToolContext,
): Promise<void> {
  const current = await resolveWorkspacePath(
    context.workspace,
    operation.path,
    'new',
  );
  if (current.absolute !== operation.resolved.absolute) {
    throw new FileToolError('FILE_CHANGED', '新增文件路径在执行前已变化');
  }
  try {
    await lstat(current.absolute);
    throw new FileToolError('FILE_EXISTS', `文件已存在：${operation.path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await assertParentUnchanged(
    operation.parent,
    operation.parentIdentity,
    context,
  );
}

async function executeAdd(
  operation: PlannedAdd,
  context: ToolContext,
  signal: AbortSignal,
  fileOperations: PatchFileOperations,
): Promise<ExecutedChange> {
  await assertAddTargetUnchanged(operation, context);
  const temp = await prepareTempFile(
    operation.resolved,
    operation.parent,
    operation.parentIdentity,
    0o644,
    Buffer.from(operation.content, 'utf8'),
    context,
    fileOperations,
  );
  try {
    assertNotAborted(signal);
    await assertAddTargetUnchanged(operation, context);
    assertNotAborted(signal);
    await fileOperations.link(temp.absolute, operation.resolved.absolute);
  } catch (error) {
    await removeTempFile(temp.absolute, fileOperations);
    throw error;
  }

  let warning: string | undefined;
  try {
    await removeTempFile(temp.absolute, fileOperations);
  } catch (error) {
    warning = postCommitWarning(
      `新增文件 ${operation.path} 已创建`,
      error,
    );
  }
  return {
    change: {
      path: operation.path,
      type: 'add',
      additions: countLines(operation.content),
      deletions: 0,
    },
    ...(warning === undefined ? {} : {warning}),
  };
}

async function updateWasPublished(
  operation: PlannedUpdate,
  temp: ResolvedPath,
  updated: Buffer,
  context: ToolContext,
): Promise<boolean> {
  try {
    await lstat(temp.absolute);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }

  try {
    const current = await readVerifiedFile(operation.resolved, context);
    return sha256(current.contents) === sha256(updated)
      && current.mode === operation.mode;
  } catch {
    return false;
  }
}

async function executeUpdate(
  operation: PlannedUpdate,
  context: ToolContext,
  fileOperations: PatchFileOperations,
): Promise<ExecutedChange> {
  const before = await readVerifiedFile(operation.resolved, context);
  if (sha256(before.contents) !== operation.snapshotSha256
    || before.mode !== operation.mode) {
    throw new FileToolError('FILE_CHANGED', '文件内容在更新前已变化');
  }
  const beforeText = decodeUtf8Text(before.contents);
  if (countOccurrences(beforeText, operation.expected) !== 1) {
    throw new FileToolError('FILE_CHANGED', '更新片段在执行前已变化');
  }
  const updated = Buffer.from(
    beforeText.replace(operation.expected, operation.replacement),
    'utf8',
  );
  const temp = await prepareTempFile(
    operation.resolved,
    operation.parent,
    operation.parentIdentity,
    operation.mode,
    updated,
    context,
    fileOperations,
  );
  try {
    const current = await readVerifiedFile(operation.resolved, context);
    if (sha256(current.contents) !== operation.snapshotSha256
      || current.mode !== operation.mode) {
      throw new FileToolError('FILE_CHANGED', '文件内容在更新前已变化');
    }

    const text = decodeUtf8Text(current.contents);
    if (countOccurrences(text, operation.expected) !== 1) {
      throw new FileToolError(
        'FILE_CHANGED',
        '更新片段在执行前已变化',
      );
    }
    await assertParentUnchanged(
      operation.parent,
      operation.parentIdentity,
      context,
    );
    await fileOperations.rename(temp.absolute, operation.resolved.absolute);
  } catch (error) {
    if (await updateWasPublished(operation, temp, updated, context)) {
      return {
        change: {
          path: operation.path,
          type: 'update',
          additions: operation.additions,
          deletions: operation.deletions,
        },
        warning: postCommitWarning(
          `更新文件 ${operation.path} 已提交`,
          error,
        ),
      };
    }
    await removeTempFile(temp.absolute, fileOperations);
    throw error;
  }

  return {
    change: {
      path: operation.path,
      type: 'update',
      additions: operation.additions,
      deletions: operation.deletions,
    },
  };
}

async function executeDelete(
  operation: PlannedDelete,
  context: ToolContext,
  fileOperations: PatchFileOperations,
): Promise<ExecutedChange> {
  const {file, identity} = await openVerifiedRegularFile(
    operation.resolved,
    context,
    constants.O_RDONLY,
  );
  let operationFailed = false;
  let operationError: unknown;
  let committed = false;
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
    await fileOperations.unlink(current.absolute);
    committed = true;
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let closeFailed = false;
  let closeError: unknown;
  try {
    await fileOperations.close(file);
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }

  if (!committed) {
    if (operationFailed) throw operationError;
    if (closeFailed) throw closeError;
    throw new FileToolError('FILE_OPERATION_FAILED', '删除操作未完成');
  }

  return {
    change: {
      path: operation.path,
      type: 'delete',
      additions: 0,
      deletions: operation.deletions,
    },
    ...(closeFailed
      ? {
          warning: postCommitWarning(
            `删除文件 ${operation.path} 已完成`,
            closeError,
          ),
        }
      : {}),
  };
}

export async function applyPatch(
  input: ApplyPatchInput,
  context: ToolContext,
  signal: AbortSignal,
  fileOperationOverrides: Partial<PatchFileOperations> = {},
): Promise<ToolResult<ApplyPatchOutput>> {
  try {
    assertNotAborted(signal);
    const fileOperations: PatchFileOperations = {
      ...DEFAULT_PATCH_FILE_OPERATIONS,
      ...fileOperationOverrides,
    };
    await assertSecureWriteCapability(context);
    const initial = await validatePatch(input, context, signal);
    const checked = await validatePatch(input, context, signal);
    assertPlansUnchanged(initial, checked);

    const changes: FileChange[] = [];
    const warnings: string[] = [];
    for (const operation of checked) {
      assertNotAborted(signal);
      let executed: ExecutedChange;
      if (operation.type === 'add') {
        executed = await executeAdd(
          operation,
          context,
          signal,
          fileOperations,
        );
      } else if (operation.type === 'update') {
        executed = await executeUpdate(operation, context, fileOperations);
      } else {
        executed = await executeDelete(operation, context, fileOperations);
      }
      changes.push(executed.change);
      if (executed.warning !== undefined) warnings.push(executed.warning);
    }
    return success(
      `已应用 ${changes.length} 个文件补丁`
        + (warnings.length === 0 ? '' : `，含 ${warnings.length} 个后置警告`),
      {
        changes,
        ...(warnings.length === 0 ? {} : {warnings}),
      },
    );
  } catch (error) {
    return failure(error, signal);
  }
}
