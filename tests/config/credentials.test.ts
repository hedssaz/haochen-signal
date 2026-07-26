import {describe, expect, it, vi} from 'vitest';
import {
  providerApiKeyEnvironmentVariable,
  readMacOsKeychain,
  resolveApiKey,
  saveMacOsKeychain,
} from '../../src/config/credentials.js';

const deepSeekProvider = {
  id: 'deepseek',
  credentialRef: 'deepseek-credential',
};

describe('resolveApiKey', () => {
  it('prefers HAOCHEN_API_KEY without reading keychain', async () => {
    const keychain = vi.fn(async () => 'keychain-value');

    await expect(resolveApiKey({
      env: {HAOCHEN_API_KEY: 'env-value'},
      readKeychain: keychain,
      prompt: async () => 'prompt-value',
    })).resolves.toBe('env-value');

    expect(keychain).not.toHaveBeenCalled();
  });

  it('uses a keychain value without prompting', async () => {
    const prompt = vi.fn(async () => 'prompt-value');

    await expect(resolveApiKey({
      env: {},
      readKeychain: async () => 'keychain-value',
      prompt,
    })).resolves.toBe('keychain-value');

    expect(prompt).not.toHaveBeenCalled();
  });

  it('falls back through keychain and prompt', async () => {
    await expect(resolveApiKey({
      env: {},
      readKeychain: async () => undefined,
      prompt: async () => 'temporary-value',
    })).resolves.toBe('temporary-value');
  });

  it('trims an environment key before returning it', async () => {
    await expect(resolveApiKey({
      env: {HAOCHEN_API_KEY: '  env-value  '},
      readKeychain: async () => 'keychain-value',
      prompt: async () => 'prompt-value',
    })).resolves.toBe('env-value');
  });

  it('prefers the environment variable derived from the provider stable ID', async () => {
    const keychain = vi.fn(async () => 'keychain-value');

    await expect(resolveApiKey({
      provider: deepSeekProvider,
      env: {
        HAOCHEN_PROVIDER_646565707365656B_API_KEY: '  provider-env-value  ',
        HAOCHEN_API_KEY: 'legacy-env-value',
      },
      readKeychain: keychain,
      prompt: async () => 'prompt-value',
    })).resolves.toBe('provider-env-value');

    expect(keychain).not.toHaveBeenCalled();
  });

  it('does not reuse the legacy environment key for a non-legacy provider', async () => {
    const prompt = vi.fn(async () => 'temporary-value');

    await expect(resolveApiKey({
      provider: deepSeekProvider,
      env: {HAOCHEN_API_KEY: 'legacy-env-value'},
      readKeychain: async () => undefined,
      prompt,
    })).resolves.toBe('temporary-value');

    expect(prompt).toHaveBeenCalledOnce();
  });

  it('passes provider.id to Keychain resolution', async () => {
    const readKeychain = vi.fn(async () => 'provider-keychain-value');

    await expect(resolveApiKey({
      provider: deepSeekProvider,
      env: {},
      readKeychain,
      prompt: async () => 'prompt-value',
    })).resolves.toBe('provider-keychain-value');

    expect(readKeychain).toHaveBeenCalledWith('deepseek');
  });

  it('keeps the generic environment variable for migrated legacy credentials', async () => {
    await expect(resolveApiKey({
      provider: {id: 'legacy-provider', credentialRef: 'legacy'},
      env: {HAOCHEN_API_KEY: ' legacy-value '},
      readKeychain: async () => undefined,
      prompt: async () => 'prompt-value',
    })).resolves.toBe('legacy-value');
  });

  it('does not treat a legacy credentialRef as the legacy provider identity', async () => {
    await expect(resolveApiKey({
      provider: {id: 'not-legacy', credentialRef: 'legacy'},
      env: {HAOCHEN_API_KEY: 'legacy-value'},
      readKeychain: async () => undefined,
      prompt: async () => 'temporary-value',
    })).resolves.toBe('temporary-value');
  });
});

describe('providerApiKeyEnvironmentVariable', () => {
  it.each([
    ['deepseek', 'HAOCHEN_PROVIDER_646565707365656B_API_KEY'],
    ['中文', 'HAOCHEN_PROVIDER_E4B8ADE69687_API_KEY'],
  ])('maps stable provider ID %j to %s', (providerId, expected) => {
    expect(providerApiKeyEnvironmentVariable(providerId)).toBe(expected);
  });

  it('does not collide for punctuation, case or non-ASCII provider IDs', () => {
    const names = [
      'acme-prod',
      'acme_prod',
      'ACME-PROD',
      '中文',
    ].map(providerApiKeyEnvironmentVariable);

    expect(new Set(names)).toHaveLength(names.length);
    expect(names).toEqual(names.map(name => expect.stringMatching(
      /^HAOCHEN_PROVIDER_[0-9A-F]+_API_KEY$/,
    )));
  });

  it('rejects an empty provider ID', () => {
    expect(() => providerApiKeyEnvironmentVariable('')).toThrow(
      '供应商 ID 不能为空',
    );
  });
});

describe('macOS Keychain adapter', () => {
  it('reads the Haochen service password through an injected runner', async () => {
    const run = vi.fn(async () => ({stdout: ' stored-key\n'}));

    await expect(readMacOsKeychain(run, 'darwin')).resolves.toBe('stored-key');
    expect(run).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-a',
      'haochen',
      '-s',
      'haochen-signal',
      '-w',
    ]);
  });

  it('accepts a runner that returns the password directly', async () => {
    await expect(readMacOsKeychain(async () => 'stored-key\n', 'darwin')).resolves.toBe('stored-key');
  });

  it('reads a provider-specific Keychain service item', async () => {
    const run = vi.fn(async () => ({stdout: ' provider-key\n'}));

    await expect(
      readMacOsKeychain(run, 'darwin', 'deepseek'),
    ).resolves.toBe('provider-key');
    expect(run).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-a',
      'haochen',
      '-s',
      'haochen-signal:deepseek',
      '-w',
    ]);
  });

  it('falls back to the old Keychain service for a migrated legacy credential', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('haochen-signal:legacy-provider')) {
        throw new Error('item not found');
      }
      return {stdout: ' old-key\n'};
    });

    await expect(
      readMacOsKeychain(run, 'darwin', 'legacy-provider'),
    ).resolves.toBe('old-key');
    expect(run).toHaveBeenNthCalledWith(1, 'security', [
      'find-generic-password',
      '-a',
      'haochen',
      '-s',
      'haochen-signal:legacy-provider',
      '-w',
    ]);
    expect(run).toHaveBeenNthCalledWith(2, 'security', [
      'find-generic-password',
      '-a',
      'haochen',
      '-s',
      'haochen-signal',
      '-w',
    ]);
  });

  it('returns undefined without running security outside macOS', async () => {
    const run = vi.fn(async () => ({stdout: 'stored-key'}));

    await expect(readMacOsKeychain(run, 'linux')).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('updates the Haochen service password through an injected runner', async () => {
    const run = vi.fn(async () => ({stdout: ''}));

    await expect(saveMacOsKeychain('stored-key', run, 'darwin')).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('security', [
      'add-generic-password',
      '-U',
      '-a',
      'haochen',
      '-s',
      'haochen-signal',
      '-w',
      'stored-key',
    ]);
  });

  it('updates a provider-specific Keychain service item', async () => {
    const run = vi.fn(async () => ({stdout: ''}));

    await expect(
      saveMacOsKeychain('stored-key', run, 'darwin', 'deepseek'),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith('security', [
      'add-generic-password',
      '-U',
      '-a',
      'haochen',
      '-s',
      'haochen-signal:deepseek',
      '-w',
      'stored-key',
    ]);
  });
});
