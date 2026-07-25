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

  it('exposes character pagination in the read_file model tool schema', async () => {
    const source = await readFile(
      new URL('../../src/cli/index.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('读取工作区文本文件（支持按字符续读）');
    expect(source).toContain('startCharacter: z.number().int().min(0).optional()');
    expect(source).toContain('maxCharacters: z.number().int().min(1).max(65_536).optional()');
    expect(source).toContain("startCharacter: {type: 'integer'}");
    expect(source).toContain("maxCharacters: {type: 'integer'}");
  });
});
