export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ModelMessage =
  | {role: 'system' | 'user'; content: string}
  | {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string;
    tool_calls?: AssistantToolCall[];
  }
  | {role: 'tool'; tool_call_id: string; content: string};

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
}

export type ModelEvent =
  | {type: 'reasoning_delta'; text: string}
  | {type: 'text_delta'; text: string}
  | {
    type: 'tool_call_delta';
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }
  | {
    type: 'finish';
    reason: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
    };
  };

export interface ModelClient {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
