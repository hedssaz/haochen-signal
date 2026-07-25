import {describe, expect, it, vi} from 'vitest';
import {
  credentialSaverForPlatform,
  resolveUserHome,
} from '../../src/cli/platform.js';

describe('CLI platform integration', () => {
  it.each([{}, {HOME: ''}, {HOME: '   '}])(
    'falls back to os.homedir input when HOME is unavailable',
    env => {
      expect(resolveUserHome(env, '/users/haochen')).toBe('/users/haochen');
    },
  );

  it('uses a non-empty HOME when supplied', () => {
    expect(resolveUserHome({HOME: '/custom/home'}, '/fallback')).toBe('/custom/home');
  });

  it.each(['linux', 'win32'] as const)(
    'does not expose a Keychain saver on %s',
    platform => {
      expect(credentialSaverForPlatform(platform, vi.fn())).toBeUndefined();
    },
  );

  it('exposes the injected Keychain saver on macOS', async () => {
    const save = vi.fn(async () => undefined);
    const selected = credentialSaverForPlatform('darwin', save);
    await selected?.('secret');
    expect(save).toHaveBeenCalledWith('secret');
  });
});
