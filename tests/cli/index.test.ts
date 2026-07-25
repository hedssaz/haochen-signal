import {readFile} from 'node:fs/promises';
import {describe, expect, it, vi} from 'vitest';
import type {ModelClient} from '../../src/providers/types.js';

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

  it('exposes bounded result limits in the web_search model tool schema', async () => {
    const originalArgv = process.argv;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = [...process.argv, '--help'];
    vi.resetModules();

    try {
      const cli = await import('../../src/cli/index.js') as unknown as {
        toolDefinitions?: () => Map<string, {
          jsonSchema: Record<string, unknown>;
        }>;
      };
      expect(cli.toolDefinitions).toBeTypeOf('function');
      if (typeof cli.toolDefinitions !== 'function') return;

      const definition = cli.toolDefinitions().get('web_search');
      expect(definition?.jsonSchema).toMatchObject({
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
          },
        },
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

      await expect(cli.streamCompactSummary(
        model,
        'wolf-2',
        '请总结',
        controller.signal,
      )).resolves.toEqual({text: '摘要完成', streamTokens: 3});
      expect(receivedSignal).toBe(controller.signal);
    } finally {
      process.argv = originalArgv;
      write.mockRestore();
    }
  });
});
