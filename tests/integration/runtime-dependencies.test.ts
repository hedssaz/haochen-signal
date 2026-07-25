import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const root = new URL('../../', import.meta.url);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(path, root), 'utf8'),
  ) as Record<string, unknown>;
}

describe('Node.js 20 运行依赖', () => {
  it('Ink 支持包声明的 Node.js 20 最低版本', async () => {
    const ink = await readJson('node_modules/ink/package.json');

    expect(ink.engines).toMatchObject({node: '>=20'});
  });

  it('显式安装单文件构建需要的 Ink 可选运行依赖', async () => {
    const packageJson = await readJson('package.json');

    expect(packageJson.dependencies).toMatchObject({
      'react-devtools-core': expect.any(String),
    });
  });
});
