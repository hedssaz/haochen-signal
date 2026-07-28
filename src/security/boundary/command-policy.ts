import {basename, isAbsolute, relative, resolve, sep} from 'node:path';
import {resolveExecutableIdentity} from '../executable-identity.js';
import type {BoundaryContext} from '../types.js';
import {
  cleanToken, normalizePath, onlyKeys, optionalBoolean,
  optionalInteger, record, sensitivePath, stringArray,
} from './common.js';
import {normalizeCommandTargets} from './command-targets.js';
import {
  normalizeCommandNetworkOverrides, normalizeCurlFileTargets,
} from './network-policy.js';
import type {NormalizedOperation} from './types.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;

const SHELL_EXECUTABLES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh',
]);

function normalizedExecutable(command: string): string {
  const portable = command.replaceAll('\\', '/');
  return basename(portable).replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase();
}

export function unwrapCommand(
  command: string,
  args: string[],
): {command: string; args: string[]; envSplitString: boolean; commands: string[]} {
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
          return {command: effectiveCommand, args: effectiveArgs, envSplitString, commands};
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

function dequoteShellText(script: string): string {
  return script.replace(/\\([^\r\n])/gu, '$1').replace(/['"]/gu, '');
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

    const tokens = [...dequoteShellText(payload).trim().split(/\s+/u), ...remaining];
    if (normalizedExecutable(tokens[0] ?? '') === 'curl') {
      return [tokens.slice(1)];
    }
    return [];
  }
  return [];
}

function curlArgumentSets(
  command: string, args: string[], shellSemantics: boolean,
): string[][] {
  const effective = unwrapCommand(command, args);
  const sets = effective.command === 'curl' ? [effective.args] : [];
  if (shellSemantics) sets.push(...shellCurlArguments(command, args));
  sets.push(...envSplitCurlArguments(command, args));
  return sets;
}

function exactArgs(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((argument, index) => argument === expected[index]);
}

function isWhitelistedCommand(
  command: string, args: string[], argsWereExplicit: boolean, shell: boolean,
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
    '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
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
  command: string, args: string[], shell: boolean,
): string[] {
  const reasons: string[] = [];
  const effective = unwrapCommand(command, args);
  const rawText = [command, ...args].join(' ');
  const shellSemantics = usesShellInterpreter(command, args, shell);
  const allText = shellSemantics ? dequoteShellText(rawText) : rawText;
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
    '--data', '--data-ascii', '--data-raw', '--data-binary', '--data-urlencode',
    '--form', '--form-string', '--json', '--upload-file',
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

function dependencyInstall(command: string, args: string[]): boolean {
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
  command: string, args: string[], argsWereExplicit: boolean, shell: boolean,
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
  command: string, args: string[], shell: boolean,
): boolean {
  const effective = unwrapCommand(command, args);
  return shell
    || effective.envSplitString
    || SHELL_EXECUTABLES.has(effective.command);
}

function compactCommandPathCandidates(command: string, args: string[]): string[] {
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

export async function normalizeCommand(
  value: unknown, context: BoundaryContext,
): Promise<NormalizedOperation> {
  const input = record(value, 'run_command input');
  onlyKeys(input, [
    'command', 'args', 'cwd', 'shell', 'timeoutMs', 'maxOutputBytes',
  ], 'run_command input');
  const command = cleanToken(input.command, 'command');
  const argsWereExplicit = input.args !== undefined;
  const args = input.args === undefined ? [] : stringArray(input.args, 'args');
  const shell = optionalBoolean(input.shell, 'shell', false);
  const timeoutMs = optionalInteger(
    input.timeoutMs, 'timeoutMs', DEFAULT_COMMAND_TIMEOUT_MS, 0, 2_147_483_647,
  );
  const maxOutputBytes = optionalInteger(
    input.maxOutputBytes, 'maxOutputBytes', DEFAULT_COMMAND_OUTPUT_BYTES, 0,
  );
  const cwd = await normalizePath(context, input.cwd ?? '.', 'existing', 'cwd');
  const absoluteCwd = resolve(context.workspace, cwd);
  const executableIdentity = shell
    ? undefined
    : await resolveExecutableIdentity(command, absoluteCwd, process.env, process.platform);
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
  const targetArguments = shell ? [command, ...args] : args;
  const targetTexts = targetArguments.map((argument) => (
    shellSemantics ? [argument, dequoteShellText(argument)] : [argument]
  ));
  const targets = await normalizeCommandTargets(
    targetTexts,
    compactCommandPathCandidates(command, args),
    context,
  );
  const curlArgs = curlArgumentSets(command, args, shellSemantics);
  const curlFileTargets = await normalizeCurlFileTargets(curlArgs, context);
  const networkOverrides = normalizeCommandNetworkOverrides(curlArgs);

  const confirmReasons = commandConfirmationReasons(command, args, shell);
  if (targets.some((target) => (
    target.startsWith('path:') && sensitivePath(target.slice('path:'.length))
  ))) {
    confirmReasons.push('命令可能读取凭据或敏感配置');
  }
  const reviewReasons = commandReviewReasons(
    command, args, argsWereExplicit, shell, hasTrustedExecutableIdentity,
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
