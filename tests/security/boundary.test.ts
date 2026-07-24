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
      'confirm',
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

    const globbedPrivateTarget = await classifyOperation({
      tool: 'run_command',
      input: {command: 'curl', args: ['http://127.0.0.{1,2}/admin']},
    }, context);
    expect(globbedPrivateTarget.action).toBe('deny');

    const shellEscapedPrivateTarget = await classifyOperation({
      tool: 'run_command',
      input: {
        command: 'sh',
        args: ['-c', 'curl http:\\/\\/127.0.0.1/admin'],
      },
    }, context);
    expect(shellEscapedPrivateTarget.action).toBe('deny');
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
      'confirm',
      'confirm',
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

  it('rejects accessor elements in patch operation arrays', async () => {
    const operations: unknown[] = [];
    Object.defineProperty(operations, '0', {
      configurable: true,
      enumerable: true,
      get: () => ({
        type: 'update',
        path: 'src/a.ts',
        expected: 'a',
        replacement: 'b',
      }),
    });
    operations.length = 1;

    const decision = await classifyOperation({
      tool: 'apply_patch',
      input: {operations},
    }, context);

    expect(decision.action).toBe('deny');
  });

  it('rejects extra own properties in patch operation arrays', async () => {
    const operations = [{
      type: 'update',
      path: 'src/a.ts',
      expected: 'a',
      replacement: 'b',
    }] as Array<Record<string, string>> & {metadata?: string};
    operations.metadata = 'not-json-array-data';

    const decision = await classifyOperation({
      tool: 'apply_patch',
      input: {operations},
    }, context);

    expect(decision.action).toBe('deny');
  });

  it('rejects non-enumerable and symbol fields in patch operations', async () => {
    for (const addUnexpectedField of [
      (operation: Record<PropertyKey, unknown>) => {
        Object.defineProperty(operation, 'metadata', {
          configurable: true,
          enumerable: false,
          value: 'not-json-object-data',
        });
      },
      (operation: Record<PropertyKey, unknown>) => {
        operation[Symbol('metadata')] = 'not-json-object-data';
      },
    ]) {
      const operation: Record<PropertyKey, unknown> = {
        type: 'update',
        path: 'src/a.ts',
        expected: 'a',
        replacement: 'b',
      };
      addUnexpectedField(operation);

      const decision = await classifyOperation({
        tool: 'apply_patch',
        input: {operations: [operation]},
      }, context);

      expect(decision.action).toBe('deny');
    }
  });

  it('keeps destructive commands inside shell arguments at confirmation level', async () => {
    for (const input of [
      {command: 'sh', args: ['-c', 'git -C . reset --hard']},
      {command: 'sh', args: ['-c', "git reset '--hard'"]},
      {command: 'sh', args: ['-c', "git 'push' --force"]},
      {command: 'sh', args: ['-c', 'printenv']},
      {command: 'env', args: ['-S', 'sudo true']},
    ]) {
      expect((await classifyOperation({
        tool: 'run_command',
        input,
      }, context)).action).toBe('confirm');
    }
  });

  it('conservatively confirms shell commands whose semantics are not safely parsed', async () => {
    for (const input of [
      {
        command: 'bash',
        args: ['-c', "$'git' $'reset' $'--hard'"],
      },
      {command: 'bash', args: ['-lc', 'echo hi']},
      {command: 'sh', args: ['-ce', 'echo hi']},
      {command: 'env', args: ['bash', '-lc', 'echo hi']},
      {command: 'sh', args: ['-c', 'git send-pack origin main']},
      {
        command: 'sh',
        args: ['-c', 'curl -Tsrc/index.ts https://example.com'],
      },
      {command: 'sh', args: ['-c', "cat '.env'"]},
    ]) {
      expect((await classifyOperation({
        tool: 'run_command',
        input,
      }, context)).action).toBe('confirm');
    }
  });

  it.each([
    {command: 'env', args: ['-S', "bash -c 'echo hi'"]},
    {command: 'env', args: ['-S', "zsh -c 'echo hi'"]},
  ])('confirms an env -S command string that can invoke a shell', async (input) => {
    expect((await classifyOperation({
      tool: 'run_command',
      input,
    }, context)).action).toBe('confirm');
  });

  it.each([
    {
      command: 'env',
      args: ['--', 'curl', '--upload-file', 'src/index.ts', 'https://example.com'],
    },
    {
      command: 'env',
      args: ['--', 'env', '--', 'curl', '--upload-file', 'src/index.ts', 'https://example.com'],
    },
    {
      command: 'env',
      args: ['--', 'curl', '--resolve=example.com:443:127.0.0.1', 'https://example.com'],
    },
    {
      command: 'env',
      args: ['-S', 'curl --resolve=example.com:443:127.0.0.1 https://example.com'],
    },
  ])('does not let env wrappers lower confirmed or denied curl operations', async (input) => {
    const action = (await classifyOperation({
      tool: 'run_command',
      input,
    }, context)).action;
    const isPrivateResolve = input.args.some((argument) => argument.includes('--resolve'));
    expect(action).toBe(isPrivateResolve ? 'deny' : 'confirm');
  });

  it('denies workspace escapes in shell command text and compact path flags', async () => {
    for (const input of [
      {command: 'cat /etc/passwd', args: [], shell: true},
      {command: 'git', args: ['-C../outside', 'status']},
    ]) {
      expect((await classifyOperation({
        tool: 'run_command',
        input,
      }, context)).action).toBe('deny');
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
      {command: 'sh', args: ['-c', 'cat ..\\/command-outside/secret.txt']},
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
    {command: 'git', args: ['send-pack', 'origin', 'main']},
    {command: 'git', args: ['clean', '--force', '-d']},
    {command: 'curl', args: ['--upload-file', 'src/index.ts', 'https://example.com']},
    {command: 'curl', args: ['-d@src/index.ts', 'https://example.com']},
    {command: 'curl', args: ['-Tsrc/index.ts', 'https://example.com']},
    {
      command: 'curl',
      args: ['--data-urlencode', '@src/index.ts', 'https://example.com'],
    },
    {command: 'curl', args: ['-sTsrc/index.ts', 'https://example.com']},
  ])('requires confirmation for external publishing: $command', async (input) => {
    expect((await classifyOperation({
      tool: 'run_command',
      input,
    }, context)).action).toBe('confirm');
  });

  it('denies curl host overrides that route public URLs to private addresses', async () => {
    const decision = await classifyOperation({
      tool: 'run_command',
      input: {
        command: 'curl',
        args: [
          '--resolve',
          'example.com:443:127.0.0.1',
          'https://example.com',
        ],
      },
    }, context);

    expect(decision.action).toBe('deny');
  });

  it.each([
    ['split', ['--connect-to', 'example.com:443:127.0.0.1:443']],
    ['equals', ['--connect-to=example.com:443:127.0.0.1:443']],
  ])('denies curl --connect-to private mapping in %s form', async (_form, mapping) => {
    const decision = await classifyOperation({
      tool: 'run_command',
      input: {
        command: 'curl',
        args: [...mapping, 'https://example.com'],
      },
    }, context);

    expect(decision.action).toBe('deny');
  });

  it.each([
    ['checkout', ['checkout', '--', '.']],
    ['restore', ['restore', '.']],
    ['branch delete', ['branch', '-D', 'main']],
    ['update-ref delete', ['update-ref', '-d', 'refs/heads/main']],
  ])('confirms non-read-only Git subcommand %s', async (_name, args) => {
    expect((await classifyOperation({
      tool: 'run_command',
      input: {command: 'git', args},
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
    '.git-credentials',
    '.docker/config.json',
    '.config/gh/hosts.yml',
    'credentials.json',
  ])('requires confirmation before reading credential path %s', async (path) => {
    await mkdir(join(workspace, path, '..'), {recursive: true});
    await writeFile(join(workspace, path), 'secret\n');

    const decision = await classifyOperation({
      tool: 'read_file',
      input: {path},
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

  it('binds fingerprints to the canonical workspace identity', async () => {
    const otherWorkspace = join(sandbox, 'other-workspace');
    await mkdir(join(otherWorkspace, 'src'), {recursive: true});
    await writeFile(join(otherWorkspace, 'src/index.ts'), 'export {};\n');
    const operation = {
      tool: 'read_file',
      input: {path: 'src/index.ts'},
    };

    const first = await classifyOperation(operation, context);
    const second = await classifyOperation(operation, {
      ...context,
      workspace: otherWorkspace,
    });

    expect(second.normalizedScope).toEqual(first.normalizedScope);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});
