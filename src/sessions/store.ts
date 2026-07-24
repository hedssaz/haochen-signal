import {randomUUID} from 'node:crypto';
import {mkdir, readdir} from 'node:fs/promises';
import {redactValue} from '../security/redact.js';
import {appendUtf8, readUtf8, truncateUtf8} from './files.js';
import {jsonPrefixStatus} from './json-prefix.js';
import {jsonlPathFor} from './path.js';
import {SessionEventSchema} from './types.js';
import type {SessionEvent, SessionInfo} from './types.js';

function invalidLine(lineNumber: number, cause: unknown): Error {
  return new Error(`Invalid session JSONL at line ${lineNumber}`, {cause});
}

function parseSessionLine(line: string, lineNumber: number): SessionEvent {
  try {
    return SessionEventSchema.parse(JSON.parse(line));
  } catch (cause) {
    throw invalidLine(lineNumber, cause);
  }
}

function validateCompleteLines(contents: string): void {
  const lines = contents.endsWith('\n')
    ? contents.slice(0, -1).split('\n')
    : contents.split('\n');
  if (lines.length === 1 && lines[0] === '') return;

  for (const [index, line] of lines.entries()) {
    parseSessionLine(line, index + 1);
  }
}

async function readExisting(path: string): Promise<string> {
  try {
    return await readUtf8(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function createSessionId(): string {
  return randomUUID();
}

export class SessionStore {
  constructor(private readonly directory: string) {}

  pathFor(sessionId: string): string {
    return jsonlPathFor(this.directory, sessionId, 'session');
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    const serialized = JSON.stringify(redactValue(event));
    SessionEventSchema.parse(JSON.parse(serialized));
    await mkdir(this.directory, {recursive: true});
    const path = this.pathFor(sessionId);
    const contents = await readExisting(path);
    let separator = '';

    if (contents.endsWith('\n')) {
      validateCompleteLines(contents);
    } else if (contents.length > 0) {
      const finalLineStart = contents.lastIndexOf('\n') + 1;
      const completePrefix = contents.slice(0, finalLineStart);
      const finalLine = contents.slice(finalLineStart);
      validateCompleteLines(completePrefix);

      try {
        parseSessionLine(finalLine, completePrefix.split('\n').length);
        separator = '\n';
      } catch (cause) {
        if (jsonPrefixStatus(finalLine) !== 'truncated') {
          throw cause;
        }
        await truncateUtf8(path, Buffer.byteLength(completePrefix));
      }
    }

    await appendUtf8(
      path,
      `${separator}${serialized}\n`,
    );
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    const contents = await readUtf8(this.pathFor(sessionId));
    if (contents.length === 0) return [];
    const lines = contents.split('\n');
    const endsWithNewline = contents.endsWith('\n');
    if (endsWithNewline) lines.pop();
    const events: SessionEvent[] = [];

    for (const [index, line] of lines.entries()) {
      try {
        events.push(parseSessionLine(line, index + 1));
      } catch (cause) {
        const isFinalLine = index === lines.length - 1;
        if (!endsWithNewline
          && isFinalLine
          && jsonPrefixStatus(line) === 'truncated') {
          continue;
        }
        throw cause;
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
        .map(async (entry): Promise<SessionInfo> => {
          const id = entry.name.slice(0, -'.jsonl'.length);
          const events = await this.read(id);
          const finalEvent = events.at(-1);
          return {id, updatedAt: finalEvent?.at ?? 0};
        }),
    );

    return sessions
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }
}
