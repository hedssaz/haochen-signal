import {createHash} from 'node:crypto';
import type {WorkspacePathMode} from '../path-boundary.js';
import type {BoundaryContext} from '../types.js';
import {
  inputError,
  normalizePath,
  onlyKeys,
  optionalInteger,
  record,
  requiredString,
  sensitivePath,
  strictArray,
} from './common.js';
import type {
  JsonObject,
  NormalizedOperation,
} from './types.js';

const DEFAULT_READ_LINES = 400;
const DEFAULT_READ_CHARACTERS = 65_536;
const DEFAULT_SEARCH_MATCHES = 200;

export async function normalizeFileTool(
  tool: string,
  value: unknown,
  context: BoundaryContext,
): Promise<NormalizedOperation> {
  const input = record(value, `${tool} input`);
  if (tool === 'list_files') {
    onlyKeys(input, ['path'], `${tool} input`);
    const path = await normalizePath(
      context,
      input.path ?? '.',
      'existing',
    );
    return {
      input: {path},
      scope: [`list:${path}`],
      confirmReasons: sensitivePath(path) ? ['请求列出凭据或敏感配置路径'] : [],
      reviewReasons: [],
      allowReason: '操作只读取工作区内的文件列表',
    };
  }
  if (tool === 'search_text') {
    onlyKeys(input, ['query', 'path', 'maxMatches'], `${tool} input`);
    const query = requiredString(input.query, 'query');
    const path = await normalizePath(
      context,
      input.path ?? '.',
      'existing',
    );
    const maxMatches = optionalInteger(
      input.maxMatches,
      'maxMatches',
      DEFAULT_SEARCH_MATCHES,
      1,
    );
    return {
      input: {query, path, maxMatches},
      scope: [`search:${path}`],
      confirmReasons: sensitivePath(path) ? ['请求搜索凭据或敏感配置路径'] : [],
      reviewReasons: [],
      allowReason: '操作只搜索工作区内的文本',
    };
  }

  onlyKeys(
    input,
    ['path', 'startLine', 'endLine', 'startCharacter', 'maxCharacters'],
    `${tool} input`,
  );
  const path = await normalizePath(context, input.path, 'existing');
  const startLine = optionalInteger(input.startLine, 'startLine', 1, 1);
  const endLine = optionalInteger(
    input.endLine,
    'endLine',
    startLine + DEFAULT_READ_LINES - 1,
    startLine,
  );
  const startCharacter = optionalInteger(
    input.startCharacter,
    'startCharacter',
    0,
    0,
  );
  const maxCharacters = optionalInteger(
    input.maxCharacters,
    'maxCharacters',
    DEFAULT_READ_CHARACTERS,
    1,
    DEFAULT_READ_CHARACTERS,
  );
  return {
    input: {path, startLine, endLine, startCharacter, maxCharacters},
    scope: [`read:${path}`],
    confirmReasons: sensitivePath(path) ? ['请求读取凭据或敏感配置文件'] : [],
    reviewReasons: [],
    allowReason: '操作只读取工作区内的普通文件',
  };
}

export async function normalizePatch(
  value: unknown,
  context: BoundaryContext,
): Promise<NormalizedOperation> {
  const input = record(value, 'apply_patch input');
  onlyKeys(input, ['operations'], 'apply_patch input');
  const rawOperations = strictArray(input.operations, 'operations');
  if (rawOperations.length === 0) {
    inputError('operations 必须是非空数组');
  }

  const operations: JsonObject[] = [];
  const scope: string[] = [];
  const confirmReasons: string[] = [];
  let requiresReview = rawOperations.length > 1;
  const seen = new Set<string>();
  for (let index = 0; index < rawOperations.length; index += 1) {
    const operation = record(
      rawOperations[index],
      `operations[${index}]`,
    );
    const type = requiredString(operation.type, `operations[${index}].type`);
    if (!['add', 'update', 'delete'].includes(type)) {
      inputError(`operations[${index}].type 未知`);
    }
    const mode: WorkspacePathMode = type === 'add' ? 'new' : 'existing';
    const path = await normalizePath(
      context,
      operation.path,
      mode,
      `operations[${index}].path`,
    );
    if (seen.has(path)) inputError('补丁不能重复操作同一路径');
    seen.add(path);

    if (type === 'add') {
      onlyKeys(operation, ['type', 'path', 'content'], `operations[${index}]`);
      const content = typeof operation.content === 'string'
        ? operation.content
        : inputError(`operations[${index}].content 必须是字符串`);
      operations.push({type, path, content});
      requiresReview = true;
    } else if (type === 'update') {
      onlyKeys(
        operation,
        ['type', 'path', 'expected', 'replacement'],
        `operations[${index}]`,
      );
      const expected = requiredString(
        operation.expected,
        `operations[${index}].expected`,
      );
      if (typeof operation.replacement !== 'string') {
        inputError(`operations[${index}].replacement 必须是字符串`);
      }
      operations.push({
        type,
        path,
        expected,
        replacement: operation.replacement,
      });
    } else {
      onlyKeys(operation, ['type', 'path', 'sha256'], `operations[${index}]`);
      const sha256 = requiredString(
        operation.sha256,
        `operations[${index}].sha256`,
      ).toLowerCase();
      operations.push({type, path, sha256});
      requiresReview = true;
    }
    scope.push(`${type}:${path}`);
    if (sensitivePath(path)) {
      confirmReasons.push('补丁涉及凭据或敏感配置文件');
    }
  }

  return {
    input: {operations},
    scope,
    confirmReasons: [...new Set(confirmReasons)],
    reviewReasons: requiresReview
      ? ['工作区内新增、删除、移动或批量补丁需要审查']
      : [],
    allowReason: '补丁仅对一个工作区现有文件做结构化更新',
  };
}

export async function normalizeWriteFile(
  value: unknown,
  context: BoundaryContext,
): Promise<NormalizedOperation> {
  const input = record(value, 'write_file input');
  onlyKeys(input, ['path', 'content'], 'write_file input');
  const path = await normalizePath(context, input.path, 'new');
  if (typeof input.content !== 'string') {
    inputError('content 必须是字符串');
  }
  const content = input.content;
  const digest = createHash('sha256').update(content).digest('hex');
  return {
    input: {path, content},
    scope: [`write:${path}:sha256:${digest}`],
    confirmReasons: sensitivePath(path)
      ? ['创建目标是凭据或敏感配置文件']
      : [],
    reviewReasons: ['工作区内创建新文件需要审查'],
    allowReason: '工作区新文件创建已完成审查',
  };
}
