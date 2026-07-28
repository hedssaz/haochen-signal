import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {
  BoundaryContext,
  BoundaryDecision,
  BoundaryOperation,
} from '../types.js';
import {
  BoundaryInputError,
  decision,
  denied,
} from './common.js';
import {normalizeCommand} from './command-policy.js';
import {
  normalizeFileTool,
  normalizePatch,
  normalizeWriteFile,
} from './file-policy.js';
import {
  normalizeGitTool,
  normalizeWebTool,
} from './other-tools.js';
import type {NormalizedOperation} from './types.js';

const KNOWN_TOOLS = new Set([
  'list_files',
  'search_text',
  'read_file',
  'write_file',
  'apply_patch',
  'run_command',
  'git_status',
  'git_diff',
  'git_log',
  'web_search',
  'web_fetch',
]);

async function normalizeOperation(
  operation: BoundaryOperation,
  context: BoundaryContext,
): Promise<NormalizedOperation> {
  if (['list_files', 'search_text', 'read_file'].includes(operation.tool)) {
    return normalizeFileTool(operation.tool, operation.input, context);
  }
  if (operation.tool === 'apply_patch') {
    return normalizePatch(operation.input, context);
  }
  if (operation.tool === 'write_file') {
    return normalizeWriteFile(operation.input, context);
  }
  if (operation.tool === 'run_command') {
    return normalizeCommand(operation.input, context);
  }
  if (['git_status', 'git_diff', 'git_log'].includes(operation.tool)) {
    return normalizeGitTool(operation.tool, operation.input, context);
  }
  return normalizeWebTool(operation.tool, operation.input, context);
}

export async function classifyOperation(
  operation: BoundaryOperation,
  context: BoundaryContext,
): Promise<BoundaryDecision> {
  if (!operation
    || typeof operation !== 'object'
    || typeof operation.tool !== 'string'
    || operation.tool.length === 0
    || operation.tool.trim() !== operation.tool
    || !KNOWN_TOOLS.has(operation.tool)) {
    return denied(operation, '未知或无效的工具名');
  }
  if (!context
    || typeof context.workspace !== 'string'
    || context.workspace.length === 0) {
    return denied(operation, '工作区上下文无效');
  }

  let normalized: NormalizedOperation;
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(resolve(context.workspace));
    normalized = await normalizeOperation(operation, {
      workspace: canonicalWorkspace,
    });
  } catch (error) {
    const reason = error instanceof BoundaryInputError
      ? error.message
      : '工具输入无法安全规范化';
    return denied(operation, reason);
  }

  if (normalized.confirmReasons.length > 0) {
    return decision(
      operation.tool,
      normalized,
      'confirm',
      normalized.confirmReasons,
      canonicalWorkspace,
    );
  }
  if (normalized.reviewReasons.length > 0) {
    return decision(
      operation.tool,
      normalized,
      'review',
      normalized.reviewReasons,
      canonicalWorkspace,
    );
  }
  return decision(
    operation.tool,
    normalized,
    'allow',
    [normalized.allowReason],
    canonicalWorkspace,
  );
}
