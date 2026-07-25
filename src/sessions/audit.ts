import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {redactValue} from '../security/redact.js';
import {appendUtf8} from './files.js';
import {jsonlPathFor} from './path.js';
import type {AuditEntry} from './types.js';

export function workspaceId(workspacePath: string): string {
  return createHash('sha256').update(resolve(workspacePath)).digest('hex');
}

export class AuditStore {
  constructor(private readonly directory: string) {}

  pathFor(workspaceId: string): string {
    return jsonlPathFor(this.directory, workspaceId, 'workspace');
  }

  async prepare(workspaceId: string): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    await appendUtf8(this.pathFor(workspaceId), '');
  }

  async append(workspaceId: string, entry: AuditEntry): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    await appendUtf8(
      this.pathFor(workspaceId),
      `${JSON.stringify(redactValue(entry))}\n`,
    );
  }
}
