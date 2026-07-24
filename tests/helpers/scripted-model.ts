import type {
  ModelClient,
  ModelEvent,
} from '../../src/providers/types.js';

export interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export function textResponse(text: string): ModelEvent[] {
  return [
    {type: 'text_delta', text},
    {type: 'finish', reason: 'stop', usage: undefined},
  ];
}

export function toolResponse(calls: ScriptedToolCall[]): ModelEvent[] {
  return [
    ...calls.map((call, index): ModelEvent => ({
      type: 'tool_call_delta',
      index,
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    })),
    {type: 'finish', reason: 'tool_calls', usage: undefined},
  ];
}

export function scriptedModel(
  responses: ReadonlyArray<ReadonlyArray<ModelEvent>>,
): ModelClient {
  const queue = responses.map(response => [...response]);

  return {
    async *stream(_request, signal) {
      signal.throwIfAborted();
      const response = queue.shift();
      if (response === undefined) {
        throw new Error('Scripted model responses exhausted');
      }

      for (const event of response) {
        signal.throwIfAborted();
        yield event;
      }
    },
  };
}
