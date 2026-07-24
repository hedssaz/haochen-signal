import type {ZodType} from 'zod';

export interface ToolContext {
  workspace: string;
  tempDir: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
  error?: {code: string; message: string};
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
