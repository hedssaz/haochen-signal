import type {ModelMessage} from '../providers/types.js';
import type {SessionEvent} from '../sessions/types.js';
import {
  StructuredSummarySchema,
} from './types.js';
import type {
  CompactionResult,
  ContextInput,
  HistorySummarizer,
} from './types.js';

const RECENT_EVENT_COUNT = 6;
const FILE_BUDGET_FRACTION = 0.25;
const FILE_TRUNCATION_MARKER = '\n…[内容已省略]…\n';

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function serializeValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[无法序列化的值]';
  }
}

function messageForEvent(event: SessionEvent): ModelMessage {
  switch (event.type) {
    case 'user':
      return {role: 'user', content: event.text};
    case 'assistant':
      return {role: 'assistant', content: event.text};
    case 'checkpoint':
      return {role: 'system', content: `会话检查点：${event.reason}`};
    case 'tool':
      return {
        role: 'user',
        content: `工具结果（${event.tool}）：${serializeValue({input: event.input, result: event.result})}`,
      };
    case 'summary':
      return {role: 'system', content: `历史摘要：${event.text}`};
    case 'interrupted':
      return {role: 'system', content: `会话中断：${event.reason}`};
  }
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let prefix = '';

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    prefix += character;
    bytes += characterBytes;
  }

  return prefix;
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let suffix = '';

  for (const character of Array.from(text).reverse()) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    suffix = character + suffix;
    bytes += characterBytes;
  }

  return suffix;
}

function truncateWithEnds(text: string, maxTokens: number, marker = FILE_TRUNCATION_MARKER): string {
  const maxBytes = Math.max(0, Math.floor(maxTokens) * 3);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes) return utf8Prefix(marker, maxBytes);

  const retainedBytes = maxBytes - markerBytes;
  const prefixBytes = Math.ceil(retainedBytes / 2);
  const suffixBytes = Math.floor(retainedBytes / 2);
  return `${utf8Prefix(text, prefixBytes)}${marker}${utf8Suffix(text, suffixBytes)}`;
}

function planText(plan: ContextInput['unfinishedPlan']): string | undefined {
  if (plan === undefined) return undefined;
  if (typeof plan === 'string') return plan;
  return plan.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

function fitsBudget(messages: readonly ModelMessage[], maxTokens: number): boolean {
  return estimateTokens(JSON.stringify(messages)) <= maxTokens;
}

function addIfFits(
  messages: ModelMessage[],
  message: ModelMessage,
  reservedCurrentTask: ModelMessage | undefined,
  maxTokens: number,
): boolean {
  const candidate = reservedCurrentTask === undefined
    ? [...messages, message]
    : [...messages, message, reservedCurrentTask];
  if (!fitsBudget(candidate, maxTokens)) return false;
  messages.push(message);
  return true;
}

function addTruncatedSystemPrompt(
  messages: ModelMessage[],
  systemPrompt: string,
  reservedCurrentTask: ModelMessage | undefined,
  maxTokens: number,
): void {
  const fullMessage: ModelMessage = {role: 'system', content: systemPrompt};
  if (addIfFits(messages, fullMessage, reservedCurrentTask, maxTokens)) return;

  let low = 0;
  let high = estimateTokens(systemPrompt);
  let best: ModelMessage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: ModelMessage = {
      role: 'system',
      content: truncateWithEnds(systemPrompt, middle, '…'),
    };
    const combined = reservedCurrentTask === undefined
      ? [...messages, candidate]
      : [...messages, candidate, reservedCurrentTask];
    if (fitsBudget(combined, maxTokens)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) messages.push(best);
}

function createReservedCurrentTask(currentTask: string, maxTokens: number): ModelMessage | undefined {
  const fullMessage: ModelMessage = {role: 'user', content: `当前任务：${currentTask}`};
  if (fitsBudget([fullMessage], maxTokens)) return fullMessage;

  let low = 0;
  let high = estimateTokens(currentTask);
  let best: ModelMessage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: ModelMessage = {
      role: 'user',
      content: `当前任务：${truncateWithEnds(currentTask, middle, '…')}`,
    };
    if (fitsBudget([candidate], maxTokens)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) return best;

  const minimalTask: ModelMessage = {role: 'user', content: '…'};
  return fitsBudget([minimalTask], maxTokens) ? minimalTask : undefined;
}

function addTruncatedRelevantFile(
  messages: ModelMessage[],
  file: NonNullable<ContextInput['relevantFiles']>[number],
  reservedCurrentTask: ModelMessage | undefined,
  maxTokens: number,
): void {
  const fileBudget = Math.floor(maxTokens * FILE_BUDGET_FRACTION);
  const header = `文件：${file.path}\n`;
  const canAdd = (contentTokens: number): ModelMessage | undefined => {
    const candidate: ModelMessage = {
      role: 'system',
      content: `${header}${truncateWithEnds(file.content, contentTokens)}`,
    };
    if (estimateTokens(candidate.content) > fileBudget) return undefined;
    const combined = reservedCurrentTask === undefined
      ? [...messages, candidate]
      : [...messages, candidate, reservedCurrentTask];
    return fitsBudget(combined, maxTokens) ? candidate : undefined;
  };

  let low = 0;
  let high = estimateTokens(file.content);
  let best: ModelMessage | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = canAdd(middle);
    if (candidate !== undefined) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) messages.push(best);
}

/**
 * JSONL remains append-only. A summary marks the prefix it covers, so this
 * read-time projection can replace that prefix without rewriting history.
 */
interface ProjectedHistory {
  events: SessionEvent[];
  sourceIndexes: number[];
}

function projectCompactedEvents(events: readonly SessionEvent[]): ProjectedHistory {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'summary' || event.coveredEventCount === undefined) continue;
    if (event.coveredEventCount > index) continue;

    const projectedEvents: SessionEvent[] = [event];
    const sourceIndexes = [index];
    for (let sourceIndex = event.coveredEventCount; sourceIndex < events.length; sourceIndex += 1) {
      if (sourceIndex === index) continue;
      const candidate = events[sourceIndex];
      if (candidate?.type === 'summary' && candidate.coveredEventCount !== undefined) continue;
      if (candidate === undefined) continue;
      projectedEvents.push(candidate);
      sourceIndexes.push(sourceIndex);
    }
    return {events: projectedEvents, sourceIndexes};
  }
  return {events: [...events], sourceIndexes: events.map((_, index) => index)};
}

/**
 * Selects context deterministically. The current task is reserved first, then
 * emitted last so it remains the most recent instruction to the model.
 */
export async function buildContext(input: ContextInput): Promise<ModelMessage[]> {
  const maxTokens = Math.max(0, Math.floor(input.maxTokens));
  const reserveCurrentTask = createReservedCurrentTask(input.currentTask, maxTokens);
  const messages: ModelMessage[] = [];

  addTruncatedSystemPrompt(messages, input.systemPrompt, reserveCurrentTask, maxTokens);

  const unfinishedPlan = planText(input.unfinishedPlan ?? input.plan);
  if (unfinishedPlan !== undefined) {
    addIfFits(messages, {
      role: 'system',
      content: `未完成计划：\n${unfinishedPlan}`,
    }, reserveCurrentTask, maxTokens);
  }

  const projectedEvents = projectCompactedEvents(input.events).events;
  const recentEvents = projectedEvents.slice(-RECENT_EVENT_COUNT);
  for (const event of recentEvents) {
    addIfFits(messages, messageForEvent(event), reserveCurrentTask, maxTokens);
  }

  for (const file of input.relevantFiles ?? []) {
    addTruncatedRelevantFile(messages, file, reserveCurrentTask, maxTokens);
  }

  if (input.summary !== undefined) {
    addIfFits(messages, {
      role: 'system',
      content: `历史摘要：${input.summary}`,
    }, reserveCurrentTask, maxTokens);
  }

  for (const event of projectedEvents.slice(0, -RECENT_EVENT_COUNT)) {
    addIfFits(messages, messageForEvent(event), reserveCurrentTask, maxTokens);
  }

  if (reserveCurrentTask !== undefined) messages.push(reserveCurrentTask);
  return messages;
}

function compactionPrompt(events: readonly SessionEvent[]): string {
  return [
    '请将以下历史会话压缩为严格 JSON 对象，不要使用 Markdown。',
    '对象必须含有：目标、修改、未完成步骤、关键文件、决策、错误、验证结果。',
    '字段名固定为 goal、changes、remaining、keyFiles、decisions、errors、verification；',
    'goal 是字符串，其余字段均为字符串数组。',
    '历史会话：',
    ...events.map(event => JSON.stringify(event)),
  ].join('\n');
}

function failure(events: readonly SessionEvent[], reason: string): CompactionResult {
  return {compacted: false, events: [...events], reason};
}

function parseSummaryResponse(response: unknown): unknown {
  if (typeof response !== 'string') return response;
  try {
    return JSON.parse(response);
  } catch {
    return response;
  }
}

export async function compactHistory(
  events: readonly SessionEvent[],
  summarize: HistorySummarizer,
): Promise<CompactionResult> {
  const projectedHistory = projectCompactedEvents(events);
  if (projectedHistory.events.length <= RECENT_EVENT_COUNT) {
    return failure(events, `至少需要 ${RECENT_EVENT_COUNT + 1} 条事件才能压缩历史`);
  }

  const olderEvents = projectedHistory.events.slice(0, -RECENT_EVENT_COUNT);
  const recentEvents = projectedHistory.events.slice(-RECENT_EVENT_COUNT);
  const coveredEventCount = projectedHistory.sourceIndexes.at(-RECENT_EVENT_COUNT);
  if (coveredEventCount === undefined) {
    return failure(events, '无法确定历史摘要的覆盖范围');
  }
  let response: unknown;
  try {
    response = await summarize(compactionPrompt(olderEvents));
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return failure(events, `历史摘要生成失败：${message}`);
  }

  const parsed = StructuredSummarySchema.safeParse(parseSummaryResponse(response));
  if (!parsed.success) {
    return failure(events, `历史摘要格式无效：${parsed.error.issues[0]?.message ?? '未知校验错误'}`);
  }

  const summaryEvent: Extract<SessionEvent, {type: 'summary'}> = {
    type: 'summary',
    at: Date.now(),
    text: JSON.stringify(parsed.data),
    coveredEventCount,
  };
  return {
    compacted: true,
    events: [summaryEvent, ...recentEvents],
    summary: parsed.data,
    summaryEvent,
  };
}
