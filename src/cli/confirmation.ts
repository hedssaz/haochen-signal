import type {
  ConfirmationRequest,
  ConfirmationResult,
} from '../security/reviewer.js';

export interface PendingConfirmation extends ConfirmationRequest {
  id: number;
}

export interface ConfirmationBroker {
  request(request: ConfirmationRequest): Promise<ConfirmationResult>;
  getPending(): PendingConfirmation | undefined;
  subscribe(listener: () => void): () => void;
  respond(result: ConfirmationResult): void;
  close(): void;
}

interface QueuedConfirmation {
  pending: PendingConfirmation;
  resolve: (result: ConfirmationResult) => void;
}

export class InteractiveConfirmationBroker implements ConfirmationBroker {
  private readonly queue: QueuedConfirmation[] = [];
  private readonly listeners = new Set<() => void>();
  private current: QueuedConfirmation | undefined;
  private nextId = 1;
  private closed = false;

  constructor(private readonly interactive: boolean) {}

  request(request: ConfirmationRequest): Promise<ConfirmationResult> {
    if (!this.interactive || this.closed) return Promise.resolve('deny');
    return new Promise(resolve => {
      this.queue.push({
        pending: {...request, id: this.nextId++},
        resolve,
      });
      this.advance();
    });
  }

  getPending(): PendingConfirmation | undefined {
    return this.current?.pending;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  respond(result: ConfirmationResult): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    current.resolve(result);
    this.advance();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.current !== undefined) {
      const current = this.current;
      this.current = undefined;
      current.resolve('deny');
    }
    for (const queued of this.queue.splice(0)) queued.resolve('deny');
    this.notify();
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
