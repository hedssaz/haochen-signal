import {describe, expect, it} from 'vitest';
import {createSerializedSessionStore} from '../../src/sessions/serialized-store.js';
import type {SessionEvent} from '../../src/sessions/types.js';

describe('createSerializedSessionStore', () => {
  it('waits for an in-flight append before writing the next event', async () => {
    const persisted: SessionEvent['type'][] = [];
    let release!: () => void;
    const firstWrite = new Promise<void>(resolve => { release = resolve; });
    const base = {
      read: async (): Promise<SessionEvent[]> => [],
      append: async (_id: string, event: SessionEvent): Promise<void> => {
        if (event.type === 'user') await firstWrite;
        persisted.push(event.type);
      },
    };
    const store = createSerializedSessionStore(base);

    const user = store.append('session-1', {type: 'user', at: 1, text: '继续'});
    const interrupted = store.append('session-1', {
      type: 'interrupted', at: 2, reason: '中止',
    });
    await Promise.resolve();
    expect(persisted).toEqual([]);

    release();
    await Promise.all([user, interrupted]);

    expect(persisted).toEqual(['user', 'interrupted']);
  });
});
