import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);
const root = new URL('../../', import.meta.url);
const buildFiles = ['dist/cli.mjs', 'dist/haochen-onefile.mjs'] as const;
let npmCache = '';

async function runNode(args: string[]) {
  return execFileAsync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

describe.sequential('发布构建', () => {
  beforeAll(async () => {
    npmCache = await mkdtemp(join(tmpdir(), 'haochen-npm-cache-'));
    await runNode(['scripts/build.mjs']);
  });

  afterAll(async () => {
    await rm(npmCache, {recursive: true, force: true});
  });

  it('生成两个权限为 0755 的可执行构建', async () => {
    for (const file of buildFiles) {
      const fileStat = await stat(new URL(file, root));
      expect(fileStat.mode & 0o777, file).toBe(0o755);
    }
  });

  it('重新构建时清除 dist 中的过期文件', async () => {
    const staleFile = new URL('dist/stale-build.txt', root);
    await writeFile(staleFile, 'stale');

    await runNode(['scripts/build.mjs']);

    await expect(stat(staleFile)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('两个构建都只有一个位于首行的 shebang', async () => {
    for (const file of buildFiles) {
      const source = await readFile(new URL(file, root), 'utf8');
      expect(source.split('\n')[0], file).toBe('#!/usr/bin/env node');
      expect(source.match(/^#!/gm), file).toHaveLength(1);
    }
  });

  it('单文件构建不压缩并包含全部运行依赖', async () => {
    const [standardSource, oneFileSource, packageSource] = await Promise.all([
      readFile(new URL('dist/cli.mjs', root), 'utf8'),
      readFile(
        new URL('dist/haochen-onefile.mjs', root),
        'utf8',
      ),
      readFile(new URL('package.json', root), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      dependencies: Record<string, string>;
    };

    expect(standardSource).toMatch(
      /\bfrom\s+["'](?:ink|react|zod)["']/,
    );
    expect(standardSource).not.toContain('// node_modules/');
    expect(oneFileSource.split('\n').length).toBeGreaterThan(1_000);
    for (const dependency of Object.keys(packageJson.dependencies)) {
      const specifier = `${escapeRegExp(dependency)}(?:/[^"']*)?`;
      expect(oneFileSource, dependency).not.toMatch(new RegExp(
        `(?:\\bfrom\\s+|\\bimport\\s*(?:\\(\\s*)?)["']${specifier}["']`,
        'u',
      ));
    }
    expect(oneFileSource).toContain('// node_modules/');
  });

  it('两个构建提供完全一致的帮助和版本输出', async () => {
    const [standardHelp, oneFileHelp, standardVersion, oneFileVersion] =
      await Promise.all([
        runNode(['dist/cli.mjs', '--help']),
        runNode(['dist/haochen-onefile.mjs', '--help']),
        runNode(['dist/cli.mjs', '--version']),
        runNode(['dist/haochen-onefile.mjs', '--version']),
      ]);

    expect(standardHelp.stderr).toBe('');
    expect(oneFileHelp.stderr).toBe('');
    expect(standardHelp.stdout).toBe(oneFileHelp.stdout);
    expect(standardVersion.stderr).toBe('');
    expect(oneFileVersion.stderr).toBe('');
    expect(standardVersion.stdout).toBe('0.1.0\n');
    expect(oneFileVersion.stdout).toBe(standardVersion.stdout);
  });

  it('npm 发布包只包含白名单文件', async () => {
    const {stdout, stderr} = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json', '--silent'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {...process.env, npm_config_cache: npmCache},
      },
    );
    const result = JSON.parse(stdout) as Array<{
      files: Array<{path: string}>;
    }>;
    const files = result[0]?.files.map(({path}) => path).sort();

    expect(stderr).toBe('');
    expect(files).toEqual([
      'CHANGELOG.md',
      'README.md',
      'dist/cli.mjs',
      'dist/haochen-onefile.mjs',
      'package.json',
    ]);
  });
});
