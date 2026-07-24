import {createHash} from 'node:crypto';
import {appendFile, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {redactValue} from '../security/redact.js';
import type {AuditEntry} from './types.js';

export function workspaceId(workspacePath: string): string {
  return createHash('sha256').update(resolve(workspacePath)).digest('hex');
}

export class AuditStore {
  constructor(private readonly directory: string) {}

  pathFor(workspaceId: string): string {
    return join(this.directory, `${workspaceId}.jsonl`);
  }

  async append(workspaceId: string, entry: AuditEntry): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    await appendFile(
      this.pathFor(workspaceId),
      `${JSON.stringify(redactValue(entry))}\n`,
      'utf8',
    );
  }
}
