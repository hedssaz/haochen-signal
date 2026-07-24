import {lstat, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {runCommand, type CommandOutput} from './command.js';
import type {ToolContext, ToolResult} from './types.js';

const DEFAULT_LOG_LIMIT = 20;
const STATUS_ARGS = [
  '-c',
  'core.fsmonitor=false',
  'status',
  '--short',
  '--branch',
];
const LOG_FORMAT = [
  '%H',
  '%an',
  '%aI',
  '%s',
].join('%x00');

export interface GitStatusOutput {
  porcelain: string;
  fullOutputPath?: string;
}

export interface GitDiffInput {
  staged?: boolean;
}

export interface GitDiffOutput {
  text: string;
  fullOutputPath?: string;
}

export interface GitLogInput {
  limit?: number;
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitLogOutput {
  commits: GitCommit[];
  fullOutputPath?: string;
}

function failure<T>(
  code: string,
  message: string,
  data?: T,
  truncated?: boolean,
): ToolResult<T> {
  return {
    ok: false,
    summary: message,
    ...(data === undefined ? {} : {data}),
    error: {code, message},
    ...(truncated === undefined ? {} : {truncated}),
  };
}

function propagateCommandFailure<T>(
  result: ToolResult<CommandOutput>,
  mapOutput: (output: CommandOutput) => T,
): ToolResult<T> {
  const code = result.error?.code ?? 'GIT_COMMAND_FAILED';
  const message = result.error?.message ?? 'Git 命令执行失败';
  const data = result.data?.fullOutputPath === undefined
    ? undefined
    : mapOutput(result.data);
  return failure(code, message, data, result.truncated);
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) environment[key] = value;
  }

  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LANGUAGE: 'C',
    LC_ALL: 'C',
    PAGER: 'cat',
  };
}

async function executeGit(
  args: string[],
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult<CommandOutput>> {
  const effectiveSignal = signal ?? new AbortController().signal;
  const result = await runCommand({
    command: 'git',
    args,
    shell: false,
  }, context, effectiveSignal, {
    env: sanitizedGitEnvironment(),
  });
  return result;
}

function commandSucceeded(
  result: ToolResult<CommandOutput>,
): result is ToolResult<CommandOutput> & {data: CommandOutput} {
  return result.ok && result.data?.exitCode === 0;
}

async function hasGitMetadata(workspace: string): Promise<boolean> {
  let current: string;
  try {
    current = await realpath(resolve(workspace));
  } catch {
    return true;
  }
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }

    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function repositoryStatusFailure<T>(
  context: ToolContext,
  data?: T,
  truncated?: boolean,
): Promise<ToolResult<T>> {
  if (await hasGitMetadata(context.workspace)) {
    return failure('GIT_COMMAND_FAILED', 'Git 命令执行失败', data, truncated);
  }
  return failure(
    'NOT_A_GIT_REPOSITORY',
    '工作区不是 Git 仓库',
    data,
    truncated,
  );
}

async function commandFailure<T>(
  result: ToolResult<CommandOutput>,
  context: ToolContext,
  signal: AbortSignal | undefined,
  commandWasStatus: boolean,
  mapOutput: (output: CommandOutput) => T,
): Promise<ToolResult<T>> {
  if (!result.ok) return propagateCommandFailure(result, mapOutput);
  const originalData = result.data?.fullOutputPath === undefined
    ? undefined
    : mapOutput(result.data);
  if (commandWasStatus) {
    return repositoryStatusFailure(context, originalData, result.truncated);
  }

  const status = await executeGit(
    STATUS_ARGS,
    context,
    signal,
  );
  if (!status.ok) {
    if (originalData !== undefined) {
      return failure(
        status.error?.code ?? 'GIT_COMMAND_FAILED',
        status.error?.message ?? 'Git 命令执行失败',
        originalData,
        result.truncated,
      );
    }
    return propagateCommandFailure(status, mapOutput);
  }
  if (status.data?.exitCode !== 0) {
    const statusData = status.data?.fullOutputPath === undefined
      ? undefined
      : mapOutput(status.data);
    return repositoryStatusFailure(
      context,
      originalData ?? statusData,
      result.truncated ?? status.truncated,
    );
  }
  return failure(
    'GIT_COMMAND_FAILED',
    'Git 命令执行失败',
    originalData,
    result.truncated,
  );
}

function outputPath(
  commandOutput: CommandOutput,
): {fullOutputPath: string} | Record<string, never> {
  return commandOutput.fullOutputPath === undefined
    ? {}
    : {fullOutputPath: commandOutput.fullOutputPath};
}

function statusOutput(commandOutput: CommandOutput): GitStatusOutput {
  return {
    porcelain: commandOutput.stdout,
    ...outputPath(commandOutput),
  };
}

function diffOutput(commandOutput: CommandOutput): GitDiffOutput {
  return {
    text: commandOutput.stdout,
    ...outputPath(commandOutput),
  };
}

function failedLogOutput(commandOutput: CommandOutput): GitLogOutput {
  return {
    commits: [],
    ...outputPath(commandOutput),
  };
}

export async function gitStatus(
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult<GitStatusOutput>> {
  const result = await executeGit(
    STATUS_ARGS,
    context,
    signal,
  );
  if (!commandSucceeded(result)) {
    return commandFailure(result, context, signal, true, statusOutput);
  }

  return {
    ok: true,
    summary: '已读取 Git 状态',
    data: statusOutput(result.data),
    truncated: result.truncated,
  };
}

export async function gitDiff(
  input: GitDiffInput,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult<GitDiffOutput>> {
  if (!input
    || typeof input !== 'object'
    || (input.staged !== undefined && typeof input.staged !== 'boolean')) {
    return failure('INVALID_INPUT', 'staged 必须是布尔值');
  }

  const args = [
    '-c',
    'core.fsmonitor=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    ...(input.staged === true ? ['--cached'] : []),
  ];
  const result = await executeGit(args, context, signal);
  if (!commandSucceeded(result)) {
    return commandFailure(result, context, signal, false, diffOutput);
  }

  return {
    ok: true,
    summary: input.staged === true
      ? '已读取暂存区差异'
      : '已读取工作区差异',
    data: diffOutput(result.data),
    truncated: result.truncated,
  };
}

function parseLog(stdout: string): GitCommit[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4 !== 0) {
    throw new Error('Git 日志记录格式无效');
  }

  const commits: GitCommit[] = [];
  for (let index = 0; index < fields.length; index += 4) {
    const hash = fields[index];
    const author = fields[index + 1];
    const date = fields[index + 2];
    const subject = fields[index + 3];
    if (hash === undefined
      || author === undefined
      || date === undefined
      || subject === undefined) {
      throw new Error('Git 日志记录缺少字段');
    }
    commits.push({hash, author, date, subject});
  }
  return commits;
}

export async function gitLog(
  input: GitLogInput,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult<GitLogOutput>> {
  if (!input || typeof input !== 'object') {
    return failure('INVALID_INPUT', 'Git 日志输入必须是对象');
  }
  const limit = input.limit ?? DEFAULT_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return failure('INVALID_INPUT', 'limit 必须是 1 到 100 的整数');
  }

  const result = await executeGit(
    ['log', '-z', `--format=${LOG_FORMAT}`, '-n', String(limit)],
    context,
    signal,
  );
  if (!commandSucceeded(result)) {
    return commandFailure(result, context, signal, false, failedLogOutput);
  }
  if (result.truncated) {
    return {
      ...failure<GitLogOutput>(
        'GIT_OUTPUT_TRUNCATED',
        'Git 日志输出超过限制，无法完整解析',
        failedLogOutput(result.data),
        true,
      ),
    };
  }

  try {
    return {
      ok: true,
      summary: `已读取 ${limit} 条以内的 Git 提交`,
      data: {
        commits: parseLog(result.data.stdout),
        ...outputPath(result.data),
      },
      truncated: false,
    };
  } catch {
    const data = result.data.fullOutputPath === undefined
      ? undefined
      : failedLogOutput(result.data);
    return failure(
      'GIT_LOG_PARSE_FAILED',
      '无法解析 Git 日志',
      data,
      result.truncated,
    );
  }
}
