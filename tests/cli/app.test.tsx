import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {render} from 'ink-testing-library';
import {App} from '../../src/cli/app.js';
import type {AgentUiEvent} from '../../src/cli/reducer.js';
import type {ToolResult} from '../../src/tools/types.js';

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
      expect(app.lastFrame()).toContain('浩宸 › README 描述了浩宸信号');
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

    await vi.waitFor(() => expect(app.lastFrame()).toContain('你 › 修复登录问题'));
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
