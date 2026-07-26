import type {CredentialProvider} from '../config/credentials.js';

export interface PendingCredentialPrompt {
  id: number;
  provider: CredentialProvider;
}

export interface CredentialPromptBroker {
  request(
    provider: CredentialProvider,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  getPending(): PendingCredentialPrompt | undefined;
  subscribe(listener: () => void): () => void;
  respond(apiKey: string | undefined): void;
  close(): void;
}

interface QueuedCredentialPrompt {
  pending: PendingCredentialPrompt;
  signal: AbortSignal;
  resolve: (apiKey: string | undefined) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('操作已中止', 'AbortError');
}

export class InteractiveCredentialPromptBroker
implements CredentialPromptBroker {
  private readonly queue: QueuedCredentialPrompt[] = [];
  private readonly listeners = new Set<() => void>();
  private current: QueuedCredentialPrompt | undefined;
  private nextId = 1;
  private closed = false;

  constructor(private readonly interactive: boolean) {}

  request(
    provider: CredentialProvider,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.interactive || this.closed) return Promise.resolve(undefined);
    if (signal.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const queued: QueuedCredentialPrompt = {
        pending: {
          id: this.nextId++,
          provider: {...provider},
        },
        signal,
        resolve,
        reject,
        onAbort: () => this.abort(queued),
      };
      signal.addEventListener('abort', queued.onAbort, {once: true});
      this.queue.push(queued);
      this.advance();
    });
  }

  getPending(): PendingCredentialPrompt | undefined {
    return this.current?.pending;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  respond(apiKey: string | undefined): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    this.cleanup(current);
    const trimmed = apiKey?.trim();
    current.resolve(trimmed ? trimmed : undefined);
    this.advance();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.current !== undefined) {
      const current = this.current;
      this.current = undefined;
      this.cleanup(current);
      current.resolve(undefined);
    }
    for (const queued of this.queue.splice(0)) {
      this.cleanup(queued);
      queued.resolve(undefined);
    }
    this.notify();
  }

  private abort(queued: QueuedCredentialPrompt): void {
    if (this.current === queued) {
      this.current = undefined;
      this.cleanup(queued);
      queued.reject(abortReason(queued.signal));
      this.advance();
      return;
    }
    const index = this.queue.indexOf(queued);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.cleanup(queued);
    queued.reject(abortReason(queued.signal));
  }

  private cleanup(queued: QueuedCredentialPrompt): void {
    queued.signal.removeEventListener('abort', queued.onAbort);
  }

  private advance(): void {
    if (this.current !== undefined || this.closed) return;
    this.current = this.queue.shift();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
