import type {ToolContext, ToolResult} from '../types.js';
import {FileToolError, failure, success} from './common.js';
import {applyPatch} from './patch.js';
import type {
  PatchFileOperations,
  WriteFileInput,
  WriteFileOutput,
} from './types.js';

export async function writeFile(
  input: WriteFileInput,
  context: ToolContext,
  signal: AbortSignal,
  fileOperationOverrides: Partial<PatchFileOperations> = {},
): Promise<ToolResult<WriteFileOutput>> {
  const result = await applyPatch({
    operations: [{
      type: 'add',
      path: input.path,
      content: input.content,
    }],
  }, context, signal, fileOperationOverrides);
  if (!result.ok) {
    return {
      ok: false,
      summary: result.summary,
      ...(result.error === undefined ? {} : {error: result.error}),
      ...(result.warnings === undefined ? {} : {warnings: result.warnings}),
      ...(result.truncated === undefined
        ? {}
        : {truncated: result.truncated}),
    };
  }

  const change = result.data?.changes[0];
  if (change === undefined) {
    return failure(
      new FileToolError('FILE_OPERATION_FAILED', '创建文件未返回变更结果'),
      signal,
    );
  }
  return success(
    `已创建文件 ${change.path}`,
    {
      path: change.path,
      additions: change.additions,
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      ...(result.data?.warnings === undefined
        ? {}
        : {warnings: result.data.warnings}),
    },
  );
}
