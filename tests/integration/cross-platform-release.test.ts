import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const root = new URL('../../', import.meta.url);

describe('跨平台发布契约', () => {
  it('在首屏声明恶搞用途，并提供三平台 CI 验证', async () => {
    const [readme, workflow] = await Promise.all([
      readFile(new URL('README.md', root), 'utf8'),
      readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
    ]);

    expect(readme.slice(0, 1_500)).toContain('纯恶搞');
    expect(readme.slice(0, 1_500)).toContain('DO NOT USE');
    expect(readme).toContain('macOS');
    expect(readme).toContain('Linux');
    expect(readme).toContain('Windows PowerShell');
    expect(workflow).toContain('ubuntu-latest');
    expect(workflow).toContain('windows-latest');
    expect(workflow).toContain('macos-latest');
    expect(workflow).toContain('node-version: 20');
    for (const command of [
      'npm ci',
      'npm test',
      'npm run typecheck',
      'npm run build',
      'node dist/cli.mjs --version',
    ]) {
      expect(workflow).toContain(command);
    }
  });
});
