import type {ZodType} from 'zod';

export interface ToolContext {
  workspace: string;
  tempDir: string;
  approvedExecutableIdentity?: string;
}

export type ToolGateSource =
  | 'boundary_allow'
  | 'boundary_deny'
  | 'ai_review'
  | 'user_confirmation'
  | 'session_grant'
  | 'scope_changed'
  | 'validation'
  | 'audit';

export type ToolGateEvent =
  | {
    type: 'classified';
    tool: string;
    action: 'allow' | 'review' | 'confirm' | 'deny';
    risk: 'low' | 'medium' | 'high';
    reason: string;
  }
  | {type: 'review_started'; tool: string}
  | {
    type: 'review_finished';
    tool: string;
    verdict: 'approve' | 'ask_user' | 'deny';
    risk: 'low' | 'medium' | 'high';
    summary: string;
  }
  | {
    type: 'confirmation_finished';
    tool: string;
    result: 'allow_once' | 'allow_session' | 'deny';
  }
  | {
    type: 'gate_finished';
    tool: string;
    outcome: 'execute' | 'deny';
    source: ToolGateSource;
    summary: string;
  };

export interface ToolResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
  error?: {code: string; message: string};
  warnings?: Array<{code: string; message: string}>;
  truncated?: boolean;
}

export interface ToolDefinitionSpec<I, O> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  jsonSchema: Record<string, unknown>;
  execute: (
    input: I,
    context: ToolContext,
    signal: AbortSignal,
  ) => Promise<ToolResult<O>>;
}
