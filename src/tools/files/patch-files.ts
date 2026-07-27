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
import {basename, dirname, join} from 'node:path';
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
import {
  DARWIN_NO_FOLLOW_ANY,
  SECURE_OPEN_FLAGS,
  verifyOpenedRegularFile,
  type FileIdentity,
} from './file-access.js';
import type {PlannedAdd} from './patch-plan.js';
import type {PatchFileOperations} from './types.js';

export const DEFAULT_PATCH_FILE_OPERATIONS: PatchFileOperations = {
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

export async function assertSecureWriteCapability(
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

export async function assertParentUnchanged(
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

export async function removeTempFile(
  path: string,
  fileOperations: PatchFileOperations,
): Promise<void> {
  try {
    await fileOperations.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function prepareTempFile(
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

export async function assertAddTargetUnchanged(
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
