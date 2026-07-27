import type {ToolContext, ToolResult} from '../types.js';
import {
  assertNotAborted,
  failure,
  success,
} from './common.js';
import {
  executeAdd,
  executeDelete,
  executeUpdate,
  type ExecutedChange,
} from './patch-execute.js';
import {
  DEFAULT_PATCH_FILE_OPERATIONS,
  assertSecureWriteCapability,
} from './patch-files.js';
import {
  assertPlansUnchanged,
  validatePatch,
} from './patch-plan.js';
import type {
  ApplyPatchInput,
  ApplyPatchOutput,
  FileChange,
  PatchFileOperations,
} from './types.js';

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
