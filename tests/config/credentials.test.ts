import {describe, expect, it, vi} from 'vitest';
import {readMacOsKeychain, resolveApiKey, saveMacOsKeychain} from '../../src/config/credentials.js';

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
});
