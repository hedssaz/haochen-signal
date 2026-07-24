import {lstatSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function jsonlPathFor(
  directory: string,
  id: string,
  label: 'session' | 'workspace',
): string {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid ${label} id`);
  }

  const root = resolve(directory);
  const path = resolve(root, `${id}.jsonl`);
  const fromRoot = relative(root, path);
  if (isAbsolute(fromRoot)
    || fromRoot === '..'
    || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Invalid ${label} id`);
  }

  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Invalid ${label} id`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return path;
}
