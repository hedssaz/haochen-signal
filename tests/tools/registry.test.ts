import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {scriptedModel} from '../helpers/scripted-model.js';
import {classifyOperation} from '../../src/security/boundary.js';
import type {
  ConfirmationResult,
  ReviewDecision,
} from '../../src/security/reviewer.js';
import {AuditStore, workspaceId} from '../../src/sessions/audit.js';
import {
  ToolRegistry,
  type ToolExecutionContext,
  type ToolRegistryOptions,
} from '../../src/tools/registry.js';
import type {
  ToolDefinitionSpec,
  ToolResult,
} from '../../src/tools/types.js';

const commandSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  shell: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  maxOutputBytes: z.number().optional(),
});

const approved: ReviewDecision = {
  verdict: 'approve',
  risk: 'low',
  summary: '操作与当前任务一致',
  reasons: ['范围明确'],
  affected_scope: ['package.json'],
  constraints: [],
};

const askUser: ReviewDecision = {
  verdict: 'ask_user',
  risk: 'high',
  summary: '需要用户确认',
  reasons: ['自动审查无法证明安全'],
  affected_scope: ['package.json'],
  constraints: [],
};

const denied: ReviewDecision = {
  verdict: 'deny',
  risk: 'high',
  summary: '拒绝操作',
  reasons: ['范围不可接受'],
  affected_scope: [],
  constraints: [],
};

describe('tool execution registry', () => {
  let root: string;
  let workspace: string;
  let audit: AuditStore;
  let executionContext: ToolExecutionContext;
  let executeTool: ReturnType<
    typeof vi.fn<ToolDefinitionSpec<unknown, unknown>['execute']>
  >;
  let review: ToolRegistryOptions['review'];
  let confirm: ToolRegistryOptions['confirm'];
  let sessionGrants: Set<string>;
  let tools: Map<string, ToolDefinitionSpec<unknown, unknown>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'haochen-registry-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    audit = new AuditStore(join(root, 'audit'));
    executionContext = {
      workspace,
      tempDir: join(root, 'tool-output'),
      taskSummary: '验证项目改动',
      reviewClient: scriptedModel([]),
      signal: AbortSignal.timeout(5_000),
    };
    executeTool = vi.fn(async (
      input: unknown,
    ): Promise<ToolResult> => ({
      ok: true,
      summary: '工具已执行',
      data: {input},
    }));
    const commandDefinition: ToolDefinitionSpec<unknown, unknown> = {
      name: 'run_command',
      description: '执行前台命令',
      inputSchema: commandSchema,
      jsonSchema: {type: 'object'},
      execute: executeTool,
    };
    tools = new Map([['run_command', commandDefinition]]);
    review = vi.fn(async () => approved);
    confirm = vi.fn(async (): Promise<ConfirmationResult> => 'allow_once');
    sessionGrants = new Set();
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  function registry(
    overrides: Partial<ToolRegistryOptions> = {},
  ): ToolRegistry {
    return new ToolRegistry({
      tools,
      classify: classifyOperation,
      review,
      confirm,
      sessionGrants,
      audit,
      ...overrides,
    });
  }

  it('validates the tool schema before classification', async () => {
    const classify = vi.fn(classifyOperation);
    const result = await registry({classify}).execute(
      'run_command',
      {command: 'npm', args: ['test'], unexpected: true},
      executionContext,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'INVALID_INPUT'},
    });
    expect(classify).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('executes allow operations without invoking reviewer or confirmation', async () => {
    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['test']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(review).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('automatically executes a review operation approved by red-eye review', async () => {
    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', '--ignore-scripts', 'vitest']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(review).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('asks for confirmation when review cannot approve automatically', async () => {
    review = vi.fn(async () => askUser);

    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', 'vitest']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(review).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      operation: {
        tool: 'run_command',
        input: {command: 'npm', args: ['install', 'vitest']},
      },
      review: askUser,
    }));
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('sends forced-confirm operations directly to the user without AI review', async () => {
    const result = await registry().execute(
      'run_command',
      {command: 'sudo', args: ['npm', 'test']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(review).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('keeps allow_session grants in memory for only the identical fingerprint', async () => {
    confirm = vi.fn(async (): Promise<ConfirmationResult> => 'allow_session');
    const toolRegistry = registry();
    const operation = {command: 'sudo', args: ['npm', 'test']};

    await toolRegistry.execute('run_command', operation, executionContext);
    await toolRegistry.execute('run_command', operation, executionContext);
    await toolRegistry.execute('run_command', {
      command: 'sudo',
      args: ['npm', 'test', '--', 'changed'],
    }, executionContext);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(sessionGrants).toHaveLength(2);
  });

  it('never executes deterministic or reviewer denials', async () => {
    const classify = vi.fn(async () => ({
      action: 'deny' as const,
      risk: 'high' as const,
      reasons: ['固定规则拒绝'],
      normalizedScope: [],
      fingerprint: 'denied',
    }));
    const deterministic = await registry({classify}).execute(
      'run_command',
      {command: 'npm', args: ['test']},
      executionContext,
    );

    review = vi.fn(async () => denied);
    const reviewed = await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', 'vitest']},
      executionContext,
    );

    expect(deterministic).toMatchObject({
      ok: false,
      error: {code: 'OPERATION_DENIED'},
    });
    expect(reviewed).toMatchObject({
      ok: false,
      error: {code: 'REVIEW_DENIED'},
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not execute when the user denies confirmation', async () => {
    confirm = vi.fn(async (): Promise<ConfirmationResult> => 'deny');

    const result = await registry().execute(
      'run_command',
      {command: 'sudo', args: ['npm', 'test']},
      executionContext,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'USER_DENIED'},
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('fails closed when confirmation returns an unknown decision', async () => {
    confirm = vi.fn(async () => 'allow_forever' as ConfirmationResult);

    const result = await registry().execute(
      'run_command',
      {command: 'sudo', args: ['npm', 'test']},
      executionContext,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'CONFIRMATION_FAILED'},
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(sessionGrants).toHaveLength(0);
  });

  it('reclassifies immediately before execution and blocks changed fingerprints', async () => {
    confirm = vi.fn(async (request): Promise<ConfirmationResult> => {
      const input = request.operation.input as {args?: string[]};
      input.args?.push('--changed-after-confirmation');
      return 'allow_once';
    });

    const result = await registry().execute(
      'run_command',
      {command: 'sudo', args: ['npm', 'test']},
      executionContext,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'SCOPE_CHANGED'},
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('writes redacted classification, review and result details to audit', async () => {
    const secret = 'ghp_1234567890abcdef1234567890abcdef';
    executeTool.mockResolvedValue({
      ok: true,
      summary: `执行完成 ${secret}`,
      data: {authorization: `Bearer ${secret}`},
    });

    const result = await registry().execute(
      'run_command',
      {
        command: 'npm',
        args: ['install', '--ignore-scripts', `token=${secret}`],
      },
      executionContext,
    );
    const auditText = await readFile(
      audit.pathFor(workspaceId(workspace)),
      'utf8',
    );
    const entry = JSON.parse(auditText) as Record<string, unknown>;

    expect(result).toMatchObject({ok: true});
    expect(entry).toMatchObject({
      tool: 'run_command',
      classification: {action: 'review'},
      review: {verdict: 'approve'},
      result: {ok: true},
    });
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain('ghp_');
  });
});
