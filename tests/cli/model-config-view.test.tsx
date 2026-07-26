import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import type {HaochenConfig} from '../../src/config/schema.js';
import {
  createModelConfigState,
  transitionModelConfig,
  type ModelConfigState,
} from '../../src/cli/model-config.js';
import {ModelConfigView} from '../../src/cli/model-config-view.js';
import {providerApiKeyEnvironmentVariable} from '../../src/config/credentials.js';

const emptyConfig: HaochenConfig = {
  version: 2,
  providers: [],
  models: [],
  timeoutMs: 60_000,
};

const populatedConfig: HaochenConfig = {
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
const interleavedConfig: HaochenConfig = {
  version: 2,
  providers: [
    populatedConfig.providers[0]!,
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.test/v1',
      credentialRef: 'anthropic',
      headers: {},
    },
  ],
  models: [
    populatedConfig.models[0]!,
    {
      id: 'claude-opus',
      providerId: 'anthropic',
      modelId: 'claude-opus',
      displayName: 'Claude Opus',
      contextWindow: 200_000,
    },
    {
      id: 'deepseek-reasoner',
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner',
      contextWindow: 128_000,
    },
  ],
  activeModelId: 'deepseek-chat',
  timeoutMs: 60_000,
};

function StatefulView(props: {initial: ModelConfigState}) {
  const [state, setState] = React.useState(props.initial);
  return <ModelConfigView
    state={state}
    onAction={action => setState(previous => transitionModelConfig(previous, action).state)}
  />;
}

describe('ModelConfigView', () => {
  it('renders an empty state without a selection cursor', () => {
    const app = render(<ModelConfigView
      state={createModelConfigState(emptyConfig)}
      onAction={vi.fn()}
    />);

    expect(app.lastFrame()).toContain('模型配置');
    expect(app.lastFrame()).toContain('尚未添加模型');
    expect(app.lastFrame()).toContain('A 添加供应商');
    expect(app.lastFrame()).not.toContain('› ');
  });

  it('groups models and marks the current model', () => {
    const app = render(<ModelConfigView
      state={createModelConfigState(populatedConfig)}
      onAction={vi.fn()}
    />);

    expect(app.lastFrame()).toContain('DeepSeek');
    expect(app.lastFrame()).toContain('● DeepSeek Chat');
    expect(app.lastFrame()).toContain('128k');
    expect(app.lastFrame()).toContain('当前');
    expect(app.lastFrame()).toContain('A 添加模型  E 编辑  D 删除  Enter 切换');
  });

  it('offers the selected provider or a new provider when adding a model', () => {
    const state = transitionModelConfig(
      createModelConfigState(populatedConfig),
      {type: 'add'},
    ).state;
    const app = render(<ModelConfigView state={state} onAction={vi.fn()}/>);

    expect(app.lastFrame()).toContain('添加到当前供应商（DeepSeek）');
    expect(app.lastFrame()).toContain('添加新供应商');
  });

  it('shows the provider API address and dedicated environment variable in its action screen', () => {
    let state = transitionModelConfig(
      createModelConfigState(populatedConfig),
      {type: 'add'},
    ).state;
    state = transitionModelConfig(state, {type: 'submit'}).state;
    const app = render(<ModelConfigView state={state} onAction={vi.fn()}/>);

    expect(app.lastFrame()).toContain('https://api.deepseek.test/v1');
    expect(app.lastFrame()).toContain(
      providerApiKeyEnvironmentVariable('deepseek'),
    );
  });

  it('renders and selects interleaved models in the same provider-group order', () => {
    let state = createModelConfigState(interleavedConfig);
    state = transitionModelConfig(state, {type: 'move', delta: 1}).state;
    const app = render(<ModelConfigView state={state} onAction={vi.fn()}/>);
    const frame = app.lastFrame() ?? '';

    expect(frame.indexOf('DeepSeek Chat')).toBeLessThan(
      frame.indexOf('DeepSeek Reasoner'),
    );
    expect(frame.indexOf('DeepSeek Reasoner')).toBeLessThan(
      frame.indexOf('Claude Opus'),
    );
    expect(frame).toContain('› ○ DeepSeek Reasoner');
    expect(frame).not.toContain('› ○ Claude Opus');
  });

  it('renders API Key input as bullets rather than plaintext', async () => {
    let state = transitionModelConfig(
      createModelConfigState(emptyConfig),
      {type: 'add'},
    ).state;
    for (const character of 'Moonshot') {
      state = transitionModelConfig(state, {type: 'character', value: character}).state;
    }
    state = transitionModelConfig(state, {type: 'submit'}).state;
    for (const character of 'https://api.moonshot.test/v1') {
      state = transitionModelConfig(state, {type: 'character', value: character}).state;
    }
    state = transitionModelConfig(state, {type: 'submit'}).state;
    const app = render(<StatefulView initial={state}/>);

    app.stdin.write('secret');

    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain('API Key');
      expect(app.lastFrame()).toContain('••••••');
      expect(app.lastFrame()).not.toContain('secret');
    });
  });

  it('shows the discovered model picker and dispatches arrow/Enter actions', async () => {
    let state = createModelConfigState(emptyConfig);
    state = {
      ...state,
      screen: 'discovered_models',
      discoveredModelIds: ['alpha', 'beta'],
      selectedDiscoveredIndex: 0,
    };
    const onAction = vi.fn();
    const app = render(<ModelConfigView state={state} onAction={onAction}/>);

    expect(app.lastFrame()).toContain('选择要添加的模型');
    expect(app.lastFrame()).toContain('› alpha');
    expect(app.lastFrame()).toContain('Enter 添加  ↑↓ 选择  Esc 返回');

    app.stdin.write('\u001B[B');
    app.stdin.write('\r');
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({type: 'move', delta: 1});
      expect(onAction).toHaveBeenCalledWith({type: 'submit'});
    });
  });

  it('shows Model ID as read-only and the default detail values', () => {
    const state: ModelConfigState = {
      ...createModelConfigState(emptyConfig),
      screen: 'model_display_name',
      form: {
        providerName: 'Moonshot',
        baseUrl: 'https://api.moonshot.test/v1',
        apiKey: 'secret',
        modelId: 'moonshot-v1',
        displayName: 'moonshot-v1',
        contextWindow: '128000',
      },
    };
    const app = render(<ModelConfigView state={state} onAction={vi.fn()}/>);

    expect(app.lastFrame()).toContain('Model ID（只读）：moonshot-v1');
    expect(app.lastFrame()).toContain('显示名称：moonshot-v1');
  });
});
