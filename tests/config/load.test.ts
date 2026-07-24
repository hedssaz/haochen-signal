import {describe, expect, it} from 'vitest';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
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
    expect(getAppPaths({
      XDG_CONFIG_HOME: '/cfg',
      XDG_DATA_HOME: '/data',
      XDG_STATE_HOME: '/state',
    }, '/home/wolf')).toEqual({
      configFile: '/cfg/haochen/config.json',
      sessionsDir: '/data/haochen/sessions',
      auditDir: '/state/haochen/audit',
    });
  });

  it('uses standard XDG fallback paths when variables are absent', () => {
    expect(getAppPaths({}, '/home/wolf')).toEqual({
      configFile: '/home/wolf/.config/haochen/config.json',
      sessionsDir: '/home/wolf/.local/share/haochen/sessions',
      auditDir: '/home/wolf/.local/state/haochen/audit',
    });
  });
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

  it('creates parent directories and saves a private complete config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haochen-config-'));
    const path = join(directory, 'nested', 'config.json');
    const config = parseConfig({baseUrl: 'https://example.test/v1', model: 'wolf-1'});

    try {
      await saveConfig(path, config);

      await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(config, null, 2)}\n`);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(directory, 'nested'))).toEqual(['config.json']);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});
