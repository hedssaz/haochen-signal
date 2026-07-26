import type {SessionEvent} from '../sessions/types.js';

export interface TaskInterruptionBinding {
  appendInterrupted: (reason: string) => Promise<void>;
  finish: () => void;
}

export interface TaskInterruptionRouter {
  beginTask: (sessionId: string) => TaskInterruptionBinding;
  appendCurrent: (sessionId: string, reason: string) => Promise<void>;
}

export function createTaskInterruptionRouter(
  append: (sessionId: string, event: SessionEvent) => Promise<void>,
  now: () => number = Date.now,
): TaskInterruptionRouter {
  let activeWriter: ((reason: string) => Promise<void>) | undefined;

  const writerFor = (sessionId: string): ((reason: string) => Promise<void>) => {
    let interruptedWrite: Promise<void> | undefined;
    return (reason: string): Promise<void> => {
      interruptedWrite ??= append(sessionId, {
        type: 'interrupted',
        at: now(),
        reason,
      });
      return interruptedWrite;
    };
  };

  return {
    beginTask(sessionId) {
      const appendInterrupted = writerFor(sessionId);
      activeWriter = appendInterrupted;
      return {
        appendInterrupted,
        finish() {
          if (activeWriter === appendInterrupted) activeWriter = undefined;
        },
      };
    },
    appendCurrent(sessionId, reason) {
      const writer = activeWriter ?? writerFor(sessionId);
      return writer(reason);
    },
  };
}
