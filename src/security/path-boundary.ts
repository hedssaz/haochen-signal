import {lstat, realpath} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

export type WorkspacePathMode = 'existing' | 'new';

export interface ResolvedPath {
  absolute: string;
  relative: string;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return !isAbsolute(fromRoot)
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`);
}

function assertInside(root: string, candidate: string): void {
  if (!isInside(root, candidate)) {
    throw new Error('请求路径位于工作区外');
  }
}

async function assertNoSymlink(
  root: string,
  candidate: string,
): Promise<void> {
  const fromRoot = relative(root, candidate);
  if (fromRoot === '') return;

  let current = root;
  for (const segment of fromRoot.split(sep)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error('请求路径包含符号链接');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const parent = dirname(current);
    if (parent === current) throw new Error('找不到请求路径的现存父目录');
    current = parent;
  }
}

export async function resolveWorkspacePath(
  workspace: string,
  requested: string,
  mode: WorkspacePathMode,
): Promise<ResolvedPath> {
  const realWorkspace = await realpath(resolve(workspace));
  const lexicalCandidate = resolve(realWorkspace, requested);
  assertInside(realWorkspace, lexicalCandidate);
  await assertNoSymlink(realWorkspace, lexicalCandidate);

  let candidate: string;
  if (mode === 'existing') {
    candidate = await realpath(lexicalCandidate);
  } else {
    const existing = await nearestExistingPath(lexicalCandidate);
    const realExisting = await realpath(existing);
    const unresolvedSuffix = relative(existing, lexicalCandidate);
    candidate = resolve(realExisting, unresolvedSuffix);
  }

  assertInside(realWorkspace, candidate);
  const fromWorkspace = relative(realWorkspace, candidate);
  return {
    absolute: candidate,
    relative: fromWorkspace || '.',
  };
}
