import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {render} from 'ink-testing-library';
import {App, formatTokenCount} from '../../src/cli/app.js';
import type {AgentUiEvent} from '../../src/cli/reducer.js';
import type {ToolResult} from '../../src/tools/types.js';
import {GateReporter} from '../../src/cli/gate-reporter.js';

async function* scriptedEvents(): AsyncIterable<AgentUiEvent> {
  yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
  yield {
    type: 'tool_finished',
    name: 'read_file',
    result: {ok: true, summary: 'README.md'},
  };
  yield {type: 'assistant_text', text: 'README 描述了浩宸信号'};
}

const idleTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {});
const toolResult: ToolResult = {ok: true, summary: '当前差异为空'};

async function waitForInputListener(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('App', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    [999, '999'],
    [1_000, '1k'],
    [1_000_000, '1m'],
  ])('formats %i stream tokens as %s', (count, expected) => {
    expect(formatTokenCount(count)).toBe(expected);
  });

  it('renders injected agent events after submitting a task', async () => {
    const app = render(<App
      runTask={() => scriptedEvents()}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('读取 README');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('浩宸 ›');
      expect(app.lastFrame()).toContain('README 描述了浩宸信号');
    });

    expect(app.lastFrame()).toContain('工具 › read_file');
    expect(app.lastFrame()).toContain('README 描述了浩宸信号');
  });

  it('keeps submitted user text in the transcript', async () => {
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {});
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('修复登录问题');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledWith(
      '修复登录问题',
      expect.any(AbortSignal),
    ));

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('你 ›');
      expect(app.lastFrame()).toContain('修复登录问题');
    });
  });

  it('shows matching slash commands while the user types', async () => {
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('/');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('/help');
      expect(app.lastFrame()).toContain('/permissions');
      expect(app.lastFrame()).toContain('Tab 补全');
    });
  });

  it('completes the first matching slash command with Tab', async () => {
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('/he');
    app.stdin.write('\t');

    await vi.waitFor(() => expect(app.lastFrame()).toContain('浩宸 › /help'));
  });

  it.each(['/help', '/status', '/model wolf-3', '/diff', '/permissions', '/compact', '/clear', '/resume abc', '/exit'])(
    'handles %s locally without sending it to the model',
    async command => {
      const onExit = vi.fn(async () => undefined);
      const app = render(<App
        runTask={idleTask}
        workspace="/workspace"
        sessionId="signal-1"
        model="wolf-2"
        executeTool={vi.fn(async () => toolResult)}
        compact={vi.fn(async () => ({ok: true, message: '已压缩'}))}
        saveSession={vi.fn(async () => undefined)}
        createSession={vi.fn(async () => 'signal-2')}
        resumeSession={vi.fn(async () => ({id: 'abc', message: '已恢复 abc'}))}
        onExit={onExit}
      />);

      await waitForInputListener();
      app.stdin.write(command);
      app.stdin.write('\r');
      await new Promise<void>(resolve => setTimeout(resolve, 0));

      expect(idleTask).not.toHaveBeenCalled();
    },
  );

  it('reads the latest session grant count when permissions are requested', async () => {
    const sessionGrants = new Set<string>();
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      sessionGrants={sessionGrants}
    />);

    await waitForInputListener();
    sessionGrants.add('fingerprint');
    app.stdin.write('/permissions');
    app.stdin.write('\r');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('本次会话许可：1 项');
    });
  });

  it('opens a workspace resume picker and restores the selected conversation', async () => {
    const resumeSession = vi.fn(async (id: string) => ({id, message: `已恢复 ${id}`}));
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      workspaceId="workspace-a"
      sessionId="signal-1"
      model="wolf-2"
      listSessions={vi.fn(async () => [
        {id: 'current-1', updatedAt: 30, preview: '当前项目', workspaceId: 'workspace-a'},
        {id: 'legacy-1', updatedAt: 20, preview: '旧版会话'},
        {id: 'other-1', updatedAt: 40, preview: '其他项目', workspaceId: 'workspace-b'},
      ])}
      resumeSession={resumeSession}
    />);

    await waitForInputListener();
    app.stdin.write('/resume');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('恢复对话 · 当前工作区');
      expect(app.lastFrame()).toContain('当前项目');
      expect(app.lastFrame()).toContain('工作区未知');
      expect(app.lastFrame()).not.toContain('其他项目');
    });

    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledWith('legacy-1'));
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('恢复对话 · 当前工作区');
    });
  });

  it('separates user, assistant, tool, approval and result entries', async () => {
    const gateReporter = new GateReporter();
    const app = render(<App
      runTask={() => scriptedEvents()}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      gateReporter={gateReporter}
    />);

    await waitForInputListener();
    app.stdin.write('读取 README');
    app.stdin.write('\r');
    gateReporter.report({
      type: 'gate_finished',
      tool: 'read_file',
      outcome: 'execute',
      source: 'boundary_allow',
      summary: '无需 AI 审查，确定性边界直接放行',
    });

    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('你 ›');
      expect(frame).toContain('浩宸 ›');
      expect(frame).toContain('工具 › read_file');
      expect(frame).toContain('参数  {"path":"README.md"}');
      expect(frame).toContain('审批 › read_file');
      expect(frame).toContain('无需 AI 审查');
      expect(frame).toContain('结果 › read_file');
    });
  });

  it('shows a persistent running status until the task finishes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
      await blocked;
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('读取 README');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain(
        '状态 › 运行中 · 正在调用 read_file · Ctrl+C 中止',
      );
      expect(app.lastFrame()).toContain('输入已锁定 · 等待任务完成，Ctrl+C 中止');
      expect(app.lastFrame()).not.toContain('状态 › 状态');
      expect(app.lastFrame()).not.toContain('浩宸 › ');
    });

    release();
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('状态 › 运行中');
      expect((app.lastFrame() ?? '').trimEnd()).toMatch(/浩宸 ›$/);
    });
  });

  it('streams reasoning and answers with per-task incremental token phases', async () => {
    let releaseAnswer!: () => void;
    let releaseFirstTask!: () => void;
    let releaseSecondTask!: () => void;
    const answerGate = new Promise<void>(resolve => { releaseAnswer = resolve; });
    const firstTaskGate = new Promise<void>(resolve => { releaseFirstTask = resolve; });
    const secondTaskGate = new Promise<void>(resolve => { releaseSecondTask = resolve; });
    let taskCount = 0;
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      taskCount += 1;
      if (taskCount === 1) {
        yield {type: 'reasoning_delta', text: '先'};
        yield {type: 'reasoning_delta', text: '想'};
        await answerGate;
        yield {type: 'assistant_delta', text: '答'};
        yield {type: 'assistant_delta', text: '案'};
        await firstTaskGate;
        yield {type: 'assistant_turn_finished'};
        return;
      }
      await secondTaskGate;
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('解决问题');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('思考 ›');
      expect(frame).toContain('先想');
      expect(frame).toContain('↓ 2 tokens · 思考中');
    });

    releaseAnswer();
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('浩宸 ›');
      expect(frame).toContain('答案');
      expect(frame).toContain('↓ 4 tokens · 思考完成 · 正在回答');
    });

    releaseFirstTask();
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('↓ 4 tokens · 思考完成');
      expect(frame).not.toContain('正在回答');
    });

    app.stdin.write('继续');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('↓ 0 tokens · 思考中');
      expect(frame).not.toContain('↓ 4 tokens');
    });

    releaseSecondTask();
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('↓ 0 tokens · 思考完成');
    });
  });

  it('enters answering on the first non-empty content-only delta', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'reasoning_delta', text: ''};
      yield {type: 'assistant_delta', text: ''};
      yield {type: 'assistant_delta', text: '直接回答'};
      await blocked;
      yield {type: 'assistant_turn_finished'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('直接回答');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).not.toContain('思考 ›');
      expect(frame).toContain('浩宸 ›');
      expect(frame).toContain('直接回答');
      expect(frame).toContain('↓ 1 tokens · 思考完成 · 正在回答');
    });

    release();
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('↓ 1 tokens · 思考完成');
    });
  });

  it('completes each model turn before tools and re-enters streaming phases on later deltas', async () => {
    let releaseTool!: () => void;
    let releaseReasoning!: () => void;
    let releaseAnswer!: () => void;
    let releaseTask!: () => void;
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    const reasoningGate = new Promise<void>(resolve => { releaseReasoning = resolve; });
    const answerGate = new Promise<void>(resolve => { releaseAnswer = resolve; });
    const taskGate = new Promise<void>(resolve => { releaseTask = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'reasoning_delta', text: '工具前分析'};
      yield {type: 'assistant_turn_finished'};
      yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
      await toolGate;
      yield {
        type: 'tool_finished',
        name: 'read_file',
        result: {ok: true, summary: 'README.md'},
      };
      yield {type: 'reasoning_delta', text: '继续分析'};
      await reasoningGate;
      yield {type: 'assistant_delta', text: '最终回答'};
      await answerGate;
      yield {type: 'assistant_message', text: '最终回答'};
      await taskGate;
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('读取后回答');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('状态 › 运行中 · 正在调用 read_file');
      expect(frame).toContain('↓ 1 tokens · 思考完成');
      expect(frame).not.toContain('正在回答');
    });

    releaseTool();
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('↓ 2 tokens · 思考中');
    });

    releaseReasoning();
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('↓ 3 tokens · 思考完成 · 正在回答');
    });

    releaseAnswer();
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('输入已锁定');
      expect(frame).toContain('↓ 3 tokens · 思考完成');
      expect(frame).not.toContain('正在回答');
    });

    releaseTask();
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('输入已锁定');
    });
  });

  it('ignores text input while a task is running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'tool_started', name: 'list_files', input: {path: '/workspace'}};
      await blocked;
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('检查项目');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('输入已锁定'));

    app.stdin.write('好了吗');
    app.stdin.write('\r');
    await new Promise<void>(resolve => setTimeout(resolve, 10));

    expect(runTask).toHaveBeenCalledOnce();
    expect(app.lastFrame()).not.toContain('好了吗');
    expect(app.lastFrame()).not.toContain('当前任务仍在运行');
    release();
  });

  it('aborts once and exits after the second Ctrl+C while a task runs', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const onExit = vi.fn(async () => undefined);
    const runTask = vi.fn(async function* (_task: string, signal: AbortSignal): AsyncIterable<AgentUiEvent> {
      yield {type: 'status', text: '正在读取'};
      await Promise.race([
        blocked,
        new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})),
      ]);
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('读取 README');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(runTask).toHaveBeenCalled());
    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(runTask.mock.calls[0]?.[1].aborted).toBe(true));
    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
    release();
  });

  it('persists one interruption before exiting on the second Ctrl+C', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const steps: string[] = [];
    const appendInterrupted = vi.fn(async () => {
      steps.push('append');
      await Promise.resolve();
      steps.push('persisted');
    });
    const onExit = vi.fn(async () => { steps.push('exit'); });
    const runTask = vi.fn(async function* (_task: string, signal: AbortSignal): AsyncIterable<AgentUiEvent> {
      await Promise.race([
        blocked,
        new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true})),
      ]);
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      appendInterrupted={appendInterrupted}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('读取 README');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(runTask).toHaveBeenCalled());
    app.stdin.write('\u0003');
    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());

    expect(appendInterrupted).toHaveBeenCalledOnce();
    expect(steps).toEqual(['append', 'persisted', 'exit']);
    release();
  });

  it('renders a pending confirmation and forwards an allow-once response locally', async () => {
    const respond = vi.fn();
    const confirmation = {
      getPending: () => ({
        id: 1,
        operation: {tool: 'apply_patch', input: {operations: []}},
        boundary: {
          action: 'confirm' as const,
          risk: 'high' as const,
          reasons: ['补丁涉及敏感配置'],
          normalizedScope: ['update:.env'],
          fingerprint: 'fingerprint',
        },
      }),
      subscribe: () => () => undefined,
      respond,
      request: vi.fn(async () => 'deny' as const),
      close: vi.fn(),
    };
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      confirmation={confirmation}
    />);

    await waitForInputListener();
    expect(app.lastFrame()).toContain('确认请求');
    expect(app.lastFrame()).toContain('apply_patch');
    app.stdin.write('a');

    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('allow_once'));
    expect(idleTask).not.toHaveBeenCalled();
  });

  it('cancels a pending confirmation when Ctrl+C aborts its running task', async () => {
    let listener: (() => void) | undefined;
    let pending: ReturnType<typeof pendingRequest> | undefined;
    const respond = vi.fn();
    const confirmation = {
      getPending: () => pending,
      subscribe: (next: () => void) => { listener = next; return () => undefined; },
      respond,
      request: vi.fn(async () => 'deny' as const),
      close: vi.fn(),
    };
    const runTask = vi.fn(async function* (_task: string, signal: AbortSignal): AsyncIterable<AgentUiEvent> {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      confirmation={confirmation}
    />);

    await waitForInputListener();
    app.stdin.write('修改 README');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(runTask).toHaveBeenCalled());
    pending = pendingRequest();
    listener?.();
    await vi.waitFor(() => expect(app.lastFrame()).toContain('确认请求'));
    app.stdin.write('\u0003');

    await vi.waitFor(() => expect(runTask.mock.calls[0]?.[1].aborted).toBe(true));
    expect(respond).toHaveBeenCalledWith('deny');
  });

  it('saves an explicit exit checkpoint before leaving', async () => {
    const saveSession = vi.fn(async () => undefined);
    const onExit = vi.fn(async () => undefined);
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      saveSession={saveSession}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('/exit');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());

    expect(saveSession).toHaveBeenCalledWith('exit');
  });
});

function pendingRequest() {
  return {
    id: 1,
    operation: {tool: 'apply_patch', input: {operations: []}},
    boundary: {
      action: 'confirm' as const,
      risk: 'high' as const,
      reasons: ['补丁涉及敏感配置'],
      normalizedScope: ['update:.env'],
      fingerprint: 'fingerprint',
    },
  };
}
