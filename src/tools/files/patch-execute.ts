import {constants} from 'node:fs';
import {lstat} from 'node:fs/promises';
import {resolveWorkspacePath, type ResolvedPath} from '../../security/path-boundary.js';
import type {ToolContext} from '../types.js';
import {
  FileToolError,
  assertNotAborted,
  countLines,
  fileIdentity,
  postCommitWarning,
  sameIdentity,
  sha256,
} from './common.js';
import {
  decodeUtf8Text,
  openVerifiedRegularFile,
  readVerifiedFile,
} from './file-access.js';
import {
  assertAddTargetUnchanged,
  assertParentUnchanged,
  prepareTempFile,
  removeTempFile,
} from './patch-files.js';
import {
  countOccurrences,
  type PlannedAdd,
  type PlannedDelete,
  type PlannedUpdate,
} from './patch-plan.js';
import type {FileChange, PatchFileOperations} from './types.js';

export interface ExecutedChange {
  change: FileChange;
  warning?: string;
}

export async function executeAdd(
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

export async function executeUpdate(
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

export async function executeDelete(
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
