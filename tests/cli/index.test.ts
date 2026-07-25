import {readFile} from 'node:fs/promises';
import {Ajv} from 'ajv';
import {describe, expect, it, vi} from 'vitest';
import type {ModelClient} from '../../src/providers/types.js';
import type {SessionEvent} from '../../src/sessions/types.js';
import type {ToolDefinitionSpec} from '../../src/tools/types.js';

describe('CLI entrypoint', () => {
  it('passes the live session grant set to the App instead of its startup size', async () => {
    const source = await readFile(
      new URL('../../src/cli/index.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('sessionGrants={grants}');
    expect(source).not.toContain('sessionGrants={grants.size}');
  });

  it('uses the hidden temporary-key flow after loading an existing config', async () => {
    const source = await readFile(
      new URL('../../src/cli/index.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('resolveStartupApiKey({');
    expect(source).not.toContain('prompt: async () => undefined');
  });

  it('exposes character pagination in the read_file model tool schema', async () => {
    const originalArgv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = [...process.argv, '--help'];
    vi.resetModules();

    try {
      const cli = await import('../../src/cli/index.js') as unknown as {
        toolDefinitions?: () => Map<string, {
          description: string;
          jsonSchema: Record<string, unknown>;
        }>;
      };
      expect(cli.toolDefinitions).toBeTypeOf('function');
      if (typeof cli.toolDefinitions !== 'function') return;

      const definition = cli.toolDefinitions().get('read_file');
      expect(definition?.description).toBe(
        '读取工作区文本文件；续读时保持 path、startLine、endLine 与上一页一致，并将上一页 nextCharacter 作为 startCharacter',
      );
      expect(definition?.jsonSchema).toMatchObject({
        type: 'object',
        required: ['path'],
        additionalProperties: false,
        properties: {
          startCharacter: {
            type: 'integer',
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          maxCharacters: {
            type: 'integer',
            minimum: 1,
            maximum: 65_536,
          },
        },
      });
    } finally {
      process.argv = originalArgv;
      write.mockRestore();
    }
  });

  it('exposes and enforces the complete web_search model input contract', async () => {
    const originalArgv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = [...process.argv, '--help'];
    vi.resetModules();

    try {
      const cli = await import('../../src/cli/index.js') as unknown as {
        toolDefinitions?: () => Map<string, ToolDefinitionSpec<unknown, unknown>>;
      };
      expect(cli.toolDefinitions).toBeTypeOf('function');
      if (typeof cli.toolDefinitions !== 'function') return;

      const definition = cli.toolDefinitions().get('web_search');
      expect(definition?.jsonSchema).toMatchObject({
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '去除首尾空白后的长度必须为 1 至 500 个字符',
            pattern: expect.any(String),
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
          },
        },
      });
      const validate = new Ajv().compile(definition!.jsonSchema);
      expect(validate({query: '   '})).toBe(false);
      expect(validate({query: `  ${'x'.repeat(500)}  `})).toBe(true);
      expect(validate({query: 'x'.repeat(501)})).toBe(false);
      expect(definition?.inputSchema.safeParse({query: '   '}).success).toBe(false);
      expect(definition?.inputSchema.safeParse({query: 'x'.repeat(501)}).success).toBe(false);
      expect(definition?.inputSchema.safeParse({
        query: `  ${'x'.repeat(500)}  `,
      })).toMatchObject({
        success: true,
        data: {query: 'x'.repeat(500)},
      });
    } finally {
      process.argv = originalArgv;
      write.mockRestore();
    }
  });

  it('passes the compact signal through and counts non-empty summary deltas', async () => {
    const originalArgv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = [...process.argv, '--help'];
    vi.resetModules();

    try {
      const cli = await import('../../src/cli/index.js') as unknown as {
        streamCompactSummary?: (
          model: ModelClient,
          modelName: string,
          prompt: string,
          signal: AbortSignal,
          onProgress?: (streamTokens: number) => void,
        ) => Promise<{text: string; streamTokens: number}>;
      };
      expect(cli.streamCompactSummary).toBeTypeOf('function');
      if (typeof cli.streamCompactSummary !== 'function') return;

      let receivedSignal: AbortSignal | undefined;
      const model: ModelClient = {
        async *stream(_request, signal) {
          receivedSignal = signal;
          yield {type: 'reasoning_delta', text: '分析'};
          yield {type: 'reasoning_delta', text: ''};
          yield {type: 'text_delta', text: '摘要'};
          yield {type: 'text_delta', text: ''};
          yield {type: 'text_delta', text: '完成'};
          yield {type: 'finish', reason: 'stop'};
        },
      };
      const controller = new AbortController();
      const onProgress = vi.fn();

      await expect(cli.streamCompactSummary(
        model,
        'wolf-2',
        '请总结',
        controller.signal,
        onProgress,
      )).resolves.toEqual({text: '摘要完成', streamTokens: 3});
      expect(receivedSignal).toBe(controller.signal);
      expect(onProgress.mock.calls).toEqual([[1], [2], [3]]);
    } finally {
      process.argv = originalArgv;
      write.mockRestore();
    }
  });

  it('does not append a summary when compact is aborted before append starts', async () => {
    const originalArgv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = [...process.argv, '--help'];
    vi.resetModules();

    try {
      const cli = await import('../../src/cli/index.js') as unknown as {
        compactSessionHistory?: (options: {
          readEvents: () => Promise<readonly SessionEvent[]>;
          appendSummary: (
            event: Extract<SessionEvent, {type: 'summary'}>,
          ) => Promise<void>;
          model: ModelClient;
          modelName: string;
          signal: AbortSignal;
        }) => Promise<unknown>;
      };
      expect(cli.compactSessionHistory).toBeTypeOf('function');
      if (typeof cli.compactSessionHistory !== 'function') return;

      const controller = new AbortController();
      const summary = JSON.stringify({
        goal: '完成任务',
        changes: [],
        remaining: [],
        keyFiles: [],
        decisions: [],
        errors: [],
        verification: [],
      });
      const model: ModelClient = {
        async *stream() {
          yield {type: 'text_delta', text: summary};
          controller.abort(new DOMException('用户中止', 'AbortError'));
        },
      };
      const appendSummary = vi.fn(async () => undefined);
      const events: SessionEvent[] = Array.from({length: 7}, (_, index) => ({
        type: 'user' as const,
        at: index,
        text: `消息 ${index}`,
      }));

      await expect(cli.compactSessionHistory({
        readEvents: async () => events,
        appendSummary,
        model,
        modelName: 'wolf-2',
        signal: controller.signal,
      })).rejects.toMatchObject({name: 'AbortError'});
      expect(appendSummary).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      write.mockRestore();
    }
  });

  it('returns a committed success when compact is aborted during append', async () => {
    const originalArgv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = [...process.argv, '--help'];
    vi.resetModules();

    try {
      const cli = await import('../../src/cli/index.js') as unknown as {
        compactSessionHistory?: (options: {
          readEvents: () => Promise<readonly SessionEvent[]>;
          appendSummary: (
            event: Extract<SessionEvent, {type: 'summary'}>,
          ) => Promise<void>;
          model: ModelClient;
          modelName: string;
          signal: AbortSignal;
        }) => Promise<unknown>;
      };
      expect(cli.compactSessionHistory).toBeTypeOf('function');
      if (typeof cli.compactSessionHistory !== 'function') return;

      const controller = new AbortController();
      const summary = JSON.stringify({
        goal: '完成任务',
        changes: [],
        remaining: [],
        keyFiles: [],
        decisions: [],
        errors: [],
        verification: [],
      });
      const model: ModelClient = {
        async *stream() {
          yield {type: 'text_delta', text: summary};
          yield {type: 'finish', reason: 'stop'};
        },
      };
      const appendSummary = vi.fn(async () => {
        controller.abort(new DOMException('用户中止', 'AbortError'));
      });
      const events: SessionEvent[] = Array.from({length: 7}, (_, index) => ({
        type: 'user' as const,
        at: index,
        text: `消息 ${index}`,
      }));

      await expect(cli.compactSessionHistory({
        readEvents: async () => events,
        appendSummary,
        model,
        modelName: 'wolf-2',
        signal: controller.signal,
      })).resolves.toEqual({
        ok: true,
        message: '已压缩历史。',
        committed: true,
        streamTokens: 1,
      });
      expect(appendSummary).toHaveBeenCalledOnce();
    } finally {
      process.argv = originalArgv;
      write.mockRestore();
    }
  });
});
