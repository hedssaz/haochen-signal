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
});
