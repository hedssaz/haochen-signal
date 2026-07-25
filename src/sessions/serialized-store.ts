import type {SessionStore} from './store.js';
import type {SessionEvent} from './types.js';

export type SessionStorePort = Pick<SessionStore, 'append' | 'read'>;

/** Keeps terminal-triggered writes in the same order as agent-loop writes. */
export function createSerializedSessionStore(store: SessionStorePort): SessionStorePort {
  let writes = Promise.resolve();

  return {
    read: sessionId => store.read(sessionId),
    append: (sessionId: string, event: SessionEvent): Promise<void> => {
      const write = writes.then(() => store.append(sessionId, event));
      writes = write.catch(() => undefined);
      return write;
    },
  };
}
