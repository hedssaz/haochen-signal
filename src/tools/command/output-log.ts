import {constants as fsConstants} from 'node:fs';
import {open} from 'node:fs/promises';
import type {Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {TextDecoder} from 'node:util';
import type {CommandOutput} from './types.js';

const OUTPUT_LOG_CLOSE_TIMEOUT_MS = 250;
const OUTPUT_LOG_REMOVE_ATTEMPTS = 3;
const OUTPUT_LOG_REMOVE_RETRY_MS = 25;

export function decode(chunks: Buffer[]): string {
  if (chunks.length === 0) return '';

  const bytes = Buffer.concat(chunks);
  const decoded = new TextDecoder('utf-8').decode(bytes, {stream: true});
  if (Buffer.byteLength(decoded, 'utf8') <= bytes.length) return decoded;

  let usedBytes = 0;
  let endIndex = 0;
  for (const character of decoded) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > bytes.length) break;
    usedBytes += characterBytes;
    endIndex += character.length;
  }
  return decoded.slice(0, endIndex);
}

export async function ensureOutputLogClosed(
  outputLog: Writable,
  outputLogFinished: Promise<void>,
): Promise<boolean> {
  if (!outputLog.writableEnded && !outputLog.destroyed) outputLog.end();
  await new Promise<void>((complete) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      complete();
    };
    const timeout = setTimeout(finish, OUTPUT_LOG_CLOSE_TIMEOUT_MS);
    void outputLogFinished.then(finish);
  });
  if (outputLog.closed) return true;
  if (!outputLog.destroyed) outputLog.destroy();
  if (outputLog.closed) return true;

  return new Promise<boolean>((complete) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      outputLog.removeListener('close', onClose);
      complete(closed);
    };
    const onClose = (): void => finish(true);
    const timeout = setTimeout(
      () => finish(outputLog.closed),
      OUTPUT_LOG_CLOSE_TIMEOUT_MS,
    );
    outputLog.once('close', onClose);
  });
}

export async function sanitizeOutputLogFile(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
  );
  let failed = false;
  try {
    try {
      await handle.truncate(0);
    } catch {
      failed = true;
    }
    try {
      await handle.chmod(0o600);
    } catch {
      failed = true;
    }
  } finally {
    await handle.close().catch(() => {
      failed = true;
    });
  }
  if (failed) throw new Error('output log sanitization failed');
}

export async function cleanupOutputLogFile(
  path: string,
  removeOutputLog: (path: string) => Promise<void>,
  sanitizeOutputLog: (path: string) => Promise<void>,
): Promise<'removed' | 'sanitized' | 'failed'> {
  for (let attempt = 1; attempt <= OUTPUT_LOG_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await removeOutputLog(path);
      return 'removed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'removed';
      }
      if (attempt < OUTPUT_LOG_REMOVE_ATTEMPTS) {
        await delay(OUTPUT_LOG_REMOVE_RETRY_MS);
      }
    }
  }

  try {
    await sanitizeOutputLog(path);
    return 'sanitized';
  } catch {
    return 'failed';
  }
}

export function outputLogCleanupData(
  outputLogCleanup: 'sanitized' | 'failed',
): CommandOutput {
  return {
    exitCode: null,
    stdout: '',
    stderr: '',
    outputLogCleanup,
  };
}
