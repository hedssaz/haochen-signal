import {describe, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig, saveConfig} from '../../src/config/load.js';
import {parseConfig} from '../../src/config/schema.js';
import {getAppPaths} from '../../src/config/paths.js';

describe('configuration', () => {
  it('normalizes baseUrl and applies defaults', () => {
    expect(parseConfig({baseUrl: 'https://example.test/v1/', model: 'wolf-1'})).toMatchObject({
      baseUrl: 'https://example.test/v1',
      model: 'wolf-1',
      timeoutMs: 60_000,
      contextWindow: 128_000,
    });
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
        baseUrl: 'https://example.test/v1',
        model: 'wolf-1',
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
