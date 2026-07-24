export type SessionEvent =
  | {type: 'user'; at: number; text: string}
  | {type: 'assistant'; at: number; text: string}
  | {type: 'tool'; at: number; tool: string; input: unknown; result: unknown}
  | {type: 'summary'; at: number; text: string}
  | {type: 'interrupted'; at: number; reason: string};

export interface SessionInfo {
  id: string;
  updatedAt: number;
}

export interface AuditEntry {
  at: number;
  tool: string;
  input: unknown;
  decision: string;
  result: unknown;
  [key: string]: unknown;
}
