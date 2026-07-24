import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename, dirname, join} from 'node:path';
import {parseConfig, type HaochenConfig} from './schema.js';

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

export async function saveConfig(path: string, config: HaochenConfig): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);

  await mkdir(directory, {recursive: true});

  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
