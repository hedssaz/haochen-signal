import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  buildContext,
  compactHistory,
  estimateTokens,
} from '../../src/agent/context.js';
import type {StructuredSummary} from '../../src/agent/types.js';
import {SessionStore} from '../../src/sessions/store.js';
import type {SessionEvent} from '../../src/sessions/types.js';

const validSummary: StructuredSummary = {
  goal: '修复登录',
  changes: ['补充登录校验'],
  remaining: ['运行回归测试'],
  keyFiles: ['src/login.ts'],
  decisions: ['保留兼容接口'],
  errors: ['暂无'],
  verification: ['单元测试待执行'],
};

const recentEvents: SessionEvent[] = [
  {type: 'user', at: 2, text: 'recent-1'},
  {type: 'assistant', at: 3, text: 'recent-2'},
  {type: 'tool', at: 4, tool: 'read_file', input: {path: 'src/login.ts'}, result: {ok: true}},
  {type: 'user', at: 5, text: 'recent-4'},
  {type: 'assistant', at: 6, text: 'recent-5'},
  {type: 'interrupted', at: 7, reason: 'recent-6'},
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, {recursive: true, force: true})));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'haochen-context-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('context selection', () => {
  it('estimates tokens deterministically from UTF-8 bytes', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('你好')).toBe(2);
  });

  it('keeps the current task and recent tool results before old conversation', async () => {
    const messages = await buildContext({
      systemPrompt: 'system',
      currentTask: '修复登录',
      unfinishedPlan: ['先执行登录回归测试'],
      events: [
        {type: 'user', at: 1, text: 'old-conversation '.repeat(80)},
        ...recentEvents,
      ],
      relevantFiles: [{path: 'src/login.ts', content: 'export const login = 1;'}],
      summary: '先前完成了配置',
      maxTokens: 200,
    });

    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('修复登录'),
    });
    expect(JSON.stringify(messages)).toContain('先执行登录回归测试');
    expect(JSON.stringify(messages)).toContain('recent-6');
    expect(JSON.stringify(messages)).toContain('src/login.ts');
    expect(JSON.stringify(messages)).not.toContain('old-conversation');
    expect(estimateTokens(JSON.stringify(messages))).toBeLessThanOrEqual(200);
  });

  it('limits one relevant file to a quarter of the token budget while retaining its ends', async () => {
    const messages = await buildContext({
      systemPrompt: 'system',
      currentTask: '检查文件',
      events: [],
      relevantFiles: [{
        path: 'src/large.ts',
        content: `BEGIN${'x'.repeat(1_000)}END`,
      }],
      maxTokens: 200,
    });
    const fileMessage = messages.find(message =>
      message.role === 'system' && message.content.includes('src/large.ts'));

    expect(fileMessage).toBeDefined();
    expect(fileMessage?.content).toContain('BEGIN');
    expect(fileMessage?.content).toContain('END');
    expect(fileMessage?.content).toContain('…[内容已省略]…');
    expect(estimateTokens(fileMessage?.content ?? '')).toBeLessThanOrEqual(50);
    expect(estimateTokens(JSON.stringify(messages))).toBeLessThanOrEqual(200);
  });

  it('truncates an oversized current task instead of dropping the final user instruction', async () => {
    const messages = await buildContext({
      systemPrompt: 'system',
      currentTask: `TASK-BEGIN${'x'.repeat(1_000)}TASK-END`,
      events: [],
      maxTokens: 60,
    });

    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('TASK-BEGIN'),
    });
    expect(messages.at(-1)?.content).toContain('TASK-END');
    expect(messages.at(-1)?.content).toContain('…');
    expect(estimateTokens(JSON.stringify(messages))).toBeLessThanOrEqual(60);
  });

  it('uses an explicit minimal task marker when only its message envelope fits', async () => {
    const minimalTask = [{role: 'user' as const, content: '…'}];
    const messages = await buildContext({
      systemPrompt: 'system',
      currentTask: '极长任务'.repeat(100),
      events: [],
      maxTokens: estimateTokens(JSON.stringify(minimalTask)),
    });

    expect(messages).toEqual(minimalTask);
    expect(estimateTokens(JSON.stringify(messages))).toBeLessThanOrEqual(
      estimateTokens(JSON.stringify(minimalTask)),
    );
  });

  it('truncates a relevant file again when only the remaining budget can fit it', async () => {
    const messages = await buildContext({
      systemPrompt: 's'.repeat(240),
      currentTask: '检查剩余预算',
      events: [],
      relevantFiles: [{
        path: 'src/remaining.ts',
        content: `BEGIN${'x'.repeat(1_000)}END`,
      }],
      maxTokens: 150,
    });
    const fileMessage = messages.find(message =>
      message.role === 'system' && message.content.includes('src/remaining.ts'));

    expect(fileMessage).toBeDefined();
    expect(fileMessage?.content).toContain('BEGIN');
    expect(fileMessage?.content).toContain('END');
    expect(fileMessage?.content).toContain('…[内容已省略]…');
    expect(estimateTokens(JSON.stringify(messages))).toBeLessThanOrEqual(150);
  });
});

describe('signal compaction', () => {
  it('replaces older events with a validated summary while preserving the newest six unchanged', async () => {
    const events: SessionEvent[] = [
      {type: 'user', at: 1, text: '请修复登录'},
      ...recentEvents,
    ];
    const summarize = vi.fn(async (input: string) => validSummary);

    const result = await compactHistory(events, summarize);

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]?.[0]).toContain('目标');
    expect(summarize.mock.calls[0]?.[0]).toContain('修改');
    expect(summarize.mock.calls[0]?.[0]).toContain('未完成步骤');
    expect(summarize.mock.calls[0]?.[0]).toContain('关键文件');
    expect(summarize.mock.calls[0]?.[0]).toContain('决策');
    expect(summarize.mock.calls[0]?.[0]).toContain('错误');
    expect(summarize.mock.calls[0]?.[0]).toContain('验证结果');
    expect(result).toMatchObject({compacted: true, summary: validSummary});
    expect(result.events.slice(-6)).toEqual(recentEvents);
    expect(result.events[0]).toMatchObject({
      type: 'summary',
      text: JSON.stringify(validSummary),
      coveredEventCount: 1,
    });
  });

  it('does not discard history when the summary does not satisfy the Zod schema', async () => {
    const events: SessionEvent[] = [
      {type: 'user', at: 1, text: '请修复登录'},
      ...recentEvents,
    ];

    const result = await compactHistory(events, async () => ({goal: '不完整'}));

    expect(result).toMatchObject({compacted: false, reason: expect.any(String)});
    expect(result.events).toEqual(events);
  });

  it('validates a JSON model response after parsing it', async () => {
    const events: SessionEvent[] = [
      {type: 'user', at: 1, text: '请修复登录'},
      ...recentEvents,
    ];

    const result = await compactHistory(events, async () => JSON.stringify(validSummary));

    expect(result).toMatchObject({compacted: true, summary: validSummary});
  });

  it('can append a successful summary without rewriting the original JSONL history', async () => {
    const events: SessionEvent[] = [
      {type: 'user', at: 1, text: '请修复登录'},
      ...recentEvents,
    ];
    const result = await compactHistory(events, async () => validSummary);
    if (!result.compacted) throw new Error('expected compaction to succeed');
    const store = new SessionStore(await temporaryDirectory());

    for (const event of events) await store.append('session-1', event);
    await store.append('session-1', result.summaryEvent);

    expect(await store.read('session-1')).toEqual([...events, result.summaryEvent]);
  });

  it('projects an appended summary into context without reloading its covered events', async () => {
    const events: SessionEvent[] = [
      {type: 'user', at: 1, text: 'obsolete-history'},
      ...recentEvents,
    ];
    const result = await compactHistory(events, async () => validSummary);
    if (!result.compacted) throw new Error('expected compaction to succeed');

    const messages = await buildContext({
      systemPrompt: 'system',
      currentTask: '继续登录修复',
      events: [...events, result.summaryEvent],
      maxTokens: 500,
    });

    expect(result.summaryEvent).toMatchObject({coveredEventCount: 1});
    expect(messages).toContainEqual({
      role: 'system',
      content: `历史摘要：${JSON.stringify(validSummary)}`,
    });
    for (const event of recentEvents) {
      expect(JSON.stringify(messages)).toContain(
        event.type === 'interrupted' ? event.reason : event.type === 'checkpoint'
          ? event.reason : event.type === 'tool'
          ? event.tool
          : event.type === 'session_meta'
            ? event.workspaceId
          : event.text,
      );
    }
    expect(JSON.stringify(messages)).not.toContain('obsolete-history');
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('继续登录修复'),
    });
  });

  it('recompacts projected history without retaining superseded summaries or displacing real recent events', async () => {
    const initialEvents: SessionEvent[] = [
      {type: 'user', at: 1, text: 'event-0'},
      ...recentEvents,
    ];
    const first = await compactHistory(initialEvents, async () => validSummary);
    if (!first.compacted) throw new Error('expected first compaction to succeed');

    const event7: SessionEvent = {type: 'user', at: 8, text: 'event-7'};
    const second = await compactHistory(
      [...initialEvents, first.summaryEvent, event7],
      async () => validSummary,
    );
    if (!second.compacted) throw new Error('expected second compaction to succeed');

    expect(second.summaryEvent.coveredEventCount).toBe(2);
    expect(second.events.slice(1)).toEqual([...recentEvents.slice(1), event7]);

    const event8: SessionEvent = {type: 'assistant', at: 9, text: 'event-8'};
    const third = await compactHistory(
      [...initialEvents, first.summaryEvent, event7, second.summaryEvent, event8],
      async () => validSummary,
    );
    if (!third.compacted) throw new Error('expected third compaction to succeed');

    const messages = await buildContext({
      systemPrompt: 'system',
      currentTask: '继续登录修复',
      events: [
        ...initialEvents,
        first.summaryEvent,
        event7,
        second.summaryEvent,
        event8,
        third.summaryEvent,
      ],
      maxTokens: 800,
    });

    expect(third.summaryEvent.coveredEventCount).toBe(3);
    expect(third.events.slice(1)).toEqual([...recentEvents.slice(2), event7, event8]);
    expect(messages.filter(message => message.content === `历史摘要：${JSON.stringify(validSummary)}`))
      .toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('event-0');
    expect(JSON.stringify(messages)).not.toContain('recent-1');
    for (const event of [...recentEvents.slice(2), event7, event8]) {
      expect(JSON.stringify(messages)).toContain(
        event.type === 'interrupted' ? event.reason : event.type === 'checkpoint'
          ? event.reason : event.type === 'tool'
          ? event.tool
          : event.type === 'session_meta'
            ? event.workspaceId
          : event.text,
      );
    }
  });
});
