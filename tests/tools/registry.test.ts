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
  affected_scope: [
    'cwd:.',
    'command:npm install --ignore-scripts vitest',
  ],
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
      reviewModel: 'wolf-review-1',
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

  it('requires confirmation when reviewer risk exceeds boundary risk', async () => {
    review = vi.fn(async (): Promise<ReviewDecision> => ({
      ...approved,
      risk: 'high',
    }));

    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', '--ignore-scripts', 'vitest']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({
        verdict: 'ask_user',
        risk: 'high',
      }),
    }));
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('requires confirmation when reviewer expands the classified scope', async () => {
    review = vi.fn(async () => ({
      ...approved,
      affected_scope: [...approved.affected_scope, 'path:../outside'],
    }));

    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', '--ignore-scripts', 'vitest']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({
        verdict: 'ask_user',
        risk: 'high',
      }),
    }));
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('requires confirmation for constraints without an executor', async () => {
    review = vi.fn(async () => ({
      ...approved,
      constraints: ['禁止运行生命周期脚本'],
    }));

    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', '--ignore-scripts', 'vitest']},
      executionContext,
    );

    expect(result).toMatchObject({ok: true});
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({
        verdict: 'ask_user',
        risk: 'high',
      }),
    }));
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('passes the explicitly configured model to red-eye review', async () => {
    await registry().execute(
      'run_command',
      {command: 'npm', args: ['install', '--ignore-scripts', 'vitest']},
      executionContext,
    );

    expect(review).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({model: 'wolf-review-1'}),
      executionContext.signal,
    );
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

  it('does not reuse an allow_session grant across workspaces', async () => {
    confirm = vi.fn(async (): Promise<ConfirmationResult> => 'allow_session');
    const otherWorkspace = join(root, 'other-workspace');
    await mkdir(otherWorkspace);
    const toolRegistry = registry();
    const operation = {command: 'sudo', args: ['npm', 'test']};

    await toolRegistry.execute('run_command', operation, executionContext);
    await toolRegistry.execute('run_command', operation, {
      ...executionContext,
      workspace: otherWorkspace,
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(2);
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
    review = vi.fn(async (_client, request) => ({
      ...approved,
      affected_scope: [...request.boundary.normalizedScope],
    }));
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

  it('redacts plain CLI credential options from audit records', async () => {
    const secrets = [
      'plain-token-value',
      'plain-api-value',
      'plain-password-value',
      'plain-line-secret',
      'plain-quoted-secret',
    ];
    executeTool.mockResolvedValue({
      ok: true,
      summary: '工具已执行',
      data: {
        output: 'login --token\nplain-line-secret '
          + '--api-key=plain"plain-quoted-secret"',
      },
    });

    await registry().execute(
      'run_command',
      {
        command: 'login',
        args: [
          'account',
          '--token',
          secrets[0],
          `--api-key=${secrets[1]}`,
          '--password',
          secrets[2],
        ],
      },
      executionContext,
    );
    const auditText = await readFile(
      audit.pathFor(workspaceId(workspace)),
      'utf8',
    );

    for (const secret of secrets) {
      expect(auditText).not.toContain(secret);
    }
    expect(auditText).toContain('[REDACTED]');
  });

  it('preserves the real tool result when post-execution audit fails', async () => {
    class FailingAuditStore extends AuditStore {
      override async append(): Promise<void> {
        throw new Error('audit failed with secret-audit-detail');
      }
    }
    audit = new FailingAuditStore(join(root, 'unwritable-audit'));
    executeTool.mockResolvedValue({
      ok: true,
      summary: '工具实际执行成功',
      data: {changed: true},
    });

    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['test']},
      executionContext,
    );

    expect(executeTool).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      summary: '工具实际执行成功',
      data: {changed: true},
      warnings: [{
        code: 'AUDIT_FAILED',
        message: expect.stringContaining('工具已执行'),
      }],
    });
    expect(JSON.stringify(result)).not.toContain('secret-audit-detail');
  });

  it('blocks execution when a pre-execution audit write fails', async () => {
    class FailingAuditStore extends AuditStore {
      override async prepare(): Promise<void> {
        throw new Error('audit unavailable');
      }
    }
    audit = new FailingAuditStore(join(root, 'unwritable-audit'));

    const result = await registry().execute(
      'run_command',
      {command: 'npm', args: ['test']},
      executionContext,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {code: 'AUDIT_FAILED'},
    });
    expect(executeTool).not.toHaveBeenCalled();
  });
});
