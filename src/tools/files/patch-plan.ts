import {lstat, realpath} from 'node:fs/promises';
import {dirname, relative} from 'node:path';
import {
  resolveWorkspacePath,
  type ResolvedPath,
} from '../../security/path-boundary.js';
import type {ToolContext} from '../types.js';
import {
  FileToolError,
  assertNotAborted,
  assertString,
  countLines,
  fileIdentity,
  sameIdentity,
  sha256,
  toWorkspacePath,
} from './common.js';
import {
  decodeUtf8Text,
  readVerifiedFile,
  type FileIdentity,
} from './file-access.js';
import type {
  ApplyPatchInput,
  PatchOperation,
} from './types.js';

export interface PlannedAdd {
  type: 'add';
  path: string;
  resolved: ResolvedPath;
  content: string;
  parent: ResolvedPath;
  parentIdentity: FileIdentity;
}

export interface PlannedUpdate {
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

export interface PlannedDelete {
  type: 'delete';
  path: string;
  resolved: ResolvedPath;
  snapshotSha256: string;
  deletions: number;
}

export type PlannedOperation = PlannedAdd | PlannedUpdate | PlannedDelete;


export function countOccurrences(contents: string, expected: string): number {
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

export async function validatePatch(
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

export function assertPlansUnchanged(
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
