import {z} from 'zod';
import type {ModelMessage} from '../providers/types.js';
import type {SessionEvent} from '../sessions/types.js';

export interface RelevantFile {
  path: string;
  content: string;
}

export interface ContextInput {
  systemPrompt: string;
  currentTask: string;
  unfinishedPlan?: string | readonly string[];
  /** `plan` is kept as a concise alias for callers that already use that name. */
  plan?: string | readonly string[];
  events: readonly SessionEvent[];
  relevantFiles?: readonly RelevantFile[];
  summary?: string;
  maxTokens: number;
}

export interface StructuredSummary {
  goal: string;
  changes: string[];
  remaining: string[];
  keyFiles: string[];
  decisions: string[];
  errors: string[];
  verification: string[];
}

export const StructuredSummarySchema: z.ZodType<StructuredSummary> = z.strictObject({
  goal: z.string(),
  changes: z.array(z.string()),
  remaining: z.array(z.string()),
  keyFiles: z.array(z.string()),
  decisions: z.array(z.string()),
  errors: z.array(z.string()),
  verification: z.array(z.string()),
});

export type HistorySummarizer = (prompt: string) => Promise<unknown>;

export interface SuccessfulCompaction {
  compacted: true;
  events: SessionEvent[];
  summary: StructuredSummary;
  summaryEvent: Extract<SessionEvent, {type: 'summary'}>;
}

export interface FailedCompaction {
  compacted: false;
  events: SessionEvent[];
  reason: string;
}

export type CompactionResult = SuccessfulCompaction | FailedCompaction;

export type ContextMessages = ModelMessage[];
