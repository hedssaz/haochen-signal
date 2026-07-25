import type {ToolGateEvent} from '../tools/types.js';

export type GateListener = (event: ToolGateEvent) => void;

export class GateReporter {
  private readonly listeners = new Set<GateListener>();

  subscribe(listener: GateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  report(event: ToolGateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Reporting is observational and must not affect the execution gate.
      }
    }
  }
}
