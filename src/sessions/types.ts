import {z} from 'zod';

const timestamp = z.number();

export const SessionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('user'), at: timestamp, text: z.string()}),
  z.strictObject({type: z.literal('assistant'), at: timestamp, text: z.string()}),
  z.strictObject({
    type: z.literal('checkpoint'),
    at: timestamp,
    reason: z.enum(['clear', 'exit']),
  }),
  z.strictObject({
    type: z.literal('tool'),
    at: timestamp,
    tool: z.string(),
    input: z.unknown(),
    result: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('summary'),
    at: timestamp,
    text: z.string(),
    /** Number of earlier JSONL events represented by this appended summary. */
    coveredEventCount: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('interrupted'),
    at: timestamp,
    reason: z.string(),
  }),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;

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
