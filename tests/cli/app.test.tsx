import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {render} from 'ink-testing-library';
import {App, formatTokenCount} from '../../src/cli/app.js';
import type {AgentUiEvent} from '../../src/cli/reducer.js';
import type {ToolResult} from '../../src/tools/types.js';
import {GateReporter} from '../../src/cli/gate-reporter.js';
import type {HaochenConfig} from '../../src/config/schema.js';
import {resolveStartupApiKey} from '../../src/cli/startup-credentials.js';
import {createTaskInterruptionRouter} from '../../src/cli/task-interruption.js';
import type {SessionEvent} from '../../src/sessions/types.js';
import {createLatestModelConfigSaver} from '../../src/cli/model-config.js';

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
const modelConfig: HaochenConfig = {
  version: 2,
  providers: [{
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.test/v1',
    credentialRef: 'deepseek',
    headers: {},
  }],
  models: [{
    id: 'deepseek-chat',
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    contextWindow: 128_000,
  }],
  activeModelId: 'deepseek-chat',
  timeoutMs: 60_000,
};
const multiModelConfig: HaochenConfig = {
  ...modelConfig,
  models: [
    modelConfig.models[0]!,
    {
      id: 'deepseek-reasoner',
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner',
      contextWindow: 256_000,
    },
  ],
};
const threeModelConfig: HaochenConfig = {
  ...multiModelConfig,
  models: [
    ...multiModelConfig.models,
    {
      id: 'deepseek-coder',
      providerId: 'deepseek',
      modelId: 'deepseek-coder',
      displayName: 'DeepSeek Coder',
      contextWindow: 512_000,
    },
  ],
};
const emptyModelConfig: HaochenConfig = {
  version: 2,
  providers: [],
  models: [],
  timeoutMs: 60_000,
};

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

  it('rejects an ordinary question before starting or locking a task when no model is bound', async () => {
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {});
    const executeTool = vi.fn(async () => toolResult);
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model=""
      modelConfig={emptyModelConfig}
      executeTool={executeTool}
    />);

    await waitForInputListener();
    app.stdin.write('解释这个项目');
    app.stdin.write('\r');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain(
        '未绑定模型，请先使用 /model 配置并选择模型。',
      );
    });
    expect(runTask).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain('输入已锁定');
    expect(app.lastFrame()).not.toContain('正在理解任务');

    app.stdin.write('/help');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('内置命令：'));

    app.stdin.write('/diff');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledWith(
      'git_diff',
      {},
      expect.any(AbortSignal),
    ));
  });

  it('rejects compact explicitly without locking input when no model is bound', async () => {
    const compact = vi.fn(async () => ({ok: true, message: '已压缩'}));
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model=""
      modelConfig={emptyModelConfig}
      compact={compact}
    />);

    await waitForInputListener();
    app.stdin.write('/compact');
    app.stdin.write('\r');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain(
        '未绑定模型，无法压缩历史；请先使用 /model 配置并选择模型。',
      );
    });
    expect(compact).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain('输入已锁定');
  });

  it('collects a missing provider key inside the controlled Ink TTY without disabling raw input', async () => {
    const promptModule = await import(
      '../../src/cli/credential-prompt.js'
    ).catch(() => undefined);
    expect(promptModule).toBeDefined();
    if (promptModule === undefined) return;
    const credentialPrompt = new promptModule.InteractiveCredentialPromptBroker(
      true,
    );
    const provider = modelConfig.providers[0]!;
    let resolvedKey: string | undefined;
    const runTask = vi.fn(async function* (
      _task: string,
      signal: AbortSignal,
    ): AsyncIterable<AgentUiEvent> {
      resolvedKey = await resolveStartupApiKey({
        provider,
        platform: 'linux',
        env: {},
        readKeychain: async () => undefined,
        prompt: () => credentialPrompt.request(provider, signal),
      });
      yield {type: 'assistant_text', text: '凭据已接收'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={modelConfig}
      credentialPrompt={credentialPrompt}
    />);
    const setRawMode = vi.spyOn(app.stdin, 'setRawMode');

    await waitForInputListener();
    app.stdin.write('触发模型');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('DeepSeek API Key：');
    });

    app.stdin.write('provider-secret');
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('•'.repeat('provider-secret'.length));
      expect(frame).not.toContain('provider-secret');
    });
    app.stdin.write('\r');

    await vi.waitFor(() => {
      expect(resolvedKey).toBe('provider-secret');
      expect(app.lastFrame()).toContain('凭据已接收');
    });
    expect(app.frames.join('\n')).not.toContain('provider-secret');
    expect(JSON.stringify(modelConfig)).not.toContain('provider-secret');
    expect(setRawMode).not.toHaveBeenCalledWith(false);

    app.stdin.write('/help');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('内置命令：'));
    expect(runTask).toHaveBeenCalledOnce();
    expect(setRawMode).not.toHaveBeenCalledWith(false);
  });

  it('aborts a pending credential prompt without exiting and restores command input', async () => {
    const promptModule = await import(
      '../../src/cli/credential-prompt.js'
    );
    const credentialPrompt = new promptModule.InteractiveCredentialPromptBroker(
      true,
    );
    const provider = modelConfig.providers[0]!;
    const onExit = vi.fn(async () => undefined);
    const runTask = vi.fn(async function* (
      _task: string,
      signal: AbortSignal,
    ): AsyncIterable<AgentUiEvent> {
      await resolveStartupApiKey({
        provider,
        platform: 'linux',
        env: {},
        readKeychain: async () => undefined,
        prompt: () => credentialPrompt.request(provider, signal),
      });
      yield {type: 'assistant_text', text: '不应执行'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={modelConfig}
      credentialPrompt={credentialPrompt}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('触发模型');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(credentialPrompt.getPending()).toBeDefined();
      expect(app.lastFrame()).toContain('DeepSeek API Key：');
    });

    app.stdin.write('partial-secret');
    app.stdin.write('\u0003');

    await vi.waitFor(() => {
      expect(runTask.mock.calls[0]?.[1].aborted).toBe(true);
      expect(credentialPrompt.getPending()).toBeUndefined();
      expect(app.lastFrame()).not.toContain('DeepSeek API Key：');
      expect(app.lastFrame()).toContain('浩宸 ›');
    });
    expect(onExit).not.toHaveBeenCalled();
    expect(app.frames.join('\n')).not.toContain('partial-secret');

    app.stdin.write('/help');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('内置命令：'));
    expect(runTask).toHaveBeenCalledOnce();

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it('writes a second credential-wait interruption to the task session before exit', async () => {
    const promptModule = await import(
      '../../src/cli/credential-prompt.js'
    );
    const credentialPrompt = new promptModule.InteractiveCredentialPromptBroker(
      true,
    );
    const provider = modelConfig.providers[0]!;
    const writes: Array<{sessionId: string; event: SessionEvent}> = [];
    const router = createTaskInterruptionRouter(async (sessionId, event) => {
      writes.push({sessionId, event});
    });
    let currentSessionId = 'task-session';
    const onExit = vi.fn(async () => undefined);
    const runTask = vi.fn(async function* (
      _task: string,
      signal: AbortSignal,
    ): AsyncIterable<AgentUiEvent> {
      const binding = router.beginTask(currentSessionId);
      try {
        await resolveStartupApiKey({
          provider,
          platform: 'linux',
          env: {},
          readKeychain: async () => undefined,
          prompt: () => credentialPrompt.request(provider, signal),
        });
      } finally {
        binding.finish();
      }
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId={currentSessionId}
      model="deepseek-chat"
      modelConfig={modelConfig}
      credentialPrompt={credentialPrompt}
      appendInterrupted={reason => router.appendCurrent(
        currentSessionId,
        reason,
      )}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('触发模型');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(credentialPrompt.getPending()).toBeDefined();
    });

    currentSessionId = 'resumed-session';
    app.stdin.write('\u0003');
    app.stdin.write('\u0003');

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sessionId: 'task-session',
      event: {type: 'interrupted', reason: '用户中止'},
    });
  });

  it('shows real context usage and one unchanged previous-round total for multiple tools', async () => {
    let releaseTools!: () => void;
    let releaseNextRound!: () => void;
    const toolsGate = new Promise<void>(resolve => { releaseTools = resolve; });
    const nextRoundGate = new Promise<void>(resolve => { releaseNextRound = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'usage', inputTokens: 12, outputTokens: 3};
      yield {type: 'assistant_turn_finished'};
      yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
      yield {
        type: 'tool_finished',
        name: 'read_file',
        result: {ok: true, summary: 'README.md'},
      };
      yield {type: 'tool_started', name: 'read_file', input: {path: 'CHANGELOG.md'}};
      await toolsGate;
      yield {
        type: 'tool_finished',
        name: 'read_file',
        result: {ok: true, summary: 'CHANGELOG.md'},
      };
      yield {type: 'reasoning_delta', text: '继续'};
      await nextRoundGate;
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      contextTokens={128_000}
    />);

    await waitForInputListener();
    app.stdin.write('读取两个文件');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('上下文 15 / 128k');
      expect(frame).toContain('↑ 15 tokens · 上一轮总量');
      expect(frame).not.toContain('↑ 30 tokens');
    });

    releaseTools();
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('↓ 1 tokens · 思考中 · 上下文 15 / 128k');
      expect(frame).not.toContain('上一轮总量');
    });

    releaseNextRound();
  });

  it('shows unknown previous-round usage instead of substituting stream deltas', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'reasoning_delta', text: '分析'};
      yield {type: 'assistant_turn_finished'};
      yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
      await blocked;
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      contextTokens={128_000}
    />);

    await waitForInputListener();
    app.stdin.write('读取文件');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('上下文 0 / 128k');
      expect(frame).toContain('↑ -- tokens · 上一轮总量未知');
      expect(frame).not.toContain('↑ 1 tokens');
    });

    release();
  });

  it('renders the injected answer after collapsing its tool events', async () => {
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

    expect(app.lastFrame()).not.toContain('工具 › read_file');
    expect(app.lastFrame()).toContain('README 描述了浩宸信号');
  });

  it('keeps submitted user text in the transcript', async () => {
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {});
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      maxToolCalls={32}
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

  it.each(['/help', '/status', '/model', '/diff', '/permissions', '/compact', '/clear', '/resume abc', '/exit'])(
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

  it('opens /model as an independent panel and hides ordinary input and suggestions', async () => {
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={modelConfig}
      modelConfigController={{
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save: vi.fn(async () => undefined),
      }}
    />);

    await waitForInputListener();
    app.stdin.write('/model');
    app.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = app.lastFrame();
      expect(frame).toContain('模型配置');
      expect(frame).toContain('DeepSeek Chat');
      expect(frame).not.toContain('浩宸 › ');
      expect(frame).not.toContain('斜杠命令');
    });

    app.stdin.write('\u001B');
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('A 添加供应商');
      expect(app.lastFrame()).toContain('浩宸 ›');
    });
  });

  it('cancels model discovery on the first Ctrl+C and exits on the second', async () => {
    let discoverySignal: AbortSignal | undefined;
    const onExit = vi.fn(async () => undefined);
    const discover = vi.fn(async (request: {signal: AbortSignal}) => {
      discoverySignal = request.signal;
      await new Promise<never>(() => undefined);
      return {modelIds: [], contextWindows: {}};
    });
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={modelConfig}
      modelConfigController={{
        discover,
        save: vi.fn(async () => undefined),
      }}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
    app.stdin.write('a');
    app.stdin.write('\r');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(discover).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain('正在获取模型');
    });

    app.stdin.write('\u0003');
    await vi.waitFor(() => {
      expect(discoverySignal?.aborted).toBe(true);
      expect(app.lastFrame()).toContain('[ 获取模型 ]');
    });
    expect(onExit).not.toHaveBeenCalled();

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it('cancels model saving on the first Ctrl+C and exits on the second', async () => {
    let saveSignal: AbortSignal | undefined;
    const onExit = vi.fn(async () => undefined);
    const save = vi.fn(async (request: {signal: AbortSignal}) => {
      saveSignal = request.signal;
      await new Promise<never>(() => undefined);
    });
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={multiModelConfig}
      modelConfigController={{
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save,
      }}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain('正在保存模型配置');
    });

    app.stdin.write('\u0003');
    await vi.waitFor(() => {
      expect(saveSignal?.aborted).toBe(true);
      expect(app.lastFrame()).toContain('DeepSeek Reasoner');
      expect(app.lastFrame()).not.toContain('正在保存模型配置');
    });
    expect(onExit).not.toHaveBeenCalled();

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
  });

  it('applies a save that commits after cancellation when no newer save replaces it', async () => {
    let releaseRename!: () => void;
    const renameGate = new Promise<void>(resolve => {
      releaseRename = resolve;
    });
    const save = vi.fn(async () => {
      await renameGate;
    });
    const onActiveModelChange = vi.fn();
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={multiModelConfig}
      modelConfigController={{
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save,
      }}
      onActiveModelChange={onActiveModelChange}
    />);

    await waitForInputListener();
    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain('正在保存模型配置');
    });

    app.stdin.write('\u0003');
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('正在保存模型配置');
      expect(app.lastFrame()).toContain('DeepSeek Reasoner');
    });
    releaseRename();

    await vi.waitFor(() => {
      expect(onActiveModelChange).toHaveBeenCalledOnce();
      expect(onActiveModelChange).toHaveBeenCalledWith(
        expect.objectContaining({id: 'deepseek-reasoner'}),
        expect.objectContaining({activeModelId: 'deepseek-reasoner'}),
      );
      expect(app.lastFrame()).toContain('● DeepSeek Reasoner');
    });

    app.stdin.write('\u001B');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('上下文 0 / 256k');
    });
  });

  it('ignores a canceled save that resolves after a newer model save', async () => {
    let saveCount = 0;
    let releaseFirstSave!: () => void;
    const firstSave = new Promise<void>(resolve => {
      releaseFirstSave = resolve;
    });
    const save = vi.fn(async () => {
      saveCount += 1;
      if (saveCount === 1) await firstSave;
    });
    const onActiveModelChange = vi.fn();
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={threeModelConfig}
      modelConfigController={{
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save,
      }}
      onActiveModelChange={onActiveModelChange}
    />);

    await waitForInputListener();
    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));

    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain('正在保存模型配置');
    });

    app.stdin.write('\u0003');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('DeepSeek Reasoner');
      expect(app.lastFrame()).not.toContain('正在保存模型配置');
    });

    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
      expect(onActiveModelChange).toHaveBeenCalledOnce();
      expect(onActiveModelChange).toHaveBeenCalledWith(
        expect.objectContaining({id: 'deepseek-coder'}),
        expect.objectContaining({activeModelId: 'deepseek-coder'}),
      );
      expect(app.lastFrame()).toContain('● DeepSeek Coder');
    });

    releaseFirstSave();
    await vi.waitFor(() => {
      expect(onActiveModelChange).toHaveBeenCalledOnce();
      expect(app.lastFrame()).toContain('● DeepSeek Coder');
    });

    app.stdin.write('\u001B');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('上下文 0 / 512k');
    });
  });

  it.each([
    ['canceled before persistence', 'cancel'],
    ['rejected by persistence', 'reject'],
  ] as const)(
    'reconciles the UI to committed A when queued B is %s',
    async (_description, outcome) => {
      let releaseA!: () => void;
      const aGate = new Promise<void>(resolve => {
        releaseA = resolve;
      });
      let diskConfig: HaochenConfig = threeModelConfig;
      let committedConfig: HaochenConfig = threeModelConfig;
      const persistFailure = new Error('B persistence failed');
      const save = createLatestModelConfigSaver({
        persist: async request => {
          if (request.config.activeModelId === 'deepseek-reasoner') {
            await aGate;
            diskConfig = request.config;
            return;
          }
          throw persistFailure;
        },
        commit: request => {
          committedConfig = request.config;
        },
      });
      const onActiveModelChange = vi.fn();
      const modelConfigController = {
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save,
        getCommittedConfig: () => committedConfig,
      };
      const app = render(<App
        runTask={idleTask}
        workspace="/workspace"
        sessionId="signal-1"
        model="deepseek-chat"
        modelConfig={threeModelConfig}
        modelConfigController={modelConfigController}
        onActiveModelChange={onActiveModelChange}
      />);

      await waitForInputListener();
      app.stdin.write('/model');
      app.stdin.write('\r');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
      app.stdin.write('\u001B[B');
      app.stdin.write('\r');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('正在保存模型配置'));
      app.stdin.write('\u0003');
      await vi.waitFor(() => expect(app.lastFrame()).not.toContain('正在保存模型配置'));

      app.stdin.write('\u001B[B');
      app.stdin.write('\r');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('正在保存模型配置'));
      if (outcome === 'cancel') {
        app.stdin.write('\u0003');
        await vi.waitFor(() => expect(app.lastFrame()).not.toContain('正在保存模型配置'));
      }
      releaseA();

      await vi.waitFor(() => {
        expect(diskConfig.activeModelId).toBe('deepseek-reasoner');
        expect(committedConfig.activeModelId).toBe('deepseek-reasoner');
        expect(onActiveModelChange).toHaveBeenLastCalledWith(
          expect.objectContaining({id: 'deepseek-reasoner'}),
          expect.objectContaining({activeModelId: 'deepseek-reasoner'}),
        );
        expect(app.lastFrame()).toContain('› ● DeepSeek Reasoner');
      });
    },
  );

  it('updates the context limit immediately and isolates recent usage by model', async () => {
    const save = vi.fn(async () => undefined);
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'usage', inputTokens: 12, outputTokens: 3};
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={multiModelConfig}
      modelConfigController={{
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save,
      }}
    />);

    await waitForInputListener();
    app.stdin.write('记录用量');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('上下文 15 / 128k');
    });

    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({activeModelId: 'deepseek-reasoner'}),
      }));
      expect(app.lastFrame()).toContain('● DeepSeek Reasoner');
    });
    app.stdin.write('\u001B');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('上下文 0 / 256k');
    });

    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
    app.stdin.write('\u001B[A');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('● DeepSeek Chat'));
    app.stdin.write('\u001B');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('上下文 15 / 128k');
    });
  });

  it('drops deleted model usage before the same local id is added again', async () => {
    const reusableIdConfig: HaochenConfig = {
      version: 2,
      providers: [{
        id: 'provider-deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.test/v1',
        credentialRef: 'provider-deepseek',
        headers: {},
      }],
      models: [{
        id: 'model-deepseek-deepseek-chat',
        providerId: 'provider-deepseek',
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        contextWindow: 128_000,
      }],
      activeModelId: 'model-deepseek-deepseek-chat',
      timeoutMs: 60_000,
    };
    const save = vi.fn(async () => undefined);
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'usage', inputTokens: 12, outputTokens: 3};
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="deepseek-chat"
      modelConfig={reusableIdConfig}
      modelConfigController={{
        discover: vi.fn(async () => ({modelIds: [], contextWindows: {}})),
        save,
      }}
    />);

    await waitForInputListener();
    app.stdin.write('记录用量');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('上下文 15 / 128k'));

    app.stdin.write('/model');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型配置'));
    app.stdin.write('d');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('尚未添加模型'));

    app.stdin.write('a');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('供应商名称'));
    app.stdin.write('DeepSeek');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('API 地址'));
    app.stdin.write('https://api.deepseek.test/v1');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('API Key'));
    app.stdin.write('secret');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('[ 手动添加 Model ID ]'));
    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('手动添加模型'));
    app.stdin.write('deepseek-chat');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型详情 · 1/2'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('模型详情 · 2/2'));
    app.stdin.write('\r');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('● deepseek-chat'));
    app.stdin.write('\u001B');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('上下文 0 / 128k');
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

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

  it('keeps the user and answer after collapsing completed process entries', async () => {
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
      expect(frame).toContain('README 描述了浩宸信号');
      expect(frame).not.toContain('工具 › read_file');
      expect(frame).not.toContain('{"path":"README.md"}');
      expect(frame).not.toContain('审批 › read_file');
      expect(frame).not.toContain('无需 AI 审查');
      expect(frame).not.toContain('结果 › read_file');
    });
  });

  it('renders each tool call as one line and hides this task process when answering starts', async () => {
    let releaseTool!: () => void;
    let releaseAnswer!: () => void;
    const toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
    const answerGate = new Promise<void>(resolve => { releaseAnswer = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'reasoning_delta', text: '先读取文件'};
      yield {type: 'assistant_turn_finished'};
      yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
      await toolGate;
      yield {
        type: 'tool_finished',
        name: 'read_file',
        result: {ok: true, summary: '已读取 README.md'},
      };
      yield {type: 'reasoning_delta', text: '组织回答'};
      await answerGate;
      yield {type: 'assistant_delta', text: '开始输出'};
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
      const toolLines = (app.lastFrame() ?? '')
        .split('\n')
        .filter(line => line.includes('工具 › read_file'));
      expect(toolLines).toEqual([
        expect.stringContaining('工具 › read_file · 读取碎片 · {"path":"README.md"}'),
      ]);
    });

    releaseTool();
    await vi.waitFor(() => {
      const toolLines = (app.lastFrame() ?? '')
        .split('\n')
        .filter(line => line.includes('工具 › read_file'));
      expect(toolLines).toHaveLength(1);
      expect(toolLines[0]).toContain('✓ 已读取 README.md');
    });

    releaseAnswer();
    await vi.waitFor(() => {
      const frame = app.lastFrame() ?? '';
      expect(frame).toContain('开始输出');
      expect(frame).not.toContain('先读取文件');
      expect(frame).not.toContain('组织回答');
      expect(frame).not.toContain('工具 › read_file');
      expect(frame).not.toContain('已读取 README.md');
    });
  });

  it('truncates a long compact tool entry instead of wrapping it', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {
        type: 'tool_started',
        name: 'read_file',
        input: {path: `long-${'segment-'.repeat(40)}.md`},
      };
      await blocked;
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
    />);

    await waitForInputListener();
    app.stdin.write('读取长路径');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      const lines = (app.lastFrame() ?? '').split('\n');
      const toolIndex = lines.findIndex(line => line.includes('工具 › read_file'));
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      const nextNonEmpty = lines
        .slice(toolIndex + 1)
        .find(line => line.trim().length > 0);
      expect(nextNonEmpty?.trimStart()).toMatch(/^↓ /);
    });

    release();
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
        '状态 › 运行中 · 正在调用 read_file · 工具 1/32 次 · Ctrl+C 中止',
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

  it('shows the latest tool count while a task is running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {
      yield {type: 'tool_started', name: 'read_file', input: {path: 'README.md'}};
      yield {type: 'tool_started', name: 'git_status', input: {}};
      await blocked;
      yield {type: 'assistant_text', text: '完成'};
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      maxToolCalls={5}
    />);

    await waitForInputListener();
    app.stdin.write('检查项目');
    app.stdin.write('\r');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain(
        '状态 › 运行中 · 正在调用 git_status · 工具 2/5 次 · Ctrl+C 中止',
      );
    });

    release();
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('状态 › 运行中');
    });
  });

  it('locks input, preserves live tokens and rejects an uncommitted result after abort', async () => {
    const runTask = vi.fn(async function* (): AsyncIterable<AgentUiEvent> {});
    const onExit = vi.fn(async () => undefined);
    const appendInterrupted = vi.fn(async () => undefined);
    let compactSignal: AbortSignal | undefined;
    const compact = vi.fn(async (
      signal: AbortSignal,
      onProgress: (streamTokens: number) => void,
    ) => {
      compactSignal = signal;
      onProgress(2);
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true});
      });
      return {
        ok: true,
        message: '已压缩历史。',
        committed: false,
        streamTokens: 99,
      };
    });
    const app = render(<App
      runTask={runTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      compact={compact}
      appendInterrupted={appendInterrupted}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('/compact');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(compact).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(app.lastFrame()).toContain('正在压缩历史');
      expect(app.lastFrame()).toContain('输入已锁定');
      expect(app.lastFrame()).toContain('↓ 2 tokens · 思考中');
    });

    app.stdin.write('是');
    app.stdin.write('\r');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(runTask).not.toHaveBeenCalled();
    expect(app.lastFrame()).not.toContain('你 ›\n是');

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(compactSignal?.aborted).toBe(true));
    await vi.waitFor(() => {
      expect(app.lastFrame()).not.toContain('输入已锁定');
      expect(app.lastFrame()).toContain('↓ 2 tokens · 思考完成');
    });
    expect(app.lastFrame()).not.toContain('↓ 99 tokens');
    expect(app.lastFrame()).not.toContain('已压缩历史。');
    expect(onExit).not.toHaveBeenCalled();
    expect(appendInterrupted).not.toHaveBeenCalled();
  });

  it('exits on a second Ctrl+C while an aborted compact is still settling', async () => {
    let compactSignal: AbortSignal | undefined;
    let releaseCompact!: () => void;
    const compactBlocked = new Promise<void>(resolve => { releaseCompact = resolve; });
    const onExit = vi.fn(async () => undefined);
    const saveSession = vi.fn(async () => undefined);
    const appendInterrupted = vi.fn(async () => undefined);
    const compact = vi.fn(async (signal: AbortSignal) => {
      compactSignal = signal;
      await compactBlocked;
      return {ok: false, message: '已中止历史压缩。', committed: false};
    });
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      compact={compact}
      saveSession={saveSession}
      appendInterrupted={appendInterrupted}
      onExit={onExit}
    />);

    await waitForInputListener();
    app.stdin.write('/compact');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(compactSignal).toBeDefined());

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(compactSignal?.aborted).toBe(true));
    expect(onExit).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
    expect(saveSession).toHaveBeenCalledWith('exit');
    expect(appendInterrupted).not.toHaveBeenCalled();
    releaseCompact();
  });

  it('shows compact tokens before resolution and reconciles the exact final total', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const compact = vi.fn(async (
      _signal: AbortSignal,
      onProgress: (streamTokens: number) => void,
    ) => {
      onProgress(1);
      await blocked;
      onProgress(2);
      return {
        ok: true,
        message: '已压缩历史。',
        committed: true,
        streamTokens: 3,
      };
    });
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      compact={compact}
    />);

    await waitForInputListener();
    app.stdin.write('/compact');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('↓ 1 tokens · 思考中');
      expect(app.lastFrame()).toContain('输入已锁定');
    });

    release();
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('↓ 3 tokens · 思考完成');
      expect(app.lastFrame()).not.toContain('↓ 5 tokens');
      expect(app.lastFrame()).toContain('已压缩历史。');
    });
  });

  it('reports committed compact success even when abort happens during append', async () => {
    let compactSignal: AbortSignal | undefined;
    const compact = vi.fn(async (signal: AbortSignal) => {
      compactSignal = signal;
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), {once: true});
      });
      return {
        ok: true,
        message: '已压缩历史。',
        committed: true,
        streamTokens: 3,
      };
    });
    const app = render(<App
      runTask={idleTask}
      workspace="/workspace"
      sessionId="signal-1"
      model="wolf-2"
      compact={compact}
    />);

    await waitForInputListener();
    app.stdin.write('/compact');
    app.stdin.write('\r');
    await vi.waitFor(() => expect(compactSignal).toBeDefined());

    app.stdin.write('\u0003');
    await vi.waitFor(() => expect(compactSignal?.aborted).toBe(true));
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('完成 › 完成');
      expect(app.lastFrame()).toContain('已压缩历史。');
      expect(app.lastFrame()).toContain('↓ 3 tokens · 思考完成');
    });
    expect(app.lastFrame()).not.toContain('已中止历史压缩。');
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
