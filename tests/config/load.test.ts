import {describe, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig, saveConfig} from '../../src/config/load.js';
import {parseConfig} from '../../src/config/schema.js';
import {getAppPaths} from '../../src/config/paths.js';

describe('configuration', () => {
  it('accepts an empty v2 configuration without an active model', () => {
    expect(parseConfig({
      version: 2,
      providers: [],
      models: [],
    })).toEqual({
      version: 2,
      providers: [],
      models: [],
      timeoutMs: 60_000,
    });
  });

  it('preserves multiple providers and models while normalizing provider URLs', () => {
    const config = parseConfig({
      version: 2,
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.test/v1///',
          credentialRef: 'deepseek',
          headers: {'x-tenant': 'alpha'},
        },
        {
          id: 'local',
          name: 'Local',
          baseUrl: 'http://localhost:11434/v1/',
          credentialRef: 'local',
          headers: {},
        },
      ],
      models: [
        {
          id: 'deepseek-chat',
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          displayName: 'DeepSeek Chat',
          contextWindow: 128_000,
        },
        {
          id: 'local-qwen',
          providerId: 'local',
          modelId: 'qwen3',
          displayName: 'Qwen 3',
          contextWindow: 32_000,
        },
      ],
      activeModelId: 'deepseek-chat',
      timeoutMs: 90_000,
    });

    expect(config).toEqual({
      version: 2,
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.test/v1',
          credentialRef: 'deepseek',
          headers: {'x-tenant': 'alpha'},
        },
        {
          id: 'local',
          name: 'Local',
          baseUrl: 'http://localhost:11434/v1',
          credentialRef: 'local',
          headers: {},
        },
      ],
      models: [
        {
          id: 'deepseek-chat',
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          displayName: 'DeepSeek Chat',
          contextWindow: 128_000,
        },
        {
          id: 'local-qwen',
          providerId: 'local',
          modelId: 'qwen3',
          displayName: 'Qwen 3',
          contextWindow: 32_000,
        },
      ],
      activeModelId: 'deepseek-chat',
      timeoutMs: 90_000,
    });
  });

  it.each([
    'ftp://example.test/v1',
    'https://user:secret@example.test/v1',
    'not-a-url',
  ])('rejects an invalid provider URL: %s', baseUrl => {
    expect(() => parseConfig({
      version: 2,
      providers: [{
        id: 'provider',
        name: 'Provider',
        baseUrl,
        credentialRef: 'provider',
        headers: {},
      }],
      models: [],
    })).toThrow();
  });

  it.each(['authorization', 'Proxy-Authorization', 'x-api-key', 'api-key'])(
    'rejects a persisted authentication header: %s',
    header => {
      expect(() => parseConfig({
        version: 2,
        providers: [{
          id: 'provider',
          name: 'Provider',
          baseUrl: 'https://example.test',
          credentialRef: 'provider',
          headers: {[header]: 'secret'},
        }],
        models: [],
      })).toThrow();
    },
  );

  it('rejects a persisted authentication header in legacy configuration', () => {
    expect(() => parseConfig({
      baseUrl: 'https://example.test',
      model: 'wolf-1',
      headers: {authorization: 'Bearer secret'},
    })).toThrow();
  });

  it('migrates legacy main and review models to stable v2 profiles', () => {
    const legacy = {
      baseUrl: 'https://api.example.test/v1/',
      model: 'wolf-1',
      reviewModel: 'wolf-review',
      headers: {'x-tenant': 'alpha'},
      timeoutMs: 90_000,
      contextWindow: 64_000,
    };

    const first = parseConfig(legacy);
    const second = parseConfig({...legacy});

    expect(first).toEqual(second);
    expect(first).toEqual({
      version: 2,
      providers: [{
        id: 'legacy-provider',
        name: 'api.example.test',
        baseUrl: 'https://api.example.test/v1',
        credentialRef: 'legacy',
        headers: {'x-tenant': 'alpha'},
      }],
      models: [
        {
          id: 'legacy-primary-model',
          providerId: 'legacy-provider',
          modelId: 'wolf-1',
          displayName: 'wolf-1',
          contextWindow: 64_000,
        },
        {
          id: 'legacy-review-model',
          providerId: 'legacy-provider',
          modelId: 'wolf-review',
          displayName: 'wolf-review',
          contextWindow: 64_000,
        },
      ],
      activeModelId: 'legacy-primary-model',
      timeoutMs: 90_000,
    });
  });

  it('does not duplicate a legacy review model that matches the main model', () => {
    const config = parseConfig({
      baseUrl: 'https://api.example.test/v1',
      model: 'wolf-1',
      reviewModel: 'wolf-1',
    });

    expect(config.models).toHaveLength(1);
  });

  it.each([
    {
      name: 'an unknown active model',
      input: {
        version: 2,
        providers: [],
        models: [],
        activeModelId: 'missing',
      },
    },
    {
      name: 'duplicate provider IDs',
      input: {
        version: 2,
        providers: [
          {id: 'same', name: 'A', baseUrl: 'https://a.test', credentialRef: 'a', headers: {}},
          {id: 'same', name: 'B', baseUrl: 'https://b.test', credentialRef: 'b', headers: {}},
        ],
        models: [],
      },
    },
    {
      name: 'a model with an unknown provider',
      input: {
        version: 2,
        providers: [],
        models: [{
          id: 'model',
          providerId: 'missing',
          modelId: 'wolf-1',
          displayName: 'Wolf 1',
          contextWindow: 128_000,
        }],
      },
    },
    {
      name: 'duplicate model IDs',
      input: {
        version: 2,
        providers: [{
          id: 'provider',
          name: 'Provider',
          baseUrl: 'https://example.test',
          credentialRef: 'provider',
          headers: {},
        }],
        models: [
          {
            id: 'same',
            providerId: 'provider',
            modelId: 'wolf-1',
            displayName: 'Wolf 1',
            contextWindow: 128_000,
          },
          {
            id: 'same',
            providerId: 'provider',
            modelId: 'wolf-2',
            displayName: 'Wolf 2',
            contextWindow: 128_000,
          },
        ],
      },
    },
    {
      name: 'an empty model ID',
      input: {
        version: 2,
        providers: [{
          id: 'provider',
          name: 'Provider',
          baseUrl: 'https://example.test',
          credentialRef: 'provider',
          headers: {},
        }],
        models: [{
          id: 'model',
          providerId: 'provider',
          modelId: '',
          displayName: 'Wolf 1',
          contextWindow: 128_000,
        }],
      },
    },
    {
      name: 'a context window below 8,000',
      input: {
        version: 2,
        providers: [{
          id: 'provider',
          name: 'Provider',
          baseUrl: 'https://example.test',
          credentialRef: 'provider',
          headers: {},
        }],
        models: [{
          id: 'model',
          providerId: 'provider',
          modelId: 'wolf-1',
          displayName: 'Wolf 1',
          contextWindow: 7_999,
        }],
      },
    },
  ])('rejects $name', ({input}) => {
    expect(() => parseConfig(input)).toThrow();
  });

  it('uses XDG paths when present', () => {
    const configHome = resolve('cfg');
    const dataHome = resolve('data');
    const stateHome = resolve('state');
    expect(getAppPaths({
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
    }, resolve('home', 'wolf'))).toEqual({
      configFile: join(configHome, 'haochen', 'config.json'),
      sessionsDir: join(dataHome, 'haochen', 'sessions'),
      auditDir: join(stateHome, 'haochen', 'audit'),
    });
  });

  it('uses standard XDG fallback paths when variables are absent', () => {
    const home = resolve('home', 'wolf');
    expect(getAppPaths({}, home)).toEqual({
      configFile: join(home, '.config', 'haochen', 'config.json'),
      sessionsDir: join(home, '.local', 'share', 'haochen', 'sessions'),
      auditDir: join(home, '.local', 'state', 'haochen', 'audit'),
    });
  });

  for (const variable of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const) {
    for (const value of ['', '  ', 'relative/haochen']) {
      it(`falls back when ${variable} is not a non-empty absolute path: ${JSON.stringify(value)}`, () => {
        const home = resolve('home', 'wolf');
        expect(getAppPaths({[variable]: value}, home)).toEqual({
          configFile: join(home, '.config', 'haochen', 'config.json'),
          sessionsDir: join(home, '.local', 'share', 'haochen', 'sessions'),
          auditDir: join(home, '.local', 'state', 'haochen', 'audit'),
        });
      });
    }
  }
});

describe('config files', () => {
  it('returns undefined when the config file does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'missing.json');

    try {
      await expect(loadConfig(path)).resolves.toBeUndefined();
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('parses a saved config file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({baseUrl: 'https://example.test/v1/', model: 'wolf-1'}));

    try {
      await expect(loadConfig(path)).resolves.toMatchObject({
        version: 2,
        providers: [{
          baseUrl: 'https://example.test/v1',
        }],
        models: [{
          modelId: 'wolf-1',
        }],
        activeModelId: 'legacy-primary-model',
      });
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('creates parent directories and saves a complete config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'nested', 'config.json');
    const config = parseConfig({baseUrl: 'https://example.test/v1', model: 'wolf-1'});

    try {
      await saveConfig(path, config);

      await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(config, null, 2)}\n`);
      expect(await readdir(join(directory, 'nested'))).toEqual(['config.json']);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('omits runtime API keys when saving a v2 configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'config.json');
    const config = parseConfig({
      version: 2,
      providers: [{
        id: 'provider',
        name: 'Provider',
        baseUrl: 'https://example.test/v1',
        credentialRef: 'provider',
        headers: {},
      }],
      models: [{
        id: 'model',
        providerId: 'provider',
        modelId: 'wolf-1',
        displayName: 'Wolf 1',
        contextWindow: 128_000,
      }],
      activeModelId: 'model',
    });
    const configWithRuntimeSecrets = {
      ...config,
      apiKey: 'top-level-secret',
      providers: config.providers.map(provider => ({
        ...provider,
        apiKey: 'provider-secret',
      })),
    };

    try {
      await saveConfig(path, configWithRuntimeSecrets);

      const saved = await readFile(path, 'utf8');
      expect(saved).not.toContain('top-level-secret');
      expect(saved).not.toContain('provider-secret');
      expect(JSON.parse(saved)).toEqual(config);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it.skipIf(process.platform === 'win32')(
    'saves the config with mode 0600 on POSIX',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'haochen-config-mode-'));
      const path = join(directory, 'config.json');
      const config = parseConfig({
        baseUrl: 'https://example.test/v1',
        model: 'wolf-1',
      });

      try {
        await saveConfig(path, config);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    },
  );

  it('writes a private temporary file beside the target before renaming it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'nested', 'config.json');
    const config = parseConfig({baseUrl: 'https://example.test/v1', model: 'wolf-1'});
    const events: string[] = [];
    const files = {
      mkdir: vi.fn(async () => {
        events.push('mkdir');
      }),
      writeFile: vi.fn(async (
        temporaryPath: string,
        _contents: string,
        _options: {encoding: 'utf8'; mode: number},
      ) => {
        events.push(`write:${temporaryPath}`);
      }),
      rename: vi.fn(async (temporaryPath: string, targetPath: string) => {
        events.push(`rename:${temporaryPath}:${targetPath}`);
      }),
      unlink: vi.fn(async (temporaryPath: string) => {
        events.push(`unlink:${temporaryPath}`);
      }),
    };

    try {
      await saveConfig(path, config, files);

      const [temporaryPath, , options] = files.writeFile.mock.calls[0] ?? [];
      expect(typeof temporaryPath).toBe('string');
      if (typeof temporaryPath !== 'string') throw new Error('missing temporary path');
      expect(dirname(temporaryPath)).toBe(dirname(path));
      expect(temporaryPath).not.toBe(path);
      expect(basename(temporaryPath)).toMatch(/^\.config\.json\.[0-9a-f-]{36}\.tmp$/);
      expect(options).toEqual({encoding: 'utf8', mode: 0o600});
      const [renameSource, renameDestination] = files.rename.mock.calls[0] ?? [];
      expect(renameSource).toBe(temporaryPath);
      expect(renameDestination).toBe(path);
      expect(files.unlink).not.toHaveBeenCalled();
      expect(events).toEqual([
        'mkdir',
        `write:${temporaryPath}`,
        `rename:${temporaryPath}:${path}`,
      ]);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  it('cleans the temporary file and preserves a rename failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'nested', 'config.json');
    const config = parseConfig({baseUrl: 'https://example.test/v1', model: 'wolf-1'});
    const renameFailure = new Error('rename failed');
    const events: string[] = [];
    const files = {
      mkdir: vi.fn(async () => {
        events.push('mkdir');
      }),
      writeFile: vi.fn(async (
        temporaryPath: string,
        _contents: string,
        _options: {encoding: 'utf8'; mode: number},
      ) => {
        events.push(`write:${temporaryPath}`);
      }),
      rename: vi.fn(async (temporaryPath: string) => {
        events.push(`rename:${temporaryPath}`);
        throw renameFailure;
      }),
      unlink: vi.fn(async (temporaryPath: string) => {
        events.push(`unlink:${temporaryPath}`);
      }),
    };

    try {
      await expect(saveConfig(path, config, files)).rejects.toBe(renameFailure);

      const [temporaryPath] = files.writeFile.mock.calls[0] ?? [];
      expect(typeof temporaryPath).toBe('string');
      if (typeof temporaryPath !== 'string') throw new Error('missing temporary path');
      expect(temporaryPath).not.toBe(path);
      const [unlinkPath] = files.unlink.mock.calls[0] ?? [];
      expect(unlinkPath).toBe(temporaryPath);
      expect(unlinkPath).not.toBe(path);
      expect(events).toEqual([
        'mkdir',
        `write:${temporaryPath}`,
        `rename:${temporaryPath}`,
        `unlink:${temporaryPath}`,
      ]);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});
