import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {classifyOperation} from '../../src/security/boundary.js';
import type {ToolContext} from '../../src/tools/types.js';

describe('classifyOperation', () => {
  let sandbox: string;
  let workspace: string;
  let context: ToolContext;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'haochen-boundary-'));
    workspace = join(sandbox, 'workspace');
    await mkdir(join(workspace, 'src'), {recursive: true});
    await writeFile(join(workspace, 'src/index.ts'), 'export {};\n');
    await writeFile(join(workspace, 'src/a.ts'), 'a\n');
    await writeFile(join(workspace, 'src/old.ts'), 'old\n');
    await writeFile(join(workspace, '.env'), 'TOKEN=secret\n');
    context = {
      workspace,
      tempDir: join(sandbox, 'temp'),
    };
  });

  afterEach(async () => {
    await rm(sandbox, {recursive: true, force: true});
  });

  it.each([
    ['read_file', {path: 'src/index.ts'}, 'allow'],
    ['git_status', {}, 'allow'],
    ['run_command', {command: 'npm', args: ['test']}, 'allow'],
    [
      'run_command',
      {command: 'npm', args: ['install', 'zod']},
      'review',
    ],
    [
      'run_command',
      {command: 'sh', args: ['-c', 'echo hi | tee out']},
      'review',
    ],
    ['run_command', {command: 'sudo', args: ['true']}, 'confirm'],
    [
      'run_command',
      {command: 'git', args: ['reset', '--hard']},
      'confirm',
    ],
    [
      'apply_patch',
      {
        operations: [{
          type: 'update',
          path: 'src/a.ts',
          expected: 'a',
          replacement: 'b',
        }],
      },
      'allow',
    ],
    [
      'apply_patch',
      {
        operations: [{
          type: 'add',
          path: 'src/new.ts',
          content: 'x',
        }],
      },
      'review',
    ],
    [
      'apply_patch',
      {
        operations: [{
          type: 'delete',
          path: 'src/old.ts',
          sha256: 'abc',
        }],
      },
      'review',
    ],
    [
      'apply_patch',
      {
        operations: [{
          type: 'delete',
          path: '../x',
          sha256: 'x',
        }],
      },
      'deny',
    ],
    [
      'run_command',
      {command: 'node', args: ['server.js', '--port', '3000']},
      'review',
    ],
  ] as const)('%s is classified as %s', async (tool, input, expected) => {
    const decision = await classifyOperation({tool, input}, context);
    expect(decision.action).toBe(expected);
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['list_files', {}],
    ['search_text', {query: 'export'}],
    ['git_diff', {}],
    ['git_log', {}],
    ['web_search', {query: 'TypeScript documentation'}],
    ['web_fetch', {url: 'https://example.com/docs'}],
    ['run_command', {command: 'npm', args: ['run', 'test']}],
    ['run_command', {command: 'npm', args: ['run', 'typecheck']}],
    ['run_command', {command: 'npm', args: ['run', 'lint']}],
    ['run_command', {command: 'npm', args: ['run', 'build']}],
    ['run_command', {command: 'npx', args: ['vitest', 'run']}],
    ['run_command', {command: 'npx', args: ['tsc', '--noEmit']}],
  ] as const)('allows the fixed low-risk operation %s', async (tool, input) => {
    expect((await classifyOperation({tool, input}, context)).action).toBe(
      'allow',
    );
  });

  it('applies deny before confirm or review', async () => {
    const outsideDelete = await classifyOperation({
      tool: 'run_command',
      input: {command: 'sudo', args: ['rm', '../secret']},
    }, context);
    expect(outsideDelete.action).toBe('deny');

    const unknown = await classifyOperation({
      tool: 'RUN_COMMAND',
      input: {command: 'sudo', args: ['true']},
    }, context);
    expect(unknown.action).toBe('deny');
  });

  it('rejects traversal and real symlink escapes for every path mode', async () => {
    const outside = join(sandbox, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(workspace, 'linked'));

    for (const operation of [
      {tool: 'read_file', input: {path: '../outside/secret.txt'}},
      {tool: 'read_file', input: {path: 'linked/secret.txt'}},
      {
        tool: 'apply_patch',
        input: {
          operations: [{
            type: 'add',
            path: 'linked/new.ts',
            content: 'x',
          }],
        },
      },
    ]) {
      const decision = await classifyOperation(operation, context);
      expect(decision.action).toBe('deny');
      expect(decision.risk).toBe('high');
    }
  });

  it.each([
    'ftp://example.com/file',
    'http://localhost/admin',
    'http://LOCALHOST./admin',
    'http://127.0.0.1/admin',
    'http://127%2e0%2e0%2e1/admin',
    'http://[::1]/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/private',
    'https://user:password@example.com/private',
    '',
  ])('denies invalid or non-public web target %s', async (url) => {
    const decision = await classifyOperation({
      tool: 'web_fetch',
      input: {url},
    }, context);
    expect(decision.action).toBe('deny');
  });

  it('normalizes public command URLs and denies encoded private targets', async () => {
    const publicTarget = await classifyOperation({
      tool: 'run_command',
      input: {command: 'curl', args: ['https://EXAMPLE.com:443/docs']},
    }, context);
    expect(publicTarget.action).toBe('review');
    expect(publicTarget.normalizedScope).toContain(
      'url:https://example.com/docs',
    );

    const privateTarget = await classifyOperation({
      tool: 'run_command',
      input: {command: 'curl', args: ['http://127%2e0%2e0%2e1/admin']},
    }, context);
    expect(privateTarget.action).toBe('deny');
  });

  it('does not allow aliases, case changes, shell mode, or empty args to bypass command rules', async () => {
    const decisions = await Promise.all([
      classifyOperation({
        tool: 'run_command',
        input: {command: '/usr/bin/sudo', args: ['true']},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: 'SUDO', args: ['true']},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: '/usr/bin/env', args: ['sudo', 'true']},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: '/usr/bin/git', args: ['reset', '--hard']},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: 'GIT', args: ['push', '--force']},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: 'npm', args: ['test'], shell: true},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: '/bin/bash', args: ['-c', 'npm test']},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: 'npm', args: []},
      }, context),
      classifyOperation({
        tool: 'run_command',
        input: {command: 'npm'},
      }, context),
    ]);

    expect(decisions.map(({action}) => action)).toEqual([
      'confirm',
      'confirm',
      'confirm',
      'confirm',
      'confirm',
      'review',
      'review',
      'review',
      'review',
    ]);
  });

  it('does not let sparse arrays bypass exact command matching', async () => {
    const sparseArgs = new Array<string>(1);
    const decision = await classifyOperation({
      tool: 'run_command',
      input: {command: 'npm', args: sparseArgs},
    }, context);
    expect(decision.action).toBe('deny');
  });

  it('keeps destructive commands inside shell arguments at confirmation level', async () => {
    for (const input of [
      {command: 'sh', args: ['-c', 'git -C . reset --hard']},
      {command: 'env', args: ['-S', 'sudo true']},
    ]) {
      expect((await classifyOperation({
        tool: 'run_command',
        input,
      }, context)).action).toBe('confirm');
    }
  });

  it('denies traversal and symlink escapes embedded in command arguments', async () => {
    const outside = join(sandbox, 'command-outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(workspace, 'command-link'));

    for (const input of [
      {command: 'cat', args: ['command-link/secret.txt']},
      {command: 'sh', args: ['-c', 'cat ../command-outside/secret.txt']},
    ]) {
      expect((await classifyOperation({
        tool: 'run_command',
        input,
      }, context)).action).toBe('deny');
    }
  });

  it.each([
    {command: 'npm', args: ['publish']},
    {command: 'git', args: ['push']},
    {command: 'curl', args: ['--upload-file', 'src/index.ts', 'https://example.com']},
  ])('requires confirmation for external publishing: $command', async (input) => {
    expect((await classifyOperation({
      tool: 'run_command',
      input,
    }, context)).action).toBe('confirm');
  });

  it.each([
    {command: 'pnpm', args: ['add', 'zod']},
    {command: 'node', args: ['server.js', 'listen']},
    {command: 'npm', args: ['start']},
    {command: 'nohup', args: ['node', 'worker.js']},
    {command: 'custom-tool', args: []},
  ])('reviews unrecognized or long-running commands: $command', async (input) => {
    expect((await classifyOperation({
      tool: 'run_command',
      input,
    }, context)).action).toBe('review');
  });

  it('requires confirmation before reading likely credential files', async () => {
    const decision = await classifyOperation({
      tool: 'read_file',
      input: {path: '.env'},
    }, context);
    expect(decision.action).toBe('confirm');
  });

  it.each([
    {tool: '', input: {}},
    {tool: 'read_file', input: {}},
    {tool: 'run_command', input: {command: '', args: []}},
    {tool: 'run_command', input: {command: 'npm', args: 'test'}},
    {tool: 'apply_patch', input: {operations: []}},
    {tool: 'web_search', input: {query: ''}},
    {tool: 'web_fetch', input: {url: 42}},
  ])('denies malformed input %#', async (operation) => {
    expect((await classifyOperation(
      operation as {tool: string; input: unknown},
      context,
    )).action).toBe('deny');
  });

  it('normalizes equivalent inputs and hashes stable JSON deterministically', async () => {
    const first = await classifyOperation({
      tool: 'run_command',
      input: {
        command: 'npm',
        args: ['test'],
        cwd: 'src/..',
        shell: false,
      },
    }, context);
    const second = await classifyOperation({
      tool: 'run_command',
      input: {
        shell: false,
        cwd: '.',
        args: ['test'],
        command: 'npm',
      },
    }, context);
    const changed = await classifyOperation({
      tool: 'run_command',
      input: {
        command: 'npm',
        args: ['run', 'test'],
        cwd: '.',
        shell: false,
      },
    }, context);

    expect(first.normalizedScope).toEqual(second.normalizedScope);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it('canonicalizes real paths in scope and fingerprint', async () => {
    const direct = await classifyOperation({
      tool: 'read_file',
      input: {path: 'src/index.ts'},
    }, context);
    const dotted = await classifyOperation({
      tool: 'read_file',
      input: {path: 'src/../src/index.ts'},
    }, context);

    expect(direct.normalizedScope).toEqual(['read:src/index.ts']);
    expect(dotted.normalizedScope).toEqual(direct.normalizedScope);
    expect(dotted.fingerprint).toBe(direct.fingerprint);
  });
});
