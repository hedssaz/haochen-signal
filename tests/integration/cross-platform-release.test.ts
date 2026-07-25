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
    expect(readme).toContain(
      'No guarantees of correctness, security, data integrity, or compatibility are provided.',
    );
    for (const row of [
      "| macOS | POSIX Shell | `npm install --global .` | `macos-latest` | 环境变量、Keychain 或本次隐藏输入 |",
      "| Linux | POSIX Shell | `npm install --global .` | `ubuntu-latest` | 环境变量或本次隐藏输入 |",
      "| Windows | Windows PowerShell | `npm install --global .` | `windows-latest` | 环境变量或本次隐藏输入 |",
    ]) {
      expect(readme).toContain(row);
    }
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
