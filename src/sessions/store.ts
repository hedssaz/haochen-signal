import {randomUUID} from 'node:crypto';
import {appendFile, mkdir, readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {redactValue} from '../security/redact.js';
import type {SessionEvent, SessionInfo} from './types.js';

function isTruncatedJson(line: string, cause: unknown): boolean {
  if (!(cause instanceof SyntaxError)) return false;
  if (/unexpected end|unterminated string/i.test(cause.message)) return true;

  const position = /position (\d+)/i.exec(cause.message)?.[1];
  return position !== undefined && Number(position) === line.length;
}

export function createSessionId(): string {
  return randomUUID();
}

export class SessionStore {
  constructor(private readonly directory: string) {}

  pathFor(sessionId: string): string {
    return join(this.directory, `${sessionId}.jsonl`);
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    await appendFile(
      this.pathFor(sessionId),
      `${JSON.stringify(redactValue(event))}\n`,
      'utf8',
    );
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    const contents = await readFile(this.pathFor(sessionId), 'utf8');
    const lines = contents.split('\n');
    const endsWithNewline = contents.endsWith('\n');
    if (endsWithNewline) lines.pop();
    const events: SessionEvent[] = [];

    for (const [index, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch (cause) {
        const isFinalLine = index === lines.length - 1;
        if (!endsWithNewline && isFinalLine && isTruncatedJson(line, cause)) {
          continue;
        }
        throw new Error(`Invalid session JSONL at line ${index + 1}`, {cause});
      }
    }

    return events;
  }

  async list(): Promise<SessionInfo[]> {
    let entries;
    try {
      entries = await readdir(this.directory, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async (entry): Promise<SessionInfo | undefined> => {
          const id = entry.name.slice(0, -'.jsonl'.length);
          const events = await this.read(id);
          const finalEvent = events.at(-1);
          return finalEvent ? {id, updatedAt: finalEvent.at} : undefined;
        }),
    );

    return sessions
      .filter((session): session is SessionInfo => session !== undefined)
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }
}
