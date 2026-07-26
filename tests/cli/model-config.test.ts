import {describe, expect, it} from 'vitest';
import type {HaochenConfig} from '../../src/config/schema.js';
import {
  createModelConfigState,
  ModelConfigOperationController,
  orderedModels,
  transitionModelConfig,
  type ModelConfigAction,
  type ModelConfigState,
} from '../../src/cli/model-config.js';

const config: HaochenConfig = {
  version: 2,
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.test/v1',
      credentialRef: 'deepseek',
      headers: {},
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.test/v1',
      credentialRef: 'anthropic',
      headers: {},
    },
  ],
  models: [
    {
      id: 'deepseek-chat',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      contextWindow: 128_000,
    },
    {
      id: 'deepseek-reasoner',
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner',
      contextWindow: 128_000,
    },
    {
      id: 'claude-opus',
      providerId: 'anthropic',
      modelId: 'claude-opus',
      displayName: 'Claude Opus',
      contextWindow: 200_000,
    },
  ],
  activeModelId: 'deepseek-chat',
  timeoutMs: 60_000,
};
const interleavedConfig: HaochenConfig = {
  ...config,
  models: [
    config.models[0]!,
    config.models[2]!,
    config.models[1]!,
  ],
};

function step(
  state: ModelConfigState,
  action: ModelConfigAction,
): ModelConfigState {
  return transitionModelConfig(state, action).state;
}

function typeText(state: ModelConfigState, text: string): ModelConfigState {
  let current = state;
  for (const character of text) {
    current = step(current, {type: 'character', value: character});
  }
  return current;
}

describe('model configuration state machine', () => {
  it('moves across provider groups and wraps at the ends', () => {
    let state = createModelConfigState(config);

    state = step(state, {type: 'move', delta: 1});
    expect(state.selectedModelIndex).toBe(1);
    state = step(state, {type: 'move', delta: 1});
    expect(state.selectedModelIndex).toBe(2);
    state = step(state, {type: 'move', delta: 1});
    expect(state.selectedModelIndex).toBe(0);
    state = step(state, {type: 'move', delta: -1});
    expect(state.selectedModelIndex).toBe(2);
  });

  it('uses provider-group display order for interleaved config models', () => {
    expect(orderedModels(interleavedConfig).map(model => model.id)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
      'claude-opus',
    ]);

    let state = createModelConfigState(interleavedConfig);
    state = step(state, {type: 'move', delta: 1});
    const transition = transitionModelConfig(state, {type: 'submit'});

    expect(state.selectedModelIndex).toBe(1);
    expect(transition.effect).toMatchObject({
      type: 'save',
      config: {activeModelId: 'deepseek-reasoner'},
    });

    const movedUp = step(
      createModelConfigState(interleavedConfig),
      {type: 'move', delta: -1},
    );
    expect(movedUp.selectedModelIndex).toBe(2);
    expect(transitionModelConfig(movedUp, {type: 'submit'}).effect).toMatchObject({
      type: 'save',
      config: {activeModelId: 'claude-opus'},
    });
  });

  it('proposes an atomic active-model save on Enter and applies it only after success', () => {
    let state = createModelConfigState(config);
    state = step(state, {type: 'move', delta: 1});

    const transition = transitionModelConfig(state, {type: 'submit'});

    expect(transition.effect).toMatchObject({
      type: 'save',
      config: {activeModelId: 'deepseek-reasoner'},
    });
    expect(transition.state.config.activeModelId).toBe('deepseek-chat');
    expect(transition.state.screen).toBe('saving');

    state = step(transition.state, {
      type: 'save_succeeded',
      config: (transition.effect as Extract<typeof transition.effect, {type: 'save'}>).config,
    });
    expect(state.config.activeModelId).toBe('deepseek-reasoner');
    expect(state.screen).toBe('list');
  });

  it('opens add/edit/delete actions and Esc closes the list', () => {
    let state = createModelConfigState(config);

    state = step(state, {type: 'add'});
    expect(state.screen).toBe('add_actions');

    state = createModelConfigState(config);
    state = step(state, {type: 'edit'});
    expect(state.screen).toBe('edit_display_name');
    expect(state.form.displayName).toBe('DeepSeek Chat');

    state = createModelConfigState(config);
    const deletion = transitionModelConfig(state, {type: 'delete'});
    expect(deletion.effect).toMatchObject({
      type: 'save',
      config: {
        activeModelId: undefined,
        models: expect.not.arrayContaining([
          expect.objectContaining({id: 'deepseek-chat'}),
        ]),
      },
    });

    const close = transitionModelConfig(createModelConfigState(config), {type: 'escape'});
    expect(close.effect).toEqual({type: 'close'});
  });

  it('exposes abortable discovery and save operation status until settlement', () => {
    const controller = new ModelConfigOperationController();

    expect(controller.status).toBe('idle');
    const discoverySignal = controller.begin('discovering');
    expect(controller.status).toBe('discovering');
    expect(controller.isCurrent(discoverySignal)).toBe(true);

    expect(controller.abort()).toBe('discovering');
    expect(discoverySignal.aborted).toBe(true);
    expect(controller.status).toBe('discovering');

    controller.complete(discoverySignal);
    expect(controller.status).toBe('idle');

    const saveSignal = controller.begin('saving');
    expect(controller.status).toBe('saving');
    controller.abort();
    expect(saveSignal.aborted).toBe(true);
    controller.complete(saveSignal);
    expect(controller.status).toBe('idle');
  });

  it('cancels discovery to provider actions and saving to its editable return screen', () => {
    let discovering = step(createModelConfigState(config), {type: 'add'});
    discovering = step(discovering, {type: 'submit'});
    discovering = step(discovering, {type: 'submit'});
    expect(discovering.screen).toBe('discovering');

    const canceledDiscovery = transitionModelConfig(discovering, {type: 'abort'});
    expect(canceledDiscovery.state.screen).toBe('provider_actions');
    expect(canceledDiscovery.effect).toEqual({type: 'abort_active'});

    let editing = step(createModelConfigState(config), {type: 'edit'});
    editing = step(editing, {type: 'submit'});
    const saving = transitionModelConfig(editing, {type: 'submit'});
    expect(saving.state.screen).toBe('saving');

    const canceledSave = transitionModelConfig(saving.state, {type: 'abort'});
    expect(canceledSave.state.screen).toBe('edit_context_window');
    expect(canceledSave.state.pendingSave).toBeUndefined();
    expect(canceledSave.effect).toEqual({type: 'abort_active'});
  });

  it('adds a second model to the selected provider without duplicating it or requesting a new key', () => {
    let state = step(createModelConfigState(config), {type: 'add'});
    expect(state.screen).toBe('add_actions');

    state = step(state, {type: 'submit'});
    expect(state).toMatchObject({
      screen: 'provider_actions',
      targetProviderId: 'deepseek',
      form: {
        providerName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.test/v1',
        apiKey: '',
      },
    });

    const discovery = transitionModelConfig(state, {type: 'submit'});
    expect(discovery.effect).toMatchObject({
      type: 'discover',
      provider: {id: 'deepseek'},
    });
    expect(discovery.effect).not.toHaveProperty('apiKey');

    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});
    state = typeText(state, 'deepseek-v3');
    state = step(state, {type: 'submit'});
    state = step(state, {type: 'submit'});
    const save = transitionModelConfig(state, {type: 'submit'});

    expect(save.effect).toMatchObject({
      type: 'save',
      credential: undefined,
      config: {
        activeModelId: 'model-deepseek-deepseek-v3',
        providers: config.providers,
        models: expect.arrayContaining([
          expect.objectContaining({
            id: 'model-deepseek-deepseek-v3',
            providerId: 'deepseek',
            modelId: 'deepseek-v3',
          }),
        ]),
      },
    });
    const savedConfig = (
      save.effect as Extract<typeof save.effect, {type: 'save'}>
    ).config;
    expect(savedConfig.providers).toHaveLength(config.providers.length);
  });

  it('collects provider fields, validates the URL and emits a discovery request', () => {
    let state = step(createModelConfigState(config), {type: 'add'});
    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});
    state = typeText(state, '  Moonshot  ');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('provider_base_url');
    expect(state.form.providerName).toBe('Moonshot');

    state = typeText(state, 'ftp://bad.test');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('provider_base_url');
    expect(state.error).toContain('HTTP(S)');

    while (state.form.baseUrl.length > 0) {
      state = step(state, {type: 'backspace'});
    }
    state = typeText(state, 'https://api.moonshot.test/v1/');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('provider_api_key');
    expect(state.form.baseUrl).toBe('https://api.moonshot.test/v1');

    state = typeText(state, 'super-secret');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('provider_actions');

    const discovery = transitionModelConfig(state, {type: 'submit'});
    expect(discovery.state.screen).toBe('discovering');
    expect(discovery.effect).toMatchObject({
      type: 'discover',
      apiKey: 'super-secret',
      provider: {
        name: 'Moonshot',
        baseUrl: 'https://api.moonshot.test/v1',
        headers: {},
      },
    });
  });

  it('selects a discovered model and defaults details to 128000', () => {
    let state = step(createModelConfigState(config), {type: 'add'});
    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});
    state = typeText(state, 'Moonshot');
    state = step(state, {type: 'submit'});
    state = typeText(state, 'https://api.moonshot.test/v1');
    state = step(state, {type: 'submit'});
    state = typeText(state, 'secret');
    state = step(state, {type: 'submit'});
    state = step(state, {type: 'submit'});
    state = step(state, {
      type: 'discovery_succeeded',
      modelIds: ['moonshot-v1', 'moonshot-v1', 'moonshot-a'],
    });

    expect(state.screen).toBe('discovered_models');
    expect(state.discoveredModelIds).toEqual(['moonshot-a', 'moonshot-v1']);
    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});

    expect(state.screen).toBe('model_display_name');
    expect(state.form.modelId).toBe('moonshot-v1');
    expect(state.form.displayName).toBe('moonshot-v1');
    expect(state.form.contextWindow).toBe('128000');
  });

  it('supports manual Model ID and keeps the API key out of saved config', () => {
    let state = step(createModelConfigState(config), {type: 'add'});
    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});
    state = typeText(state, 'Moonshot');
    state = step(state, {type: 'submit'});
    state = typeText(state, 'https://api.moonshot.test/v1');
    state = step(state, {type: 'submit'});
    state = typeText(state, 'super-secret');
    state = step(state, {type: 'submit'});
    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('manual_model_id');

    state = typeText(state, 'moonshot-v1');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('model_display_name');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('model_context_window');

    const save = transitionModelConfig(state, {type: 'submit'});
    expect(save.effect).toMatchObject({
      type: 'save',
      credential: {
        apiKey: 'super-secret',
      },
      config: {
        activeModelId: expect.any(String),
        providers: expect.arrayContaining([
          expect.objectContaining({name: 'Moonshot'}),
        ]),
        models: expect.arrayContaining([
          expect.objectContaining({
            modelId: 'moonshot-v1',
            displayName: 'moonshot-v1',
            contextWindow: 128_000,
          }),
        ]),
      },
    });
    expect(JSON.stringify(
      (save.effect as Extract<typeof save.effect, {type: 'save'}>).config,
    )).not.toContain('super-secret');
  });

  it('edits display name and context while rejecting context below 8000', () => {
    let state = step(createModelConfigState(config), {type: 'edit'});
    while (state.form.displayName.length > 0) state = step(state, {type: 'backspace'});
    state = typeText(state, 'DeepSeek V4 Pro');
    state = step(state, {type: 'submit'});
    expect(state.screen).toBe('edit_context_window');

    while (state.form.contextWindow.length > 0) state = step(state, {type: 'backspace'});
    state = typeText(state, '7999');
    state = step(state, {type: 'submit'});
    expect(state.error).toContain('8,000');

    while (state.form.contextWindow.length > 0) state = step(state, {type: 'backspace'});
    state = typeText(state, '256000');
    const save = transitionModelConfig(state, {type: 'submit'});
    expect(save.effect).toMatchObject({
      type: 'save',
      config: {
        models: expect.arrayContaining([
          expect.objectContaining({
            id: 'deepseek-chat',
            displayName: 'DeepSeek V4 Pro',
            contextWindow: 256_000,
          }),
        ]),
      },
    });
  });

  it('shows discovery errors without discarding provider fields', () => {
    let state = step(createModelConfigState(config), {type: 'add'});
    state = step(state, {type: 'move', delta: 1});
    state = step(state, {type: 'submit'});
    state = typeText(state, 'Moonshot');
    state = step(state, {type: 'submit'});
    state = typeText(state, 'https://api.moonshot.test/v1');
    state = step(state, {type: 'submit'});
    state = typeText(state, 'secret');
    state = step(state, {type: 'submit'});
    state = step(state, {type: 'submit'});

    state = step(state, {
      type: 'discovery_failed',
      message: '获取模型失败：HTTP 401。',
    });

    expect(state.screen).toBe('provider_actions');
    expect(state.error).toContain('HTTP 401');
    expect(state.form).toMatchObject({
      providerName: 'Moonshot',
      baseUrl: 'https://api.moonshot.test/v1',
      apiKey: 'secret',
    });
  });
});
