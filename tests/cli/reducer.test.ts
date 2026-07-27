import {describe, expect, it} from 'vitest';
import {initialUiState, uiReducer} from '../../src/cli/reducer.js';

describe('uiReducer', () => {
  it('collapses only the current task process when any non-empty answer starts', () => {
    const previous = {
      ...initialUiState,
      transcript: [
        {kind: 'assistant', title: '浩宸', text: '之前的回答'} as const,
      ],
    };
    const started = uiReducer(previous, {type: 'task_started'});
    const reasoning = uiReducer(started, {
      type: 'reasoning_delta',
      text: '本轮思考',
    });
    const tool = uiReducer(reasoning, {
      type: 'tool_started',
      name: 'read_file',
      input: {path: 'README.md'},
    });
    const result = uiReducer(tool, {
      type: 'tool_finished',
      name: 'read_file',
      result: {ok: true, summary: '已读取 README.md'},
    });
    const answering = uiReducer(result, {
      type: 'assistant_delta',
      text: '现在回答',
    });

    expect(answering.transcript).toEqual([
      {kind: 'assistant', title: '浩宸', text: '之前的回答'},
    ]);
    expect(answering.liveReasoning).toBe('');
    expect(answering.liveAssistant).toBe('现在回答');
  });

  it('does not collapse the current task process for an empty answer delta', () => {
    const started = uiReducer(initialUiState, {type: 'task_started'});
    const reasoning = uiReducer(started, {
      type: 'reasoning_delta',
      text: '继续思考',
    });
    const unchanged = uiReducer(reasoning, {
      type: 'assistant_delta',
      text: '',
    });

    expect(unchanged.liveReasoning).toBe('继续思考');
  });

  it.each([
    {
      label: 'success',
      result: {ok: true, summary: '已读取 README.md'} as const,
      toolStatus: 'success',
    },
    {
      label: 'failure',
      result: {
        ok: false,
        summary: '读取失败',
        error: {code: 'READ_FAILED', message: '没有权限'},
      } as const,
      toolStatus: 'failure',
    },
  ])('merges a tool $label result into its single pending line', ({
    result,
    toolStatus,
  }) => {
    const started = uiReducer(initialUiState, {
      type: 'tool_started',
      name: 'read_file',
      input: {path: 'README.md'},
    });
    const finished = uiReducer(started, {
      type: 'tool_finished',
      name: 'read_file',
      result,
    });

    expect(finished.transcript).toHaveLength(1);
    expect(finished.transcript[0]).toMatchObject({
      kind: 'tool',
      title: 'read_file',
      compact: true,
      toolStatus,
    });
  });

  it('keeps transient status out of the transcript', () => {
    const state = uiReducer(initialUiState, {
      type: 'status',
      text: '正在理解任务',
    });

    expect(state).toMatchObject({phase: 'thinking'});
    expect(state.transcript).toEqual([]);
  });

  it.each([
    {type: 'assistant_message', text: '开始回答'} as const,
    {type: 'assistant_text', text: '开始回答'} as const,
  ])('keeps only assistant text after answering starts on $type', (event) => {
    const withReasoning = uiReducer(initialUiState, {
      type: 'reasoning_delta',
      text: '检查协议',
    });
    const streaming = uiReducer(withReasoning, {
      type: 'assistant_delta',
      text: '开始回答',
    });

    expect(streaming).toMatchObject({
      liveReasoning: '',
      liveAssistant: '开始回答',
    });
    expect(streaming.transcript).toEqual([]);

    const complete = uiReducer(streaming, event);

    expect(complete).toMatchObject({liveReasoning: '', liveAssistant: ''});
    expect(complete.transcript).toEqual([
      {kind: 'assistant', title: '浩宸', text: '开始回答'},
    ]);
  });

  it('preserves each reasoning-only tool round before the next round starts', () => {
    const firstRound = uiReducer(initialUiState, {
      type: 'reasoning_delta',
      text: '第一轮推理',
    });
    const finished = uiReducer(firstRound, {type: 'assistant_turn_finished'});
    const secondRound = uiReducer(finished, {
      type: 'reasoning_delta',
      text: '第二轮推理',
    });

    expect(secondRound).toMatchObject({
      liveReasoning: '第二轮推理',
      liveAssistant: '',
    });
    expect(secondRound.transcript).toEqual([
      {kind: 'reasoning', title: '思考', text: '第一轮推理'},
    ]);
  });

  it('stores real usage once and reuses the same total across one tool batch', () => {
    const withUsage = uiReducer(initialUiState, {
      type: 'usage',
      inputTokens: 12,
      outputTokens: 3,
    });
    const finishedRound = uiReducer(withUsage, {type: 'assistant_turn_finished'});
    const firstTool = uiReducer(finishedRound, {
      type: 'tool_started',
      name: 'read_file',
      input: {path: 'README.md'},
    });
    const firstResult = uiReducer(firstTool, {
      type: 'tool_finished',
      name: 'read_file',
      result: {ok: true, summary: 'README.md'},
    });
    const secondTool = uiReducer(firstResult, {
      type: 'tool_started',
      name: 'read_file',
      input: {path: 'CHANGELOG.md'},
    });

    expect(withUsage).toMatchObject({
      usedContext: 15,
      roundUsageTotal: 15,
    });
    expect(firstTool).toMatchObject({
      previousRoundTotal: 15,
      showPreviousRoundUsage: true,
    });
    expect(secondTool).toMatchObject({
      previousRoundTotal: 15,
      showPreviousRoundUsage: true,
    });
  });

  it('marks a tool round without usage as unknown and hides it on the next model stream', () => {
    const previousKnown = {
      ...initialUiState,
      usedContext: 21,
      previousRoundTotal: 21,
      roundUsageTotal: undefined,
    };
    const finishedWithoutUsage = uiReducer(previousKnown, {
      type: 'assistant_turn_finished',
    });
    const tool = uiReducer(finishedWithoutUsage, {
      type: 'tool_started',
      name: 'read_file',
      input: {path: 'README.md'},
    });
    const nextRound = uiReducer(tool, {
      type: 'reasoning_delta',
      text: '继续',
    });

    expect(tool).toMatchObject({
      usedContext: 21,
      showPreviousRoundUsage: true,
    });
    expect(tool.previousRoundTotal).toBeUndefined();
    expect(nextRound.showPreviousRoundUsage).toBe(false);
  });

  it.each([
    {type: 'assistant_message', text: '最终回答'} as const,
    {type: 'assistant_text', text: '最终回答'} as const,
  ])('does not duplicate finalized reasoning on $type', (event) => {
    const streaming = uiReducer(initialUiState, {
      type: 'reasoning_delta',
      text: '只保留一次',
    });
    const finalized = uiReducer(streaming, {type: 'assistant_turn_finished'});
    const answered = uiReducer(finalized, event);

    expect(answered.transcript.filter(entry => entry.kind === 'reasoning')).toEqual([
      {kind: 'reasoning', title: '思考', text: '只保留一次'},
    ]);
  });

  it.each([
    {type: 'error', message: '协议错误'} as const,
    {type: 'interrupted', reason: '用户中止'} as const,
    {type: 'limit_reached', limit: 'turns'} as const,
  ])('preserves reasoning and clears live buffers on terminal $type', (event) => {
    const state = uiReducer({
      ...initialUiState,
      phase: 'thinking',
      liveReasoning: '未完成推理',
      liveAssistant: '未完成回答',
    }, event);

    expect(state).toMatchObject({liveReasoning: '', liveAssistant: ''});
    expect(state.transcript[0]).toEqual({
      kind: 'reasoning',
      title: '思考',
      text: '未完成推理',
    });
  });

  it('maps a read tool event to a stable scan entry', () => {
    const state = uiReducer(initialUiState, {
      type: 'tool_started',
      name: 'read_file',
      input: {path: 'README.md'},
    });

    expect(state).toMatchObject({
      phase: 'running_tool',
      activeTool: {name: 'read_file', summary: '读取碎片'},
    });
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'tool',
      title: 'read_file',
      text: '读取碎片',
      detail: '{"path":"README.md"}',
    });
  });

  it('maps write_file to a creation entry without exposing its content', () => {
    const state = uiReducer(initialUiState, {
      type: 'tool_started',
      name: 'write_file',
      input: {path: 'src/new.ts', content: 'private contents'},
    });

    expect(state).toMatchObject({
      phase: 'running_tool',
      activeTool: {name: 'write_file', summary: '创建文件'},
    });
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'tool',
      title: 'write_file',
      text: '创建文件',
      detail: '{"path":"src/new.ts","contentLength":16}',
    });
    expect(JSON.stringify(state)).not.toContain('private contents');
  });

  it('renders a failed command without a completion mark', () => {
    const state = uiReducer(initialUiState, {
      type: 'tool_finished',
      name: 'run_command',
      result: {
        ok: false,
        summary: '测试失败',
        data: {exitCode: 2, stderr: 'AssertionError: expected true'},
      },
    });

    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'error',
      title: 'run_command',
      text: expect.stringContaining('退出码 2'),
    });
    expect(state.transcript.at(-1)?.text).toContain('AssertionError');
  });

  it('keeps assistant text as a final success entry', () => {
    const state = uiReducer(initialUiState, {
      type: 'assistant_text',
      text: 'README 描述了浩宸信号',
    });

    expect(state).toMatchObject({phase: 'idle'});
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'assistant',
      title: '浩宸',
      text: 'README 描述了浩宸信号',
    });
  });

  it('records an interruption as a failure and returns idle', () => {
    const state = uiReducer({...initialUiState, phase: 'thinking'}, {
      type: 'interrupted',
      reason: '用户中止',
    });

    expect(state).toMatchObject({phase: 'idle'});
    expect(state.transcript.at(-1)).toMatchObject({
      kind: 'error',
      title: '已中止',
      text: '用户中止',
    });
  });
});
