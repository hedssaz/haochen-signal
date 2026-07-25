import {describe, expect, it} from 'vitest';
import {initialUiState, uiReducer} from '../../src/cli/reducer.js';

describe('uiReducer', () => {
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
  ])('finalizes reasoning and assistant text independently on $type', (event) => {
    const withReasoning = uiReducer(initialUiState, {
      type: 'reasoning_delta',
      text: '检查协议',
    });
    const streaming = uiReducer(withReasoning, {
      type: 'assistant_delta',
      text: '开始回答',
    });

    expect(streaming).toMatchObject({
      liveReasoning: '检查协议',
      liveAssistant: '开始回答',
    });
    expect(streaming.transcript).toEqual([]);

    const complete = uiReducer(streaming, event);

    expect(complete).toMatchObject({liveReasoning: '', liveAssistant: ''});
    expect(complete.transcript).toEqual([
      {kind: 'reasoning', title: '思考', text: '检查协议'},
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
