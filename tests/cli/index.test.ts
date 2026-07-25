import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

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
});
