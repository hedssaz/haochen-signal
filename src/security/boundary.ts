import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {isIP} from 'node:net';
import {basename, isAbsolute, relative, resolve, sep, win32} from 'node:path';
import {resolveExecutableIdentity} from './executable-identity.js';
import {
  resolveWorkspacePath,
  toPortableRelativePath,
  type WorkspacePathMode,
} from './path-boundary.js';
import type {
  BoundaryAction,
  BoundaryContext,
  BoundaryDecision,
  BoundaryOperation,
  BoundaryRisk,
} from './types.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_READ_LINES = 400;
const DEFAULT_READ_CHARACTERS = 65_536;
const DEFAULT_SEARCH_MATCHES = 200;
const DEFAULT_GIT_LOG_LIMIT = 20;

const KNOWN_TOOLS = new Set([
  'list_files',
  'search_text',
  'read_file',
  'apply_patch',
  'run_command',
  'git_status',
  'git_diff',
  'git_log',
  'web_search',
  'web_fetch',
]);

const SHELL_EXECUTABLES = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
]);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue};
type JsonObject = {[key: string]: JsonValue};

interface NormalizedOperation {
  input: JsonObject;
  scope: string[];
  confirmReasons: string[];
  reviewReasons: string[];
  allowReason: string;
  executableIdentity?: string;
}

class BoundaryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundaryInputError';
  }
}

function inputError(message: string): never {
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

function decision(
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

function denied(
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

function record(value: unknown, field: string): Record<string, unknown> {
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

function onlyKeys(
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    inputError(`${field} 必须是非空字符串`);
  }
  if (value.includes('\0')) inputError(`${field} 不能包含 NUL`);
  return value;
}

function cleanToken(value: unknown, field: string): string {
  const token = requiredString(value, field);
  if (token.trim() !== token || /[\r\n]/u.test(token)) {
    inputError(`${field} 格式无效`);
  }
  return token;
}

function stringArray(value: unknown, field: string): string[] {
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

function strictArray(value: unknown, field: string): unknown[] {
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

function optionalInteger(
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

function optionalBoolean(
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

async function normalizePath(
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

function sensitivePath(path: string): boolean {
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

function normalizedExecutable(command: string): string {
  const portable = command.replaceAll('\\', '/');
  return basename(portable).replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase();
}

function exactArgs(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((argument, index) => argument === expected[index]);
}

function isWhitelistedCommand(
  command: string,
  args: string[],
  argsWereExplicit: boolean,
  shell: boolean,
  hasTrustedExecutableIdentity: boolean,
): boolean {
  if (!argsWereExplicit || shell || !hasTrustedExecutableIdentity) return false;
  if (command === 'npm') {
    return exactArgs(args, ['test'])
      || exactArgs(args, ['run', 'test'])
      || exactArgs(args, ['run', 'typecheck'])
      || exactArgs(args, ['run', 'lint'])
      || exactArgs(args, ['run', 'build']);
  }
  if (command === 'npx') {
    return exactArgs(args, ['vitest', 'run'])
      || exactArgs(args, ['tsc', '--noEmit']);
  }
  return false;
}

function unwrapCommand(
  command: string,
  args: string[],
): {
  command: string;
  args: string[];
  envSplitString: boolean;
  commands: string[];
} {
  let effectiveCommand = normalizedExecutable(command);
  let effectiveArgs = [...args];
  let envSplitString = false;
  const commands = [effectiveCommand];

  while (['env', 'command', 'exec', 'nice', 'nohup'].includes(effectiveCommand)
    && effectiveArgs.length > 0) {
    let index = 0;
    if (effectiveCommand === 'env') {
      while (index < effectiveArgs.length) {
        const token = effectiveArgs[index] ?? '';
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-S'
          || token === '--split-string'
          || token.startsWith('--split-string=')
          || (token.startsWith('-S') && token.length > 2)) {
          envSplitString = true;
          return {
            command: effectiveCommand,
            args: effectiveArgs,
            envSplitString,
            commands,
          };
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)
          || token === '-i'
          || token === '--ignore-environment') {
          index += 1;
          continue;
        }
        if (token === '-u' || token === '--unset') {
          index += 2;
          continue;
        }
        if (token.startsWith('--unset=')) {
          index += 1;
          continue;
        }
        break;
      }
    } else if (effectiveCommand === 'nice') {
      while (index < effectiveArgs.length
        && (effectiveArgs[index] ?? '').startsWith('-')) {
        index += 1;
      }
    }

    const next = effectiveArgs[index];
    if (next === undefined) break;
    effectiveCommand = normalizedExecutable(next);
    commands.push(effectiveCommand);
    effectiveArgs = effectiveArgs.slice(index + 1);
  }
  return {command: effectiveCommand, args: effectiveArgs, envSplitString, commands};
}

function gitSubcommand(args: string[]): {name?: string; rest: string[]} {
  const optionsWithValue = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
  ]);
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? '';
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) break;
    const optionName = token.split('=', 1)[0] ?? token;
    index += optionsWithValue.has(optionName) && !token.includes('=') ? 2 : 1;
  }
  const name = args[index]?.toLowerCase();
  return {name, rest: args.slice(index + 1)};
}

function containsShellHazard(script: string, pattern: RegExp): boolean {
  return pattern.test(script);
}

function dequoteShellText(script: string): string {
  return script
    .replace(/\\([^\r\n])/gu, '$1')
    .replace(/['"]/gu, '');
}

function commandConfirmationReasons(
  command: string,
  args: string[],
  shell: boolean,
): string[] {
  const reasons: string[] = [];
  const effective = unwrapCommand(command, args);
  const rawText = [command, ...args].join(' ');
  const shellSemantics = usesShellInterpreter(command, args, shell);
  const allText = shellSemantics
    ? dequoteShellText(rawText)
    : rawText;
  const lowerArgs = effective.args.map((argument) => argument.toLowerCase());

  if (shellSemantics) {
    reasons.push('Shell 命令语义无法由确定性边界完整证明');
  }

  if (effective.commands.includes('env')) {
    reasons.push('run_command 中的 env 包装需要用户确认');
  }
  if (effective.commands.includes('curl')) {
    reasons.push('run_command 中的 curl 网络操作需要用户确认');
  }
  if (effective.commands.includes('git')) {
    reasons.push('run_command 中的 Git 操作需要用户确认');
  }

  if (effective.command === 'sudo'
    || containsShellHazard(
      allText,
      /(?:^|[^A-Za-z0-9_])sudo(?:$|[^A-Za-z0-9_])/iu,
    )) {
    reasons.push('命令请求 sudo 或系统权限');
  }

  if (effective.command === 'git') {
    const git = gitSubcommand(effective.args);
    if (git.name === 'reset'
      && git.rest.some((argument) => /^--hard(?:=|$)/iu.test(argument))) {
      reasons.push('命令会执行破坏性 Git reset --hard');
    }
    if (git.name === 'clean'
      && git.rest.some((argument) => (
        /^-[a-z]*f[a-z]*$/iu.test(argument)
        || /^--force(?:=|$)/iu.test(argument)
      ))) {
      reasons.push('命令会强制清理 Git 工作区');
    }
    if (git.name === 'push') {
      reasons.push('命令会向外部 Git 远端发布内容');
    }
    if (git.name === 'send-pack') {
      reasons.push('命令会直接向外部 Git 远端发送引用');
    }
  }

  if (containsShellHazard(
    allText,
    /(?:^|[\s;&|])git(?:\s|$)[^;&|\r\n]*?\breset\s+--hard(?:=|\s|$)/iu,
  )) {
    reasons.push('Shell 内容包含破坏性 Git reset --hard');
  }
  if (containsShellHazard(
    allText,
    /(?:^|[\s;&|])git(?:\s|$)[^;&|\r\n]*?\bpush(?:\s|$)/iu,
  )) {
    reasons.push('Shell 内容会向外部 Git 远端发布内容');
  }

  if ((effective.command === 'npm' && lowerArgs[0] === 'publish')
    || (effective.command === 'yarn' && lowerArgs[0] === 'npm'
      && lowerArgs[1] === 'publish')
    || (effective.command === 'cargo' && lowerArgs[0] === 'publish')
    || (effective.command === 'twine' && lowerArgs[0] === 'upload')) {
    reasons.push('命令会向外部服务发布包');
  }

  const uploadFlags = new Set([
    '--data',
    '--data-ascii',
    '--data-raw',
    '--data-binary',
    '--data-urlencode',
    '--form',
    '--form-string',
    '--json',
    '--upload-file',
  ]);
  if (effective.command === 'curl'
    && effective.args.some((argument) => (
      uploadFlags.has(argument.toLowerCase())
      || /^--(?:data(?:-ascii|-binary|-raw|-urlencode)?|form(?:-string)?|json|upload-file)=/iu
        .test(argument)
      || /^-[A-Za-z]*(?:d|F|T)/u.test(argument)
    ))) {
    reasons.push('命令可能向外部服务发送项目内容');
  }
  if (['scp', 'sftp'].includes(effective.command)
    || (effective.command === 'rsync'
      && effective.args.some((argument) => /^[^/]+@[^:]+:/u.test(argument)))
    || effective.command === 'ssh') {
    reasons.push('命令可能向外部主机发布数据或操作');
  }
  if (effective.command === 'gh'
    && ['api', 'pr', 'issue', 'release', 'repo'].includes(
      lowerArgs[0] ?? '',
    )) {
    reasons.push('命令可能修改 GitHub 外部状态');
  }

  if (effective.command === 'printenv'
    || (effective.command === 'env' && effective.args.length === 0)
    || effective.command === 'security'
    || effective.command === 'pass'
    || effective.command === 'op'
    || containsShellHazard(
      allText,
      /(?:^|[\s;&|])(?:printenv|security|pass|op)(?:\s|$)/iu,
    )
    || args.some((argument) => sensitivePath(argument))) {
    reasons.push('命令可能读取凭据或敏感配置');
  }

  return [...new Set(reasons)];
}

function dependencyInstall(
  command: string,
  args: string[],
): boolean {
  const effective = unwrapCommand(command, args);
  const lowerArgs = effective.args.map((argument) => argument.toLowerCase());
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(effective.command)) {
    return ['add', 'install', 'i', 'update', 'upgrade'].includes(
      lowerArgs[0] ?? '',
    );
  }
  if (['pip', 'pip3', 'poetry', 'uv'].includes(effective.command)) {
    return ['add', 'install', 'sync'].includes(lowerArgs[0] ?? '');
  }
  if (effective.command === 'python' || effective.command === 'python3') {
    return lowerArgs[0] === '-m'
      && lowerArgs[1] === 'pip'
      && lowerArgs[2] === 'install';
  }
  return (effective.command === 'cargo' && lowerArgs[0] === 'add')
    || (effective.command === 'go' && lowerArgs[0] === 'get');
}

function commandReviewReasons(
  command: string,
  args: string[],
  argsWereExplicit: boolean,
  shell: boolean,
  hasTrustedExecutableIdentity: boolean,
): string[] {
  const reasons: string[] = [];
  const executable = normalizedExecutable(command);
  const effective = unwrapCommand(command, args);
  const lowerTokens = [effective.command, ...effective.args]
    .map((token) => token.toLowerCase());

  if (dependencyInstall(command, args)) {
    reasons.push('命令会安装或更新依赖');
  }
  if (usesShellInterpreter(command, args, shell)) {
    reasons.push('命令启用了 Shell 解释或复杂 Shell 参数');
  }
  if ([command, ...args].some((token) => /(?:^|[^|])\|{1,2}|[;&<>`]/u.test(token))) {
    reasons.push('命令包含管道、重定向或后台 Shell 语法');
  }
  if (executable === 'nohup'
    || lowerTokens.some((token) => (
      token.includes('--port')
      || token.includes('listen')
      || token.includes('serve')
      || token.includes('start')
      || token === '--watch'
      || token === '--detach'
      || token === '&'
    ))) {
    reasons.push('命令可能启动长期进程、后台任务或端口监听');
  }
  if (!isWhitelistedCommand(
    command,
    args,
    argsWereExplicit,
    shell,
    hasTrustedExecutableIdentity,
  )) {
    reasons.push('命令不在固定测试、检查或构建白名单内');
  }
  return [...new Set(reasons)];
}

function usesShellInterpreter(
  command: string,
  args: string[],
  shell: boolean,
): boolean {
  const effective = unwrapCommand(command, args);
  return shell
    || effective.envSplitString
    || SHELL_EXECUTABLES.has(effective.command);
}

function candidatePath(argument: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(argument)) return undefined;
  if (argument.startsWith('file:')) return argument.slice('file:'.length);
  const equals = argument.indexOf('=');
  const value = equals === -1 ? argument : argument.slice(equals + 1);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return undefined;
  if (value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('.\\')
    || value.startsWith('..\\')
    || value.startsWith('~/')
    || value.startsWith('~\\')
    || /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith('\\\\')) {
    return value;
  }
  if (!/\s/u.test(value)
    && value.includes('/')
    && !value.startsWith('@')) {
    return value;
  }
  return undefined;
}

function embeddedPathCandidates(argument: string): string[] {
  const candidates: string[] = [];
  const pattern = /(?:^|[\s'"`;&|<>])((?:\.\.?[\\/]|~[\\/]|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s'"`;&|<>]*)/gu;
  let match = pattern.exec(argument);
  while (match !== null) {
    const candidate = match[1];
    if (candidate !== undefined) candidates.push(candidate);
    match = pattern.exec(argument);
  }
  return candidates;
}

function commandUrlCandidates(argument: string): string[] {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(argument)) return [argument];
  return argument.match(
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"`;&|<>]+/gu,
  ) ?? [];
}

function compactCommandPathCandidates(
  command: string,
  args: string[],
): string[] {
  const effective = unwrapCommand(command, args);
  const candidates: string[] = [];
  if (effective.commands.includes('env')) {
    for (const argument of args) {
      const match = /^-C(.+)$/u.exec(argument);
      if (match?.[1] !== undefined) candidates.push(match[1]);
    }
  }
  if (effective.command === 'git') {
    for (const argument of effective.args) {
      const match = /^-C(.+)$/u.exec(argument);
      if (match?.[1] !== undefined) candidates.push(match[1]);
    }
  }
  if (effective.command === 'curl') {
    for (const argument of effective.args) {
      const match = /^-[A-Za-z]*T(.+)$/u.exec(argument);
      if (match?.[1] !== undefined && match[1] !== '-') {
        candidates.push(match[1]);
      }
    }
  }
  return candidates;
}

async function normalizeCommandTargets(
  command: string,
  args: string[],
  context: BoundaryContext,
  shellSemantics: boolean,
  includeCommandText: boolean,
): Promise<string[]> {
  const scope: string[] = [];
  const seen = new Set<string>();
  const targetArguments = includeCommandText ? [command, ...args] : args;
  for (const argument of targetArguments) {
    const texts = shellSemantics
      ? [argument, dequoteShellText(argument)]
      : [argument];
    for (const text of texts) {
      for (const rawUrl of commandUrlCandidates(text)) {
        const url = normalizePublicUrl(rawUrl);
        const target = `url:${url}`;
        if (!seen.has(target)) {
          seen.add(target);
          scope.push(target);
        }
      }
    }
    const candidates = texts.flatMap((text) => {
      const direct = candidatePath(text);
      return direct === undefined ? embeddedPathCandidates(text) : [direct];
    });
    for (const candidate of candidates) {
      if (candidate.startsWith('~/')
        || candidate.startsWith('~\\')
        || (win32.isAbsolute(candidate) && !isAbsolute(candidate))) {
        inputError('命令参数包含工作区外路径');
      }
      const path = await normalizePath(
        context,
        candidate,
        'new',
        '命令参数路径',
      );
      const target = `path:${path}`;
      if (!seen.has(target)) {
        seen.add(target);
        scope.push(target);
      }
    }
  }
  for (const candidate of compactCommandPathCandidates(command, args)) {
    const path = await normalizePath(
      context,
      candidate,
      'new',
      '命令紧凑参数路径',
    );
    const target = `path:${path}`;
    if (!seen.has(target)) {
      seen.add(target);
      scope.push(target);
    }
  }
  return scope;
}

function curlResolveAddresses(specification: string): string[] {
  let value = specification;
  if (value.startsWith('+')) value = value.slice(1);
  if (value.startsWith('-')) return [];

  let hostEnd: number;
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket === -1 || value[closingBracket + 1] !== ':') {
      inputError('curl --resolve 主机覆盖格式无效');
    }
    hostEnd = closingBracket + 1;
  } else {
    hostEnd = value.indexOf(':');
    if (hostEnd <= 0) inputError('curl --resolve 主机覆盖格式无效');
  }
  const portEnd = value.indexOf(':', hostEnd + 1);
  if (portEnd === -1 || portEnd === value.length - 1) {
    inputError('curl --resolve 主机覆盖格式无效');
  }
  const addresses = value.slice(portEnd + 1).split(',');
  if (addresses.some((address) => address.length === 0)) {
    inputError('curl --resolve 主机覆盖格式无效');
  }
  return addresses.map((address) => {
    const normalized = normalizeIpAddress(address);
    if (normalized === undefined) {
      inputError('curl --resolve 地址必须是 IP 字面量');
    }
    return normalized;
  });
}

function normalizeIpAddress(value: string): string | undefined {
  const literal = value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
  const directVersion = isIP(literal);
  if (directVersion !== 0) return literal.toLowerCase();
  if (literal.includes(':')) return undefined;

  try {
    const parsed = new URL(`http://${literal}`);
    if (parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== '') {
      return undefined;
    }
    const hostname = parsed.hostname.startsWith('[')
      && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    return isIP(hostname) === 0 ? undefined : hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function curlConnectToAddress(specification: string): string | undefined {
  let position = 0;
  const readHost = (): string | undefined => {
    if (specification[position] === '[') {
      const closing = specification.indexOf(']', position + 1);
      if (closing === -1 || specification[closing + 1] !== ':') {
        inputError('curl --connect-to 主机覆盖格式无效');
      }
      const host = specification.slice(position + 1, closing);
      position = closing + 2;
      return host;
    }
    const separator = specification.indexOf(':', position);
    if (separator === -1) inputError('curl --connect-to 主机覆盖格式无效');
    const host = specification.slice(position, separator);
    position = separator + 1;
    return host;
  };
  const readPort = (): void => {
    const separator = specification.indexOf(':', position);
    if (separator === -1) inputError('curl --connect-to 主机覆盖格式无效');
    if (separator === position) inputError('curl --connect-to 主机覆盖格式无效');
    position = separator + 1;
  };

  readHost();
  readPort();
  const destination = readHost();
  if (destination === undefined || position >= specification.length) {
    inputError('curl --connect-to 主机覆盖格式无效');
  }
  if (specification.slice(position).length === 0) {
    inputError('curl --connect-to 主机覆盖格式无效');
  }
  return destination === '' ? undefined : destination;
}

function curlOptionSpecifications(
  args: string[],
  option: '--resolve' | '--connect-to',
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument === option) {
      const value = args[index + 1];
      if (value === undefined) inputError(`curl ${option} 缺少主机覆盖值`);
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${option}=`)) {
      values.push(argument.slice(option.length + 1));
    }
  }
  return values;
}

function shellCurlArguments(command: string, args: string[]): string[][] {
  const sets: string[][] = [];
  for (const value of [command, ...args]) {
    const text = dequoteShellText(value);
    if (/(?:^|[\s;&|])curl(?:\s|$)/u.test(text)) {
      sets.push(text.split(/\s+/u));
    }
  }
  return sets;
}

function envSplitCurlArguments(command: string, args: string[]): string[][] {
  if (!unwrapCommand(command, args).commands.includes('env')) return [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    let payload: string | undefined;
    let remaining: string[];
    if (argument === '-S' || argument === '--split-string') {
      payload = args[index + 1];
      remaining = args.slice(index + 2);
    } else if (argument.startsWith('--split-string=')) {
      payload = argument.slice('--split-string='.length);
      remaining = args.slice(index + 1);
    } else if (argument.startsWith('-S') && argument.length > 2) {
      payload = argument.slice(2);
      remaining = args.slice(index + 1);
    } else {
      continue;
    }
    if (payload === undefined) return [];

    const tokens = [
      ...dequoteShellText(payload).trim().split(/\s+/u),
      ...remaining,
    ];
    if (normalizedExecutable(tokens[0] ?? '') === 'curl') {
      return [tokens.slice(1)];
    }
    return [];
  }
  return [];
}

function curlArgumentSets(
  command: string,
  args: string[],
  shellSemantics: boolean,
): string[][] {
  const effective = unwrapCommand(command, args);
  const sets = effective.command === 'curl' ? [effective.args] : [];
  if (shellSemantics) sets.push(...shellCurlArguments(command, args));
  sets.push(...envSplitCurlArguments(command, args));
  return sets;
}

function curlFilePathCandidates(
  command: string,
  args: string[],
  shellSemantics: boolean,
): string[] {
  const candidates: string[] = [];
  for (const curlArgs of curlArgumentSets(command, args, shellSemantics)) {
    for (let index = 0; index < curlArgs.length; index += 1) {
      const argument = curlArgs[index] ?? '';
      const uploadMatch = /^--upload-file=(.+)$/u.exec(argument)
        ?? /^-[A-Za-z]*T(.+)$/u.exec(argument);
      if (uploadMatch?.[1] !== undefined && uploadMatch[1] !== '-') {
        candidates.push(uploadMatch[1]);
      } else if (argument === '--upload-file') {
        const path = curlArgs[index + 1];
        if (path !== undefined && path !== '-') candidates.push(path);
        index += 1;
      }

      const filePattern = /@((?:[^@\s'"`;&|<>])+)/gu;
      let match = filePattern.exec(argument);
      while (match !== null) {
        if (match[1] !== undefined && match[1] !== '-') {
          candidates.push(match[1]);
        }
        match = filePattern.exec(argument);
      }
    }
  }
  return [...new Set(candidates)];
}

async function normalizeCurlFileTargets(
  command: string,
  args: string[],
  context: BoundaryContext,
  shellSemantics: boolean,
): Promise<string[]> {
  const targets: string[] = [];
  for (const candidate of curlFilePathCandidates(
    command,
    args,
    shellSemantics,
  )) {
    const path = await normalizePath(
      context,
      candidate,
      'new',
      'curl 文件参数路径',
    );
    targets.push(`path:${path}`);
  }
  return targets;
}

function normalizeCommandNetworkOverrides(
  command: string,
  args: string[],
  shellSemantics: boolean,
): string[] {
  const scope: string[] = [];
  for (const curlArgs of curlArgumentSets(command, args, shellSemantics)) {
    for (const specification of curlOptionSpecifications(curlArgs, '--resolve')) {
      for (const address of curlResolveAddresses(specification)) {
        const version = isIP(address);
        if (version === 0) inputError('curl --resolve 地址必须是 IP 字面量');
        if ((version === 4 && !ipv4IsPublic(address))
          || (version === 6 && !ipv6IsPublic(address))) {
          inputError('curl --resolve 目标位于本机、内网或保留地址');
        }
        scope.push(`network:${address.toLowerCase()}`);
      }
    }
    for (const specification of curlOptionSpecifications(curlArgs, '--connect-to')) {
      const address = curlConnectToAddress(specification);
      if (address === undefined) continue;
      const normalizedAddress = normalizeIpAddress(address);
      const version = normalizedAddress === undefined ? 0 : isIP(normalizedAddress);
      if (version === 0 && nonPublicHostname(address)) {
        inputError('curl --connect-to 目标位于本机、内网或保留地址');
      }
      if ((version === 4 && !ipv4IsPublic(normalizedAddress ?? address))
        || (version === 6 && !ipv6IsPublic(normalizedAddress ?? address))) {
        inputError('curl --connect-to 目标位于本机、内网或保留地址');
      }
      if (normalizedAddress !== undefined) {
        scope.push(`network:${normalizedAddress}`);
      }
    }
  }
  return [...new Set(scope)];
}

async function normalizeCommand(
  value: unknown,
  context: BoundaryContext,
): Promise<NormalizedOperation> {
  const input = record(value, 'run_command input');
  onlyKeys(
    input,
    ['command', 'args', 'cwd', 'shell', 'timeoutMs', 'maxOutputBytes'],
    'run_command input',
  );
  const command = cleanToken(input.command, 'command');
  const argsWereExplicit = input.args !== undefined;
  const args = input.args === undefined ? [] : stringArray(input.args, 'args');
  const shell = optionalBoolean(input.shell, 'shell', false);
  const timeoutMs = optionalInteger(
    input.timeoutMs,
    'timeoutMs',
    DEFAULT_COMMAND_TIMEOUT_MS,
    0,
    2_147_483_647,
  );
  const maxOutputBytes = optionalInteger(
    input.maxOutputBytes,
    'maxOutputBytes',
    DEFAULT_COMMAND_OUTPUT_BYTES,
    0,
  );
  const cwd = await normalizePath(
    context,
    input.cwd ?? '.',
    'existing',
    'cwd',
  );
  const absoluteCwd = resolve(context.workspace, cwd);
  const executableIdentity = shell
    ? undefined
    : await resolveExecutableIdentity(
      command,
      absoluteCwd,
      process.env,
      process.platform,
    );
  const executableRelativeToWorkspace = executableIdentity === undefined
    ? undefined
    : relative(context.workspace, executableIdentity);
  const executableIsInsideWorkspace = executableRelativeToWorkspace !== undefined
    && (
      executableRelativeToWorkspace === ''
      || (
        !isAbsolute(executableRelativeToWorkspace)
        && executableRelativeToWorkspace !== '..'
        && !executableRelativeToWorkspace.startsWith(`..${sep}`)
      )
    );
  const hasTrustedExecutableIdentity = executableIdentity !== undefined
    && !executableIsInsideWorkspace;
  const shellSemantics = usesShellInterpreter(command, args, shell);
  const targets = await normalizeCommandTargets(
    command,
    args,
    context,
    shellSemantics,
    shell,
  );
  const curlFileTargets = await normalizeCurlFileTargets(
    command,
    args,
    context,
    shellSemantics,
  );
  const networkOverrides = normalizeCommandNetworkOverrides(
    command,
    args,
    shellSemantics,
  );

  const confirmReasons = commandConfirmationReasons(command, args, shell);
  if (targets.some((target) => (
    target.startsWith('path:') && sensitivePath(target.slice('path:'.length))
  ))) {
    confirmReasons.push('命令可能读取凭据或敏感配置');
  }
  const reviewReasons = commandReviewReasons(
    command,
    args,
    argsWereExplicit,
    shell,
    hasTrustedExecutableIdentity,
  );
  return {
    input: {
      command,
      args,
      cwd,
      shell,
      timeoutMs,
      maxOutputBytes,
      ...(executableIdentity === undefined
        ? {}
        : {executableIdentity}),
    },
    scope: [
      `cwd:${cwd}`,
      `command:${[command, ...args].join(' ')}`,
      ...(executableIdentity === undefined
        ? []
        : [`executable:${executableIdentity}`]),
      ...targets,
      ...curlFileTargets,
      ...networkOverrides,
    ],
    confirmReasons,
    reviewReasons,
    allowReason: '命令匹配固定的低风险测试、检查或构建白名单',
    ...(executableIdentity === undefined ? {} : {executableIdentity}),
  };
}

function ipv4IsPublic(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet)
      || octet < 0
      || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return !(first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && [
      0,
      2,
      168,
    ].includes(second))
    || (first === 198 && [18, 19, 51].includes(second))
    || (first === 203 && second === 0)
    || first >= 224);
}

function ipv6Words(host: string): number[] | undefined {
  const unwrapped = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  if (unwrapped.includes('%') || unwrapped.split('::').length > 2) {
    return undefined;
  }
  const halves = unwrapped.split('::');
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const right = halves.length === 1 || halves[1] === ''
    ? []
    : (halves[1] ?? '').split(':');
  if ([...left, ...right].some((part) => !/^[a-f0-9]{1,4}$/iu.test(part))) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0)
    || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({length: missing}, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function ipv6IsPublic(host: string): boolean {
  const words = ipv6Words(host);
  if (words === undefined || words.length !== 8) return false;
  const first = words[0] ?? 0;
  const allZeroPrefix = words.slice(0, 6).every((word) => word === 0);
  if (words.every((word) => word === 0)
    || (words.slice(0, 7).every((word) => word === 0)
      && words[7] === 1)
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8)) {
    return false;
  }
  if (allZeroPrefix || (words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff)) {
    const ipv4 = `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.`
      + `${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`;
    return ipv4IsPublic(ipv4);
  }
  return true;
}

function nonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return host === ''
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan');
}

function normalizePublicUrl(value: unknown): string {
  const raw = cleanToken(value, 'url');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    inputError('URL 格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    inputError('URL 只允许 HTTP 或 HTTPS');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    inputError('URL 不得包含凭据');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (/[{}[\]]/u.test(host) || nonPublicHostname(host)) {
    inputError('URL 目标不是公开主机');
  }
  const ipVersion = isIP(host.startsWith('[') ? host.slice(1, -1) : host);
  if ((ipVersion === 4 && !ipv4IsPublic(host))
    || (ipVersion === 6 && !ipv6IsPublic(host))
    || host.includes('%')) {
    inputError('URL 目标位于本机、内网或保留地址');
  }
  parsed.hostname = host;
  return parsed.href;
}

async function normalizeFileTool(
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

async function normalizePatch(
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

function normalizeGitTool(
  tool: string,
  value: unknown,
): NormalizedOperation {
  const input = record(value, `${tool} input`);
  if (tool === 'git_status') {
    onlyKeys(input, [], `${tool} input`);
    return {
      input: {},
      scope: ['git:status'],
      confirmReasons: [],
      reviewReasons: [],
      allowReason: '操作只读取 Git 状态',
    };
  }
  if (tool === 'git_diff') {
    onlyKeys(input, ['staged'], `${tool} input`);
    const staged = optionalBoolean(input.staged, 'staged', false);
    return {
      input: {staged},
      scope: [staged ? 'git:diff:staged' : 'git:diff:working-tree'],
      confirmReasons: [],
      reviewReasons: [],
      allowReason: '操作只读取 Git 差异',
    };
  }
  onlyKeys(input, ['limit'], `${tool} input`);
  const limit = optionalInteger(
    input.limit,
    'limit',
    DEFAULT_GIT_LOG_LIMIT,
    1,
    100,
  );
  return {
    input: {limit},
    scope: [`git:log:${limit}`],
    confirmReasons: [],
    reviewReasons: [],
    allowReason: '操作只读取 Git 日志',
  };
}

function normalizeWebTool(tool: string, value: unknown): NormalizedOperation {
  const input = record(value, `${tool} input`);
  if (tool === 'web_search') {
    onlyKeys(input, ['query'], `${tool} input`);
    const query = requiredString(input.query, 'query').trim();
    if (query.length === 0) inputError('query 不能为空');
    return {
      input: {query},
      scope: [`search:${query}`],
      confirmReasons: [],
      reviewReasons: [],
      allowReason: '操作只搜索公开技术资料',
    };
  }
  onlyKeys(input, ['url'], `${tool} input`);
  const url = normalizePublicUrl(input.url);
  return {
    input: {url},
    scope: [`url:${url}`],
    confirmReasons: [],
    reviewReasons: [],
    allowReason: '操作只读取公开 HTTP/HTTPS 内容',
  };
}

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
  if (operation.tool === 'run_command') {
    return normalizeCommand(operation.input, context);
  }
  if (['git_status', 'git_diff', 'git_log'].includes(operation.tool)) {
    return normalizeGitTool(operation.tool, operation.input);
  }
  return normalizeWebTool(operation.tool, operation.input);
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

export type {
  BoundaryAction,
  BoundaryContext,
  BoundaryDecision,
  BoundaryOperation,
  BoundaryRisk,
} from './types.js';
