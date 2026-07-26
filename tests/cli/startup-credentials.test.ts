import {describe, expect, it, vi} from 'vitest';
import {resolveStartupApiKey} from '../../src/cli/startup-credentials.js';

describe('resolveStartupApiKey', () => {
  it('prompts for a temporary hidden key when config already exists and no other source has one', async () => {
    const read = vi.fn(async () => 'temporary-key');
    const close = vi.fn();
    const createInput = vi.fn(() => ({read, close}));

    await expect(resolveStartupApiKey({
      env: {},
      readKeychain: async () => undefined,
      createInput,
      write: () => undefined,
    })).resolves.toBe('temporary-key');

    expect(read).toHaveBeenCalledWith('API Key：', {hidden: true});
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not create a prompt when the environment already has a key', async () => {
    const createInput = vi.fn();

    await expect(resolveStartupApiKey({
      env: {HAOCHEN_API_KEY: 'environment-key'},
      readKeychain: async () => undefined,
      createInput,
      write: () => undefined,
    })).resolves.toBe('environment-key');

    expect(createInput).not.toHaveBeenCalled();
  });

  it('uses a provider-specific environment key without prompting', async () => {
    const createInput = vi.fn();
    const readKeychain = vi.fn(async () => undefined);

    await expect(resolveStartupApiKey({
      provider: {
        id: 'deepseek',
        name: 'DeepSeek',
        credentialRef: 'deepseek-credential',
      },
      env: {
        HAOCHEN_PROVIDER_0064006500650070007300650065006B_API_KEY: 'provider-key',
      },
      readKeychain,
      createInput,
      write: () => undefined,
    })).resolves.toBe('provider-key');

    expect(readKeychain).not.toHaveBeenCalled();
    expect(createInput).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'] as const)(
    'uses hidden temporary input for a provider on %s',
    async platform => {
      const read = vi.fn(async () => ' temporary-provider-key ');
      const close = vi.fn();
      const createInput = vi.fn(() => ({read, close}));
      const readKeychain = vi.fn(async () => undefined);

      await expect(resolveStartupApiKey({
        provider: {
          id: 'deepseek',
          name: 'DeepSeek',
          credentialRef: 'deepseek-credential',
        },
        platform,
        env: {},
        readKeychain,
        createInput,
        write: () => undefined,
      })).resolves.toBe('temporary-provider-key');

      expect(readKeychain).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledWith('DeepSeek API Key：', {hidden: true});
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('passes provider.id to Keychain on macOS before opening temporary input', async () => {
    const createInput = vi.fn();
    const readKeychain = vi.fn(async () => 'keychain-provider-key');

    await expect(resolveStartupApiKey({
      provider: {
        id: 'deepseek',
        name: 'DeepSeek',
        credentialRef: 'deepseek-credential',
      },
      platform: 'darwin',
      env: {},
      readKeychain,
      createInput,
      write: () => undefined,
    })).resolves.toBe('keychain-provider-key');

    expect(readKeychain).toHaveBeenCalledWith('deepseek', false);
    expect(createInput).not.toHaveBeenCalled();
  });

  it('keeps the legacy global environment key fallback for a migrated provider', async () => {
    const createInput = vi.fn();
    const readKeychain = vi.fn(async () => undefined);

    await expect(resolveStartupApiKey({
      provider: {
        id: 'legacy-provider',
        name: '旧供应商',
        credentialRef: 'legacy',
      },
      env: {HAOCHEN_API_KEY: 'legacy-environment-key'},
      readKeychain,
      createInput,
      write: () => undefined,
    })).resolves.toBe('legacy-environment-key');

    expect(readKeychain).not.toHaveBeenCalled();
    expect(createInput).not.toHaveBeenCalled();
  });

  it('allows the old Keychain service only for a migrated legacy provider', async () => {
    const createInput = vi.fn();
    const readKeychain = vi.fn(async () => 'legacy-keychain-key');

    await expect(resolveStartupApiKey({
      provider: {
        id: 'legacy-provider',
        name: '旧供应商',
        credentialRef: 'legacy',
      },
      platform: 'darwin',
      env: {},
      readKeychain,
      createInput,
      write: () => undefined,
    })).resolves.toBe('legacy-keychain-key');

    expect(readKeychain).toHaveBeenCalledWith('legacy-provider', true);
    expect(createInput).not.toHaveBeenCalled();
  });
});
