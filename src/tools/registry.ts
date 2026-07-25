import type {
  ModelClient,
  ToolDefinition,
} from '../providers/types.js';
import {classifyOperation} from '../security/boundary.js';
import {redactValue} from '../security/redact.js';
import {
  ReviewDecisionSchema,
  reviewOperation,
  type ConfirmationRequest,
  type ConfirmationResult,
  type ReviewDecision,
} from '../security/reviewer.js';
import type {BoundaryDecision} from '../security/types.js';
import {AuditStore, workspaceId} from '../sessions/audit.js';
import type {AuditEntry} from '../sessions/types.js';
import type {
  ToolContext,
  ToolDefinitionSpec,
  ToolResult,
} from './types.js';

const FAILING_REVIEW_CLIENT: ModelClient = {
  async *stream() {
    throw new Error('未配置红眼审查模型客户端');
  },
};

export interface ToolExecutionContext extends ToolContext {
  taskSummary: string;
  reviewClient?: ModelClient;
  reviewModel: string;
  signal: AbortSignal;
}

export type ExecutionContext = ToolExecutionContext;

export interface ToolRegistryOptions {
  tools: Map<string, ToolDefinitionSpec<unknown, unknown>>;
  classify: typeof classifyOperation;
  review: typeof reviewOperation;
  confirm: (request: ConfirmationRequest) => Promise<ConfirmationResult>;
  sessionGrants: Set<string>;
  audit: AuditStore;
}

interface AuditDetails {
  input: unknown;
  decision: string;
  classification?: BoundaryDecision;
  finalClassification?: BoundaryDecision;
  review?: ReviewDecision;
  confirmation?: ConfirmationResult;
  sessionGrant?: boolean;
  result: ToolResult;
}

function failure(code: string, message: string): ToolResult {
  return {
    ok: false,
    summary: message,
    error: {code, message},
  };
}

function fallbackReview(boundary: BoundaryDecision): ReviewDecision {
  return {
    verdict: 'ask_user',
    risk: 'high',
    summary: '红眼审查无法可靠完成，需要用户确认',
    reasons: ['审查请求失败或返回结果无效'],
    affected_scope: [...boundary.normalizedScope],
    constraints: [],
  };
}

const RISK_RANK = {
  low: 0,
  medium: 1,
  high: 2,
} as const;

function enforceReviewBoundary(
  review: ReviewDecision,
  boundary: BoundaryDecision,
): ReviewDecision {
  if (review.verdict !== 'approve') return review;

  const conflicts: string[] = [];
  if (RISK_RANK[review.risk] > RISK_RANK[boundary.risk]) {
    conflicts.push('审查风险高于确定性边界风险');
  }

  const boundaryScope = new Set(boundary.normalizedScope);
  if (review.affected_scope.some(scope => !boundaryScope.has(scope))) {
    conflicts.push('审查影响范围超出确定性边界范围');
  }

  if (review.constraints.length > 0) {
    conflicts.push('当前执行门无法自动验证审查约束');
  }

  if (conflicts.length === 0) return review;
  return {
    ...review,
    verdict: 'ask_user',
    risk: 'high',
    reasons: [...review.reasons, ...conflicts],
  };
}

export class ToolRegistry {
  constructor(private readonly options: ToolRegistryOptions) {}

  modelToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const [registeredName, definition] of this.options.tools) {
      if (registeredName !== definition.name) continue;
      definitions.push({
        type: 'function',
        function: {
          name: definition.name,
          description: definition.description,
          parameters: definition.jsonSchema,
        },
      });
    }
    return definitions;
  }

  private async auditResult(
    name: string,
    context: ToolExecutionContext,
    details: AuditDetails,
    executionOccurred = false,
  ): Promise<ToolResult> {
    const rawEntry: AuditEntry = {
      at: Date.now(),
      tool: name,
      input: details.input,
      decision: details.decision,
      ...(details.classification === undefined
        ? {}
        : {classification: details.classification}),
      ...(details.finalClassification === undefined
        ? {}
        : {finalClassification: details.finalClassification}),
      ...(details.review === undefined ? {} : {review: details.review}),
      ...(details.confirmation === undefined
        ? {}
        : {confirmation: details.confirmation}),
      ...(details.sessionGrant === undefined
        ? {}
        : {sessionGrant: details.sessionGrant}),
      result: details.result,
    };

    try {
      const redacted = redactValue(rawEntry) as AuditEntry;
      await this.options.audit.append(workspaceId(context.workspace), redacted);
      return details.result;
    } catch {
      if (executionOccurred) {
        return {
          ...details.result,
          warnings: [
            ...(details.result.warnings ?? []),
            {
              code: 'AUDIT_FAILED',
              message: '工具已执行，但无法写入脱敏审计记录',
            },
          ],
        };
      }
      return failure('AUDIT_FAILED', '无法写入脱敏审计记录');
    }
  }

  async execute(
    name: string,
    input: unknown,
    executionContext: ToolExecutionContext,
  ): Promise<ToolResult> {
    const definition = this.options.tools.get(name);
    if (definition === undefined || definition.name !== name) {
      return this.auditResult(name, executionContext, {
        input,
        decision: 'unknown_tool',
        result: failure('UNKNOWN_TOOL', '工具不存在或注册信息无效'),
      });
    }

    let validatedInput: unknown;
    try {
      const parsed = await definition.inputSchema.safeParseAsync(input);
      if (!parsed.success) {
        return this.auditResult(name, executionContext, {
          input,
          decision: 'invalid_input',
          result: failure('INVALID_INPUT', '工具输入不符合固定结构'),
        });
      }
      validatedInput = parsed.data;
    } catch {
      return this.auditResult(name, executionContext, {
        input,
        decision: 'invalid_input',
        result: failure('INVALID_INPUT', '工具输入无法安全校验'),
      });
    }

    let classification: BoundaryDecision;
    try {
      classification = await this.options.classify(
        {tool: name, input: validatedInput},
        {workspace: executionContext.workspace},
      );
    } catch {
      return this.auditResult(name, executionContext, {
        input: validatedInput,
        decision: 'classification_failed',
        result: failure(
          'CLASSIFICATION_FAILED',
          '确定性边界分类失败，操作未执行',
        ),
      });
    }

    if (classification.action === 'deny') {
      return this.auditResult(name, executionContext, {
        input: validatedInput,
        decision: 'deny',
        classification,
        result: failure('OPERATION_DENIED', '确定性边界拒绝此操作'),
      });
    }

    const approvedFingerprint = classification.fingerprint;
    const approvedAction = classification.action;
    const hasSessionGrant = this.options.sessionGrants.has(approvedFingerprint);
    let review: ReviewDecision | undefined;
    let confirmation: ConfirmationResult | undefined;
    let addSessionGrant = false;

    if (!hasSessionGrant && classification.action === 'review') {
      try {
        const rawReview = await this.options.review(
          executionContext.reviewClient ?? FAILING_REVIEW_CLIENT,
          {
            model: executionContext.reviewModel,
            taskSummary: executionContext.taskSummary,
            tool: name,
            input: validatedInput,
            boundary: classification,
          },
          executionContext.signal,
        );
        const parsedReview = ReviewDecisionSchema.safeParse(rawReview);
        review = parsedReview.success
          ? enforceReviewBoundary(parsedReview.data, classification)
          : fallbackReview(classification);
      } catch {
        review = fallbackReview(classification);
      }

      if (review.verdict === 'deny') {
        return this.auditResult(name, executionContext, {
          input: validatedInput,
          decision: 'review_deny',
          classification,
          review,
          result: failure('REVIEW_DENIED', '红眼审查拒绝此操作'),
        });
      }
    }

    const requiresConfirmation = !hasSessionGrant
      && (classification.action === 'confirm'
        || review?.verdict === 'ask_user');
    if (requiresConfirmation) {
      try {
        confirmation = await this.options.confirm({
          operation: {tool: name, input: validatedInput},
          boundary: classification,
          ...(review === undefined ? {} : {review}),
        });
      } catch {
        return this.auditResult(name, executionContext, {
          input: validatedInput,
          decision: 'confirmation_failed',
          classification,
          review,
          result: failure(
            'CONFIRMATION_FAILED',
            '用户确认流程失败，操作未执行',
          ),
        });
      }

      if (!['allow_once', 'allow_session', 'deny'].includes(confirmation)) {
        return this.auditResult(name, executionContext, {
          input: validatedInput,
          decision: 'confirmation_failed',
          classification,
          review,
          result: failure(
            'CONFIRMATION_FAILED',
            '用户确认结果无效，操作未执行',
          ),
        });
      }
      if (confirmation === 'deny') {
        return this.auditResult(name, executionContext, {
          input: validatedInput,
          decision: 'user_deny',
          classification,
          review,
          confirmation,
          result: failure('USER_DENIED', '用户拒绝此操作'),
        });
      }
      addSessionGrant = confirmation === 'allow_session';
    }

    let finalClassification: BoundaryDecision;
    try {
      finalClassification = await this.options.classify(
        {tool: name, input: validatedInput},
        {workspace: executionContext.workspace},
      );
    } catch {
      return this.auditResult(name, executionContext, {
        input: validatedInput,
        decision: 'reclassification_failed',
        classification,
        review,
        confirmation,
        result: failure(
          'CLASSIFICATION_FAILED',
          '执行前边界复核失败，操作未执行',
        ),
      });
    }

    if (finalClassification.action === 'deny'
      || finalClassification.fingerprint !== approvedFingerprint
      || finalClassification.action !== approvedAction) {
      return this.auditResult(name, executionContext, {
        input: validatedInput,
        decision: 'scope_changed',
        classification,
        finalClassification,
        review,
        confirmation,
        result: failure(
          'SCOPE_CHANGED',
          '执行前操作分类、参数或影响范围发生变化',
        ),
      });
    }

    if (executionContext.signal.aborted) {
      return this.auditResult(name, executionContext, {
        input: validatedInput,
        decision: 'aborted',
        classification,
        finalClassification,
        review,
        confirmation,
        result: failure('ABORTED', '工具执行已取消'),
      });
    }

    try {
      await this.options.audit.prepare(workspaceId(executionContext.workspace));
    } catch {
      return failure(
        'AUDIT_FAILED',
        '执行前无法准备脱敏审计记录，操作未执行',
      );
    }

    if (addSessionGrant) {
      this.options.sessionGrants.add(approvedFingerprint);
    }

    let result: ToolResult;
    try {
      result = await definition.execute(
        validatedInput,
        {
          workspace: executionContext.workspace,
          tempDir: executionContext.tempDir,
        },
        executionContext.signal,
      );
    } catch {
      result = failure(
        'TOOL_EXECUTION_FAILED',
        '工具实现发生未处理错误',
      );
    }

    return this.auditResult(
      name,
      executionContext,
      {
        input: validatedInput,
        decision: 'execute',
        classification,
        finalClassification,
        review,
        confirmation,
        sessionGrant: hasSessionGrant || addSessionGrant,
        result,
      },
      true,
    );
  }
}
