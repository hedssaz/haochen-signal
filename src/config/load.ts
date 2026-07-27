import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename, dirname, join} from 'node:path';
import {parseConfig, type HaochenConfig} from './schema.js';

export interface SaveFileOperations {
  mkdir: (path: string, options: {recursive: true}) => Promise<unknown>;
  writeFile: (
    path: string,
    contents: string,
    options: {encoding: 'utf8'; mode: number},
  ) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const defaultSaveFileOperations: SaveFileOperations = {mkdir, writeFile, rename, unlink};

export async function loadConfig(path: string): Promise<HaochenConfig | undefined> {
  let contents: string;

  try {
    contents = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  return parseConfig(JSON.parse(contents));
}

export async function saveConfig(
  path: string,
  config: HaochenConfig,
  files: SaveFileOperations = defaultSaveFileOperations,
  signal?: AbortSignal,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const persistentConfig = parseConfig(config);

  signal?.throwIfAborted();
  await files.mkdir(directory, {recursive: true});

  try {
    signal?.throwIfAborted();
    await files.writeFile(temporaryPath, `${JSON.stringify(persistentConfig, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    signal?.throwIfAborted();
    await files.rename(temporaryPath, path);
  } catch (error: unknown) {
    await files.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
