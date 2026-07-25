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
});
