import {execFile} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {runAgentTask, type AgentEvent} from '../../src/agent/loop.js';
import {parseConfig} from '../../src/config/schema.js';
import {createOpenAiCompatibleClient} from '../../src/providers/openai-compatible.js';
import {classifyOperation} from '../../src/security/boundary.js';
import {
  reviewOperation,
  type ConfirmationRequest,
  type ConfirmationResult,
} from '../../src/security/reviewer.js';
import {AuditStore, workspaceId} from '../../src/sessions/audit.js';
import {SessionStore} from '../../src/sessions/store.js';
import {runCommand, type RunCommandInput} from '../../src/tools/command.js';
import {
  applyPatch,
  readFileTool,
  type ApplyPatchInput,
  type ReadFileInput,
} from '../../src/tools/files.js';
import {ToolRegistry} from '../../src/tools/registry.js';
import type {
  ToolDefinitionSpec,
  ToolResult,
} from '../../src/tools/types.js';
import {
  mockTextResponse,
  mockToolCallResponse,
  startMockOpenAiServer,
} from '../fixtures/mock-openai-server.js';

const execFileAsync = promisify(execFile);
const readFileSchema = z.strictObject({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  maxBytes: z.number().int().nonnegative().optional(),
});
const applyPatchSchema = z.strictObject({
  operations: z.array(z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('add'),
      path: z.string(),
      content: z.string(),
    }),
    z.strictObject({
      type: z.literal('update'),
      path: z.string(),
      expected: z.string(),
      replacement: z.string(),
    }),
    z.strictObject({
      type: z.literal('delete'),
      path: z.string(),
      sha256: z.string(),
    }),
  ])),
});
const runCommandSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  shell: z.boolean().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  maxOutputBytes: z.number().int().nonnegative().optional(),
});

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function definition(
  name: string,
  description: string,
  inputSchema: ToolDefinitionSpec<unknown, unknown>['inputSchema'],
  jsonSchema: Record<string, unknown>,
  execute: ToolDefinitionSpec<unknown, unknown>['execute'],
): ToolDefinitionSpec<unknown, unknown> {
  return {name, description, inputSchema, jsonSchema, execute};
}

describe('真实代理工作流', () => {
  let root: string;
  let workspace: string;
  let sessions: SessionStore;
  let audit: AuditStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'haochen-workflow-'));
    workspace = join(root, 'workspace');
    sessions = new SessionStore(join(root, 'sessions'));
    audit = new AuditStore(join(root, 'audit'));
    await mkdir(join(workspace, 'src'), {recursive: true});
    await mkdir(join(workspace, 'test'), {recursive: true});
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  function createRegistry(
    tools: ToolDefinitionSpec<unknown, unknown>[],
    confirm: (
      request: ConfirmationRequest,
    ) => Promise<ConfirmationResult>,
  ): ToolRegistry {
    return new ToolRegistry({
      tools: new Map(tools.map(tool => [tool.name, tool])),
      classify: classifyOperation,
      review: reviewOperation,
      confirm,
      sessionGrants: new Set(),
      audit,
    });
  }

  function modelClient(baseUrl: string, apiKey: string) {
    return createOpenAiCompatibleClient(parseConfig({
      baseUrl,
      model: 'signal-main',
      reviewModel: 'signal-review',
      timeoutMs: 5_000,
    }), apiKey);
  }

  it('通过真实工具读取、修改、测试并保留完整审计轨迹', async () => {
    await writeFile(join(workspace, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {test: 'node --test'},
    }));
    await writeFile(
      join(workspace, 'src/value.js'),
      'export const value = 1;\n',
    );
    await writeFile(
      join(workspace, 'test/value.test.mjs'),
      [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import {value} from '../src/value.js';",
        "test('value', () => assert.equal(value, 2));",
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init', '-q'], {cwd: workspace});
    await execFileAsync('git', ['config', 'user.name', 'Haochen Test'], {
      cwd: workspace,
    });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: workspace,
    });
    await execFileAsync('git', ['add', '.'], {cwd: workspace});
    await execFileAsync('git', ['commit', '-qm', 'initial'], {cwd: workspace});

    const server = await startMockOpenAiServer([
      mockToolCallResponse({
        id: 'call_read',
        name: 'read_file',
        arguments: {path: 'src/value.js'},
      }),
      mockToolCallResponse({
        id: 'call_patch',
        name: 'apply_patch',
        arguments: {
          operations: [{
            type: 'update',
            path: 'src/value.js',
            expected: 'value = 1',
            replacement: 'value = 2',
          }],
        },
      }),
      mockToolCallResponse({
        id: 'call_test',
        name: 'run_command',
        arguments: {command: 'npm', args: ['test']},
      }),
      mockTextResponse('已修改 value 并通过测试。'),
    ]);
    const confirm = vi.fn(async () => 'allow_once' as const);
    const registry = createRegistry([
      definition(
        'read_file',
        '读取文件',
        readFileSchema,
        {type: 'object'},
        (input, context, signal) => readFileTool(
          input as ReadFileInput,
          context,
          signal,
        ),
      ),
      definition(
        'apply_patch',
        '应用结构化补丁',
        applyPatchSchema,
        {type: 'object'},
        (input, context, signal) => applyPatch(
          input as ApplyPatchInput,
          context,
          signal,
        ),
      ),
      definition(
        'run_command',
        '执行前台命令',
        runCommandSchema,
        {type: 'object'},
        (input, context, signal) => runCommand(
          input as RunCommandInput,
          context,
          signal,
        ),
      ),
    ], confirm);
    const apiKey = 'sk-mock-workflow-secret-123456789';
    const client = modelClient(server.baseUrl, apiKey);

    try {
      const events = await collect(runAgentTask({
        task: '把 value 改为 2 并运行测试',
        model: client,
        modelName: 'signal-main',
        registry,
        session: {id: 'workflow', store: sessions},
        workspace,
        tempDir: join(root, 'tool-output'),
        reviewClient: client,
        reviewModel: 'signal-review',
        limits: {maxTurns: 8, maxToolCalls: 16},
        signal: AbortSignal.timeout(10_000),
      }));
      const sessionEvents = await sessions.read('workflow');
      const auditText = await readFile(
        audit.pathFor(workspaceId(workspace)),
        'utf8',
      );
      const {stdout: diff} = await execFileAsync('git', ['diff', '--'], {
        cwd: workspace,
        encoding: 'utf8',
      });

      expect(await readFile(join(workspace, 'src/value.js'), 'utf8')).toBe(
        'export const value = 2;\n',
      );
      expect(events.filter(event => event.type === 'tool_started')).toEqual([
        {type: 'tool_started', name: 'read_file', input: {path: 'src/value.js'}},
        expect.objectContaining({type: 'tool_started', name: 'apply_patch'}),
        {
          type: 'tool_started',
          name: 'run_command',
          input: {command: 'npm', args: ['test']},
        },
      ]);
      expect(events).toContainEqual({
        type: 'assistant_text',
        text: '已修改 value 并通过测试。',
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_finished',
        name: 'run_command',
        result: expect.objectContaining({
          ok: true,
          data: expect.objectContaining({exitCode: 0}),
        }),
      }));
      expect(sessionEvents.filter(event => event.type === 'tool').map(
        event => event.type === 'tool' ? event.tool : '',
      )).toEqual(['read_file', 'apply_patch', 'run_command']);
      expect(server.requests).toHaveLength(4);
      expect(server.requests.slice(1).every(request => (
        (request.body.messages as Array<{role: string}>).some(
          message => message.role === 'tool',
        )
      ))).toBe(true);
      expect(auditText).not.toContain(apiKey);
      expect(diff).toContain('-export const value = 1;');
      expect(diff).toContain('+export const value = 2;');
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('红眼低风险批准自动放行依赖安装且不打断用户', async () => {
    const input = {command: 'npm', args: ['install', 'zod']};
    const boundary = await classifyOperation(
      {tool: 'run_command', input},
      {workspace},
    );
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      ok: true,
      summary: '模拟安装完成',
      data: {exitCode: 0},
    }));
    const server = await startMockOpenAiServer([
      mockToolCallResponse({
        id: 'call_install',
        name: 'run_command',
        arguments: input,
      }),
      mockTextResponse(JSON.stringify({
        verdict: 'approve',
        risk: 'low',
        summary: '安装项目依赖 zod',
        reasons: ['范围明确且与任务一致'],
        affected_scope: boundary.normalizedScope,
        constraints: [],
      })),
      mockTextResponse('zod 已安装。'),
    ]);
    const confirm = vi.fn(async () => 'allow_once' as const);
    const registry = createRegistry([
      definition(
        'run_command',
        '执行前台命令',
        runCommandSchema,
        {type: 'object'},
        execute,
      ),
    ], confirm);
    const client = modelClient(server.baseUrl, 'mock-review-key');

    try {
      await collect(runAgentTask({
        task: '安装 zod',
        model: client,
        modelName: 'signal-main',
        registry,
        session: {id: 'review-install', store: sessions},
        workspace,
        tempDir: join(root, 'tool-output'),
        reviewClient: client,
        reviewModel: 'signal-review',
        limits: {maxTurns: 4, maxToolCalls: 4},
        signal: AbortSignal.timeout(10_000),
      }));

      expect(execute).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
      expect(server.requests.map(request => request.body.model)).toEqual([
        'signal-main',
        'signal-review',
        'signal-main',
      ]);
      expect(server.requests[1]?.body.tool_choice).toBe('none');
    } finally {
      await server.close();
    }
  });

  it('sudo 依赖安装绕过红眼并强制人工确认', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      ok: true,
      summary: '模拟 sudo 安装完成',
      data: {exitCode: 0},
    }));
    const server = await startMockOpenAiServer([
      mockToolCallResponse({
        id: 'call_sudo',
        name: 'run_command',
        arguments: {
          command: 'sudo',
          args: ['npm', 'install', 'zod'],
        },
      }),
      mockTextResponse('人工确认后完成。'),
    ]);
    const confirm = vi.fn(async () => 'allow_once' as const);
    const registry = createRegistry([
      definition(
        'run_command',
        '执行前台命令',
        runCommandSchema,
        {type: 'object'},
        execute,
      ),
    ], confirm);
    const client = modelClient(server.baseUrl, 'mock-confirm-key');

    try {
      await collect(runAgentTask({
        task: '使用 sudo 安装 zod',
        model: client,
        modelName: 'signal-main',
        registry,
        session: {id: 'confirm-install', store: sessions},
        workspace,
        tempDir: join(root, 'tool-output'),
        reviewClient: client,
        reviewModel: 'signal-review',
        limits: {maxTurns: 4, maxToolCalls: 4},
        signal: AbortSignal.timeout(10_000),
      }));

      expect(execute).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledOnce();
      expect(server.requests).toHaveLength(2);
      expect(server.requests.every(
        request => request.body.model === 'signal-main',
      )).toBe(true);
    } finally {
      await server.close();
    }
  });
});
