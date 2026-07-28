import {createHash} from 'node:crypto';
import {
  resolveWorkspacePath,
  toPortableRelativePath,
  type WorkspacePathMode,
} from '../path-boundary.js';
import type {
  BoundaryAction,
  BoundaryContext,
  BoundaryDecision,
  BoundaryOperation,
  BoundaryRisk,
} from '../types.js';
import type {
  JsonObject,
  JsonValue,
  NormalizedOperation,
} from './types.js';

export class BoundaryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundaryInputError';
  }
}

export function inputError(message: string): never {
  throw new BoundaryInputError(message);
}

function actionRisk(action: BoundaryAction): BoundaryRisk {
  if (action === 'allow') return 'low';
  if (action === 'review') return 'medium';
  return 'high';
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
    .join(',')}}`;
}

function fingerprint(
  tool: string,
  input: JsonObject,
  normalizedScope: string[],
  workspace = '<invalid-workspace>',
): string {
  return createHash('sha256')
    .update(stableJson({workspace, tool, input, normalizedScope}))
    .digest('hex');
}

function deniedFingerprint(operation: BoundaryOperation): string {
  const tool = typeof operation?.tool === 'string'
    ? operation.tool
    : '<invalid-tool>';
  return fingerprint(tool, {invalid: true}, []);
}

export function decision(
  tool: string,
  normalized: NormalizedOperation,
  action: BoundaryAction,
  reasons: string[],
  workspace: string,
): BoundaryDecision {
  return {
    action,
    risk: actionRisk(action),
    reasons,
    normalizedScope: normalized.scope,
    fingerprint: fingerprint(tool, normalized.input, normalized.scope, workspace),
    ...(normalized.executableIdentity === undefined
      ? {}
      : {executableIdentity: normalized.executableIdentity}),
  };
}

export function denied(
  operation: BoundaryOperation,
  reason: string,
): BoundaryDecision {
  return {
    action: 'deny',
    risk: 'high',
    reasons: [reason],
    normalizedScope: [],
    fingerprint: deniedFingerprint(operation),
  };
}

export function record(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    inputError(`${field} 必须是对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    inputError(`${field} 必须是普通对象`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') inputError(`${field} 包含非法字段`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined) {
      inputError(`${field} 不能包含访问器字段`);
    }
  }
  return value as Record<string, unknown>;
}

export function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Reflect.ownKeys(value).find(
    (key) => typeof key !== 'string' || !allowedKeys.has(key),
  );
  if (unexpected !== undefined) {
    const name = typeof unexpected === 'symbol'
      ? '<symbol>'
      : unexpected;
    inputError(`${field} 包含未知字段：${name}`);
  }
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    inputError(`${field} 必须是非空字符串`);
  }
  if (value.includes('\0')) inputError(`${field} 不能包含 NUL`);
  return value;
}

export function cleanToken(value: unknown, field: string): string {
  const token = requiredString(value, field);
  if (token.trim() !== token || /[\r\n]/u.test(token)) {
    inputError(`${field} 格式无效`);
  }
  return token;
}

export function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) inputError(`${field} 必须是字符串数组`);
  const symbols = Object.getOwnPropertySymbols(value);
  const unexpected = Object.getOwnPropertyNames(value).find((key) => (
    key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)
  ));
  if (symbols.length > 0 || unexpected !== undefined) {
    inputError(`${field} 包含非法数组字段`);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) inputError(`${field} 不能是稀疏数组`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined) {
      inputError(`${field} 不能包含访问器元素`);
    }
    result.push(cleanToken(descriptor.value, `${field}[${index}]`));
  }
  return result;
}

export function strictArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    inputError(`${field} 必须是普通数组`);
  }
  const symbols = Object.getOwnPropertySymbols(value);
  const expectedNames = new Set([
    'length',
    ...Array.from({length: value.length}, (_, index) => String(index)),
  ]);
  const unexpected = Object.getOwnPropertyNames(value).find(
    (key) => !expectedNames.has(key),
  );
  if (symbols.length > 0 || unexpected !== undefined) {
    inputError(`${field} 包含非法数组字段`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) inputError(`${field} 不能是稀疏数组`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined) {
      inputError(`${field} 不能包含访问器元素`);
    }
    result.push(descriptor.value);
  }
  return result;
}

export function optionalInteger(
  value: unknown,
  field: string,
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum) {
    inputError(`${field} 必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return value as number;
}

export function optionalBoolean(
  value: unknown,
  field: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') inputError(`${field} 必须是布尔值`);
  return value;
}

function workspacePath(path: string): string {
  return toPortableRelativePath(path);
}

export async function normalizePath(
  context: BoundaryContext,
  requested: unknown,
  mode: WorkspacePathMode,
  field = 'path',
): Promise<string> {
  const path = cleanToken(requested, field);
  try {
    const resolved = await resolveWorkspacePath(context.workspace, path, mode);
    return workspacePath(resolved.relative);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('工作区外') || message.includes('符号链接')) {
      throw new BoundaryInputError(`${field} 超出真实工作区边界`);
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new BoundaryInputError(`${field} 指向的路径不存在`);
    }
    throw new BoundaryInputError(`${field} 无法安全解析`);
  }
}

export function sensitivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const leaf = segments.at(-1) ?? '';
  return segments.some((segment) => [
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    '.docker',
    'keychains',
  ].includes(segment))
    || segments.some((segment, index) => (
      segment === '.config' && segments[index + 1] === 'gh'
    ))
    || /^\.env(?:\.|$)/u.test(leaf)
    || /(?:^|[._-])credentials?(?:[._-]|$)/u.test(leaf)
    || [
      '.git-credentials',
      '.npmrc',
      '.pypirc',
      '.netrc',
      'credentials',
      'id_rsa',
      'id_ed25519',
      'known_hosts',
    ].includes(leaf)
    || leaf.endsWith('.pem')
    || leaf.endsWith('.key');
}
