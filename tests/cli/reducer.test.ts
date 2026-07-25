import {describe, expect, it} from 'vitest';
import {initialUiState, uiReducer} from '../../src/cli/reducer.js';

describe('uiReducer', () => {
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
    expect(state.transcript.at(-1)).toMatchObject({prefix: '◆', text: '读取碎片'});
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
      prefix: '✗',
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
    expect(state.transcript.at(-1)).toMatchObject({prefix: '✓', text: '任务完成\nREADME 描述了浩宸信号'});
  });

  it('records an interruption as a failure and returns idle', () => {
    const state = uiReducer({...initialUiState, phase: 'thinking'}, {
      type: 'interrupted',
      reason: '用户中止',
    });

    expect(state).toMatchObject({phase: 'idle'});
    expect(state.transcript.at(-1)).toMatchObject({prefix: '✗', text: '已中止：用户中止'});
  });
});
