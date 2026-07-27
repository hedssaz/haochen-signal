import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import {resolveExecutableIdentity} from '../executable-identity.js';
import type {BoundaryContext} from '../types.js';
import {
  cleanToken,
  dequoteShellText,
  inputError,
  normalizePath,
  normalizedExecutable,
  onlyKeys,
  optionalBoolean,
  optionalInteger,
  record,
  sensitivePath,
  stringArray,
  unwrapCommand,
} from './common.js';
import {
  normalizeCommandNetworkOverrides,
  normalizeCurlFileTargets,
  normalizePublicUrl,
} from './network-policy.js';
import type {NormalizedOperation} from './types.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;

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

export async function normalizeCommand(
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
