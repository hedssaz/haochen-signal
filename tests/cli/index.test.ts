import {readFile} from 'node:fs/promises';
import {Ajv} from 'ajv';
import {describe, expect, it, vi} from 'vitest';
import type {
  HaochenConfig,
  ProviderProfile,
} from '../../src/config/schema.js';
import type {ModelClient} from '../../src/providers/types.js';
import type {SessionEvent} from '../../src/sessions/types.js';
import type {ToolDefinitionSpec} from '../../src/tools/types.js';

interface ModelRuntime {
  client: ModelClient;
  model: HaochenConfig['models'][number];
  provider: ProviderProfile;
}

interface CliTestExports {
  loadOrCreateConfig?: (
    path: string,
    dependencies: {
      load: (path: string) => Promise<HaochenConfig | undefined>;
      save: (path: string, config: HaochenConfig) => Promise<void>;
    },
  ) => Promise<HaochenConfig>;
  createModelRuntimeResolver?: (options: {
    getConfig: () => HaochenConfig;
    temporaryProviderKeys: Map<string, string>;
    resolveApiKey: (provider: ProviderProfile) => Promise<string | undefined>;
    createClient: (options: {
      provider: ProviderProfile;
      apiKey: string;
      timeoutMs: number;
    }) => ModelClient;
  }) => () => Promise<ModelRuntime>;
}

async function importCliForTest(): Promise<CliTestExports> {
  const originalArgv = process.argv;
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.argv = [...process.argv, '--help'];
  vi.resetModules();
  try {
    return await import('../../src/cli/index.js') as CliTestExports;
  } finally {
    process.argv = originalArgv;
    write.mockRestore();
  }
}

function runtimeConfig(): HaochenConfig {
  return {
    version: 2,
    providers: [
      {
        id: 'provider-a',
        name: '供应商 A',
        baseUrl: 'https://a.example.test/v1',
        credentialRef: 'credential-a',
        headers: {'x-tenant': 'a'},
      },
      {
        id: 'provider-b',
        name: '供应商 B',
        baseUrl: 'https://b.example.test/v1',
        credentialRef: 'credential-b',
        headers: {},
      },
    ],
    models: [
      {
        id: 'model-a',
        providerId: 'provider-a',
        modelId: 'alpha-chat',
        displayName: 'Alpha Chat',
        contextWindow: 128_000,
      },
      {
        id: 'model-b',
        providerId: 'provider-b',
        modelId: 'beta-chat',
        displayName: 'Beta Chat',
        contextWindow: 256_000,
      },
    ],
    activeModelId: 'model-a',
    timeoutMs: 60_000,
  };
}

function inertClient(label: string): ModelClient & {label: string} {
  return {
    label,
    async *stream() {
      yield {type: 'finish', reason: 'stop'};
    },
  };
}

describe('CLI entrypoint', () => {
  it('creates and persists an empty v2 config when no config file exists', async () => {
    const cli = await importCliForTest();
    expect(cli.loadOrCreateConfig).toBeTypeOf('function');
    if (cli.loadOrCreateConfig === undefined) return;
    const load = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);

    await expect(cli.loadOrCreateConfig('/config.json', {
      load,
      save,
    })).resolves.toEqual({
      version: 2,
      providers: [],
      models: [],
      timeoutMs: 60_000,
    });

    expect(load).toHaveBeenCalledWith('/config.json');
    expect(save).toHaveBeenCalledWith('/config.json', {
      version: 2,
      providers: [],
      models: [],
      timeoutMs: 60_000,
    });
  });

  it('reads the active provider for every task and reuses clients by provider config and credential', async () => {
    const cli = await importCliForTest();
    expect(cli.createModelRuntimeResolver).toBeTypeOf('function');
    if (cli.createModelRuntimeResolver === undefined) return;
    let config = runtimeConfig();
    const clients = new Map([
      ['provider-a', inertClient('client-a')],
      ['provider-b', inertClient('client-b')],
    ]);
    const createClient = vi.fn(({provider}: {provider: ProviderProfile}) => (
      clients.get(provider.id)!
    ));
    const resolve = cli.createModelRuntimeResolver({
      getConfig: () => config,
      temporaryProviderKeys: new Map([
        ['provider-a', 'key-a'],
        ['provider-b', 'key-b'],
      ]),
      resolveApiKey: vi.fn(async () => undefined),
      createClient,
    });

    const first = await resolve();
    const firstAgain = await resolve();
    config = {...config, activeModelId: 'model-b'};
    const second = await resolve();
    config = {...config, activeModelId: 'model-a'};
    const firstAfterSwitchBack = await resolve();

    expect(first).toMatchObject({
      model: {id: 'model-a', modelId: 'alpha-chat', contextWindow: 128_000},
      provider: {id: 'provider-a'},
      client: {label: 'client-a'},
    });
    expect(second).toMatchObject({
      model: {id: 'model-b', modelId: 'beta-chat', contextWindow: 256_000},
      provider: {id: 'provider-b'},
      client: {label: 'client-b'},
    });
    expect(firstAgain.client).toBe(first.client);
    expect(firstAfterSwitchBack.client).toBe(first.client);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenNthCalledWith(1, {
      provider: config.providers[0],
      apiKey: 'key-a',
      timeoutMs: 60_000,
    });
    expect(createClient).toHaveBeenNthCalledWith(2, {
      provider: config.providers[1],
      apiKey: 'key-b',
      timeoutMs: 60_000,
    });
  });

  it('resolves and remembers the selected provider credential on demand', async () => {
    const cli = await importCliForTest();
    expect(cli.createModelRuntimeResolver).toBeTypeOf('function');
    if (cli.createModelRuntimeResolver === undefined) return;
    const config = runtimeConfig();
    const temporaryProviderKeys = new Map<string, string>();
    const resolveApiKey = vi.fn(async (provider: ProviderProfile) => (
      `${provider.id}-resolved-key`
    ));
    const createClient = vi.fn(() => inertClient('resolved'));
    const resolve = cli.createModelRuntimeResolver({
      getConfig: () => config,
      temporaryProviderKeys,
      resolveApiKey,
      createClient,
    });

    await resolve();
    await resolve();

    expect(resolveApiKey).toHaveBeenCalledOnce();
    expect(resolveApiKey).toHaveBeenCalledWith(
      config.providers[0],
      undefined,
    );
    expect(temporaryProviderKeys.get('provider-a')).toBe(
      'provider-a-resolved-key',
    );
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('rejects an unbound model before resolving credentials or constructing a client', async () => {
    const cli = await importCliForTest();
    expect(cli.createModelRuntimeResolver).toBeTypeOf('function');
    if (cli.createModelRuntimeResolver === undefined) return;
    const resolveApiKey = vi.fn(async () => 'unexpected-key');
    const createClient = vi.fn(() => inertClient('unexpected'));
    const resolve = cli.createModelRuntimeResolver({
      getConfig: () => ({
        version: 2,
        providers: [],
        models: [],
        timeoutMs: 60_000,
      }),
      temporaryProviderKeys: new Map(),
      resolveApiKey,
      createClient,
    });

    await expect(resolve()).rejects.toThrow(
      '未绑定模型，请先使用 /model 配置并选择模型。',
    );
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('constructs a new client when the active provider request config changes', async () => {
    const cli = await importCliForTest();
    expect(cli.createModelRuntimeResolver).toBeTypeOf('function');
    if (cli.createModelRuntimeResolver === undefined) return;
    let config = runtimeConfig();
    const createClient = vi.fn(() => inertClient(`client-${createClient.mock.calls.length}`));
    const resolve = cli.createModelRuntimeResolver({
      getConfig: () => config,
      temporaryProviderKeys: new Map([['provider-a', 'key-a']]),
      resolveApiKey: vi.fn(async () => undefined),
      createClient,
    });

    const before = await resolve();
    config = {
      ...config,
      providers: config.providers.map(provider => provider.id === 'provider-a'
        ? {...provider, baseUrl: 'https://a.example.test/v2'}
        : provider),
    };
    const after = await resolve();

    expect(after.client).not.toBe(before.client);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

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

    expect(source).toContain('credentialPrompts.request(provider, signal)');
    expect(source).not.toContain('createFirstRunInput(process.stdin');
  });

  it('delegates Ctrl+C to the App instead of letting Ink exit first', async () => {
    const source = await readFile(
      new URL('../../src/cli/index.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('/>, {exitOnCtrlC: false});');
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
