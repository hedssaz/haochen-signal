import {lstat, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {runCommand, type CommandOutput} from './command.js';
import type {ToolContext, ToolResult} from './types.js';

const DEFAULT_LOG_LIMIT = 20;
const LOG_RECORD_SEPARATOR = '\x1e';
const LOG_FIELD_SEPARATOR = '\x1f';
const LOG_FORMAT = [
  '%H',
  '%an',
  '%aI',
  '%s',
].join('%x1f') + '%x1e';

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

function failure<T>(code: string, message: string): ToolResult<T> {
  return {
    ok: false,
    summary: message,
    error: {code, message},
  };
}

function propagateCommandFailure<T>(
  result: ToolResult<CommandOutput>,
): ToolResult<T> {
  const code = result.error?.code ?? 'GIT_COMMAND_FAILED';
  const message = result.error?.message ?? 'Git 命令执行失败';
  return {
    ...failure<T>(code, message),
    ...(result.truncated === undefined
      ? {}
      : {truncated: result.truncated}),
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
  }, context, effectiveSignal);
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
): Promise<ToolResult<T>> {
  if (await hasGitMetadata(context.workspace)) {
    return failure('GIT_COMMAND_FAILED', 'Git 命令执行失败');
  }
  return failure('NOT_A_GIT_REPOSITORY', '工作区不是 Git 仓库');
}

async function commandFailure<T>(
  result: ToolResult<CommandOutput>,
  context: ToolContext,
  signal: AbortSignal | undefined,
  commandWasStatus: boolean,
): Promise<ToolResult<T>> {
  if (!result.ok) return propagateCommandFailure(result);
  if (commandWasStatus) {
    return repositoryStatusFailure(context);
  }

  const status = await executeGit(
    ['status', '--short', '--branch'],
    context,
    signal,
  );
  if (!status.ok) return propagateCommandFailure(status);
  if (status.data?.exitCode !== 0) {
    return repositoryStatusFailure(context);
  }
  return failure('GIT_COMMAND_FAILED', 'Git 命令执行失败');
}

function outputPath(
  commandOutput: CommandOutput,
): {fullOutputPath: string} | Record<string, never> {
  return commandOutput.fullOutputPath === undefined
    ? {}
    : {fullOutputPath: commandOutput.fullOutputPath};
}

export async function gitStatus(
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult<GitStatusOutput>> {
  const result = await executeGit(
    ['status', '--short', '--branch'],
    context,
    signal,
  );
  if (!commandSucceeded(result)) {
    return commandFailure(result, context, signal, true);
  }

  return {
    ok: true,
    summary: '已读取 Git 状态',
    data: {
      porcelain: result.data.stdout,
      ...outputPath(result.data),
    },
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

  const args = input.staged === true
    ? ['diff', '--cached']
    : ['diff'];
  const result = await executeGit(args, context, signal);
  if (!commandSucceeded(result)) {
    return commandFailure(result, context, signal, false);
  }

  return {
    ok: true,
    summary: input.staged === true
      ? '已读取暂存区差异'
      : '已读取工作区差异',
    data: {
      text: result.data.stdout,
      ...outputPath(result.data),
    },
    truncated: result.truncated,
  };
}

function parseLog(stdout: string): GitCommit[] {
  const records = stdout
    .split(LOG_RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter((record) => record.length > 0);

  return records.map((record) => {
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length !== 4) {
      throw new Error('Git 日志记录格式无效');
    }
    const [hash, author, date, subject] = fields;
    if (hash === undefined
      || author === undefined
      || date === undefined
      || subject === undefined) {
      throw new Error('Git 日志记录缺少字段');
    }
    return {hash, author, date, subject};
  });
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
    ['log', `--format=${LOG_FORMAT}`, '-n', String(limit)],
    context,
    signal,
  );
  if (!commandSucceeded(result)) {
    return commandFailure(result, context, signal, false);
  }
  if (result.truncated) {
    return {
      ...failure<GitLogOutput>(
        'GIT_OUTPUT_TRUNCATED',
        'Git 日志输出超过限制，无法完整解析',
      ),
      truncated: true,
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
    return failure('GIT_LOG_PARSE_FAILED', '无法解析 Git 日志');
  }
}
