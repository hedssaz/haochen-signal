import {
  parseConfig,
  type HaochenConfig,
  type ModelProfile,
  type ProviderProfile,
} from '../config/schema.js';

export type ModelConfigScreen =
  | 'list'
  | 'add_actions'
  | 'provider_name'
  | 'provider_base_url'
  | 'provider_api_key'
  | 'provider_actions'
  | 'discovering'
  | 'discovered_models'
  | 'manual_model_id'
  | 'model_display_name'
  | 'model_context_window'
  | 'edit_display_name'
  | 'edit_context_window'
  | 'saving';

export interface ModelConfigForm {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  displayName: string;
  contextWindow: string;
}

interface PendingSave {
  returnScreen: ModelConfigScreen;
  selectedModelId?: string;
}

export interface ModelConfigState {
  config: HaochenConfig;
  screen: ModelConfigScreen;
  selectedModelIndex: number;
  selectedActionIndex: number;
  targetProviderId?: string;
  discoveredModelIds: string[];
  discoveredContextWindows: Record<string, number>;
  selectedDiscoveredIndex: number;
  form: ModelConfigForm;
  error?: string;
  pendingSave?: PendingSave;
}

export interface ModelConfigCredential {
  providerId: string;
  apiKey: string;
}

export interface ModelConfigDiscoverRequest {
  provider: ProviderProfile;
  apiKey?: string;
  signal: AbortSignal;
}

export interface ModelConfigSaveRequest {
  config: HaochenConfig;
  credential?: ModelConfigCredential;
  signal: AbortSignal;
}

export interface ModelConfigController {
  discover: (
    request: ModelConfigDiscoverRequest,
  ) => Promise<{
    modelIds: readonly string[];
    contextWindows: Readonly<Record<string, number>>;
  }>;
  save: (request: ModelConfigSaveRequest) => Promise<void>;
  getCommittedConfig?: () => HaochenConfig | undefined;
}

export interface LatestModelConfigSaverOptions {
  persist: (request: ModelConfigSaveRequest) => Promise<void>;
  commit: (request: ModelConfigSaveRequest) => void;
}

export function createLatestModelConfigSaver(
  options: LatestModelConfigSaverOptions,
): ModelConfigController['save'] {
  let tail: Promise<void> = Promise.resolve();

  return (request) => {
    const operation = tail.then(async () => {
      request.signal.throwIfAborted();
      await options.persist(request);
      options.commit(request);
    });
    tail = operation.catch(() => undefined);
    return operation;
  };
}

export type ModelConfigEffect =
  | {type: 'close'}
  | {type: 'abort_active'}
  | {
    type: 'discover';
    provider: ProviderProfile;
    apiKey?: string;
  }
  | {type: 'cancel_discovery'}
  | {
    type: 'save';
    config: HaochenConfig;
    credential?: ModelConfigCredential;
  };

export interface ModelConfigTransition {
  state: ModelConfigState;
  effect?: ModelConfigEffect;
}

export type ModelConfigAction =
  | {type: 'move'; delta: -1 | 1}
  | {type: 'character'; value: string}
  | {type: 'backspace'}
  | {type: 'submit'}
  | {type: 'add'}
  | {type: 'edit'}
  | {type: 'delete'}
  | {type: 'abort'}
  | {type: 'escape'}
  | {
    type: 'discovery_succeeded';
    modelIds: readonly string[];
    contextWindows?: Readonly<Record<string, number>>;
  }
  | {type: 'discovery_failed'; message: string}
  | {type: 'save_succeeded'; config: HaochenConfig}
  | {type: 'reconcile_committed'; config: HaochenConfig; message?: string}
  | {type: 'save_failed'; message: string};

export type ModelConfigOperationStatus = 'idle' | 'discovering' | 'saving';

export class ModelConfigOperationController {
  private active?: {
    status: Exclude<ModelConfigOperationStatus, 'idle'>;
    controller: AbortController;
  };

  get status(): ModelConfigOperationStatus {
    return this.active?.status ?? 'idle';
  }

  begin(status: Exclude<ModelConfigOperationStatus, 'idle'>): AbortSignal {
    this.abort();
    const controller = new AbortController();
    this.active = {status, controller};
    return controller.signal;
  }

  abort(): Exclude<ModelConfigOperationStatus, 'idle'> | undefined {
    const active = this.active;
    if (active === undefined) return undefined;
    active.controller.abort(new DOMException('用户中止', 'AbortError'));
    return active.status;
  }

  isCurrent(signal: AbortSignal): boolean {
    return this.active?.controller.signal === signal;
  }

  complete(signal: AbortSignal): void {
    if (this.isCurrent(signal)) this.active = undefined;
  }

  clear(): void {
    this.active = undefined;
  }
}

const emptyForm = (): ModelConfigForm => ({
  providerName: '',
  baseUrl: '',
  apiKey: '',
  modelId: '',
  displayName: '',
  contextWindow: '128000',
});

export function orderedModels(
  config: Pick<HaochenConfig, 'providers' | 'models'>,
): ModelProfile[] {
  return config.providers.flatMap(provider => config.models.filter(
    model => model.providerId === provider.id,
  ));
}

function activeIndex(config: HaochenConfig): number {
  const models = orderedModels(config);
  if (models.length === 0) return -1;
  const index = models.findIndex(model => model.id === config.activeModelId);
  return index < 0 ? 0 : index;
}

export function createModelConfigState(config: HaochenConfig): ModelConfigState {
  const parsed = parseConfig(config);
  return {
    config: parsed,
    screen: 'list',
    selectedModelIndex: activeIndex(parsed),
    selectedActionIndex: 0,
    discoveredModelIds: [],
    discoveredContextWindows: {},
    selectedDiscoveredIndex: 0,
    form: emptyForm(),
  };
}

function wrap(index: number, delta: number, length: number): number {
  if (length === 0) return -1;
  return (index + delta + length) % length;
}

function selectedModel(state: ModelConfigState): ModelProfile | undefined {
  return orderedModels(state.config)[state.selectedModelIndex];
}

function selectedProvider(state: ModelConfigState): ProviderProfile | undefined {
  const model = selectedModel(state);
  return model === undefined
    ? undefined
    : state.config.providers.find(provider => provider.id === model.providerId);
}

function withError(state: ModelConfigState, error: string): ModelConfigTransition {
  return {state: {...state, error}};
}

function withoutError(state: ModelConfigState): ModelConfigState {
  if (state.error === undefined) return state;
  const {error: _error, ...next} = state;
  return next;
}

function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      return undefined;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

function profileSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'custom' : slug;
}

function uniqueId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function pendingSave(
  state: ModelConfigState,
  config: HaochenConfig,
  options: {
    returnScreen: ModelConfigScreen;
    selectedModelId?: string;
    credential?: ModelConfigCredential;
  },
): ModelConfigTransition {
  return {
    state: {
      ...withoutError(state),
      screen: 'saving',
      pendingSave: {
        returnScreen: options.returnScreen,
        selectedModelId: options.selectedModelId,
      },
    },
    effect: {
      type: 'save',
      config: parseConfig(config),
      credential: options.credential,
    },
  };
}

function buildProvider(state: ModelConfigState): ProviderProfile {
  const providerIds = new Set(state.config.providers.map(provider => provider.id));
  const id = uniqueId(`provider-${profileSlug(state.form.providerName)}`, providerIds);
  return {
    id,
    name: state.form.providerName,
    baseUrl: state.form.baseUrl,
    credentialRef: id,
    headers: {},
  };
}

export function activeModelConfigProvider(
  state: ModelConfigState,
): ProviderProfile | undefined {
  if (state.targetProviderId !== undefined) {
    return state.config.providers.find(
      provider => provider.id === state.targetProviderId,
    );
  }
  if (state.form.providerName.trim().length === 0) return undefined;
  return buildProvider(state);
}

function buildAddedConfig(
  state: ModelConfigState,
): {
  config: HaochenConfig;
  provider: ProviderProfile;
  model: ModelProfile;
} {
  const existingProvider = state.targetProviderId === undefined
    ? undefined
    : state.config.providers.find(
      provider => provider.id === state.targetProviderId,
    );
  const provider = existingProvider ?? buildProvider(state);
  const modelIds = new Set(state.config.models.map(model => model.id));
  const model: ModelProfile = {
    id: uniqueId(
      `model-${profileSlug(provider.name)}-${profileSlug(state.form.modelId)}`,
      modelIds,
    ),
    providerId: provider.id,
    modelId: state.form.modelId,
    displayName: state.form.displayName,
    contextWindow: Number(state.form.contextWindow),
  };
  return {
    provider,
    model,
    config: parseConfig({
      ...state.config,
      providers: existingProvider === undefined
        ? [...state.config.providers, provider]
        : state.config.providers,
      models: [...state.config.models, model],
      activeModelId: model.id,
    }),
  };
}

function editableField(
  state: ModelConfigState,
): keyof ModelConfigForm | undefined {
  switch (state.screen) {
    case 'provider_name': return 'providerName';
    case 'provider_base_url': return 'baseUrl';
    case 'provider_api_key': return 'apiKey';
    case 'manual_model_id': return 'modelId';
    case 'model_display_name':
    case 'edit_display_name':
      return 'displayName';
    case 'model_context_window':
    case 'edit_context_window':
      return 'contextWindow';
    default:
      return undefined;
  }
}

function changeInput(
  state: ModelConfigState,
  transform: (current: string, field: keyof ModelConfigForm) => string,
): ModelConfigTransition {
  const field = editableField(state);
  if (field === undefined) return {state};
  const value = transform(state.form[field], field);
  if (
    (field === 'contextWindow')
    && value.length > 0
    && !/^\d+$/.test(value)
  ) {
    return {state};
  }
  return {
    state: {
      ...withoutError(state),
      form: {...state.form, [field]: value},
    },
  };
}

function transitionMove(
  state: ModelConfigState,
  delta: -1 | 1,
): ModelConfigTransition {
  switch (state.screen) {
    case 'add_actions':
      return {
        state: {
          ...withoutError(state),
          selectedActionIndex: wrap(state.selectedActionIndex, delta, 3),
        },
      };
    case 'list': {
      const models = orderedModels(state.config);
      return {
        state: {
          ...state,
          selectedModelIndex: wrap(
            state.selectedModelIndex,
            delta,
            models.length,
          ),
        },
      };
    }
    case 'provider_actions':
      return {
        state: {
          ...withoutError(state),
          selectedActionIndex: wrap(state.selectedActionIndex, delta, 3),
        },
      };
    case 'discovered_models':
      return {
        state: {
          ...state,
          selectedDiscoveredIndex: wrap(
            state.selectedDiscoveredIndex,
            delta,
            state.discoveredModelIds.length,
          ),
        },
      };
    default:
      return {state};
  }
}

function submitList(state: ModelConfigState): ModelConfigTransition {
  const model = selectedModel(state);
  if (model === undefined || model.id === state.config.activeModelId) return {state};
  return pendingSave(
    state,
    {...state.config, activeModelId: model.id},
    {returnScreen: 'list', selectedModelId: model.id},
  );
}

function submitProviderName(state: ModelConfigState): ModelConfigTransition {
  const providerName = state.form.providerName.trim();
  if (providerName.length === 0) return withError(state, '供应商名称不能为空。');
  return {
    state: {
      ...withoutError(state),
      screen: 'provider_base_url',
      form: {...state.form, providerName},
    },
  };
}

function submitBaseUrl(state: ModelConfigState): ModelConfigTransition {
  const baseUrl = normalizeBaseUrl(state.form.baseUrl);
  if (baseUrl === undefined) {
    return withError(
      state,
      'API 地址必须是没有凭据、查询参数或片段的 HTTP(S) 地址。',
    );
  }
  return {
    state: {
      ...withoutError(state),
      screen: 'provider_api_key',
      form: {...state.form, baseUrl},
    },
  };
}

function submitApiKey(state: ModelConfigState): ModelConfigTransition {
  const apiKey = state.form.apiKey.trim();
  if (apiKey.length === 0) return withError(state, 'API Key 不能为空。');
  return {
    state: {
      ...withoutError(state),
      screen: 'provider_actions',
      selectedActionIndex: 0,
      form: {...state.form, apiKey},
    },
  };
}

function submitProviderAction(state: ModelConfigState): ModelConfigTransition {
  if (state.selectedActionIndex === 2) {
    return {
      state: {
        ...createModelConfigState(state.config),
        selectedModelIndex: state.selectedModelIndex,
      },
    };
  }
  if (state.selectedActionIndex === 1) {
    return {
      state: {
        ...withoutError(state),
        screen: 'manual_model_id',
        form: {
          ...state.form,
          modelId: '',
          displayName: '',
          contextWindow: '128000',
        },
      },
    };
  }
  return {
    state: {
      ...withoutError(state),
      screen: 'discovering',
    },
    effect: {
      type: 'discover',
      provider: activeModelConfigProvider(state) ?? buildProvider(state),
      ...(state.form.apiKey.length === 0 ? {} : {apiKey: state.form.apiKey}),
    },
  };
}

function submitAddAction(state: ModelConfigState): ModelConfigTransition {
  if (state.selectedActionIndex === 2) {
    return {
      state: {
        ...createModelConfigState(state.config),
        selectedModelIndex: state.selectedModelIndex,
      },
    };
  }
  if (state.selectedActionIndex === 1) {
    return {
      state: {
        ...state,
        screen: 'provider_name',
        targetProviderId: undefined,
        selectedActionIndex: 0,
        form: emptyForm(),
        error: undefined,
      },
    };
  }
  const provider = selectedProvider(state);
  if (provider === undefined) {
    return {
      state: {
        ...state,
        screen: 'provider_name',
        targetProviderId: undefined,
        selectedActionIndex: 0,
        form: emptyForm(),
        error: undefined,
      },
    };
  }
  return {
    state: {
      ...withoutError(state),
      screen: 'provider_actions',
      targetProviderId: provider.id,
      selectedActionIndex: 0,
      form: {
        ...emptyForm(),
        providerName: provider.name,
        baseUrl: provider.baseUrl,
      },
    },
  };
}

function beginModelDetails(
  state: ModelConfigState,
  modelId: string,
  contextWindow = 128_000,
): ModelConfigTransition {
  const trimmedModelId = modelId.trim();
  if (trimmedModelId.length === 0) return withError(state, 'Model ID 不能为空。');
  return {
    state: {
      ...withoutError(state),
      screen: 'model_display_name',
      form: {
        ...state.form,
        modelId: trimmedModelId,
        displayName: trimmedModelId,
        contextWindow: String(contextWindow),
      },
    },
  };
}

function validDisplayName(state: ModelConfigState): string | undefined {
  const displayName = state.form.displayName.trim();
  return displayName.length === 0 ? undefined : displayName;
}

function validContextWindow(state: ModelConfigState): number | undefined {
  const contextWindow = Number(state.form.contextWindow);
  if (
    !Number.isInteger(contextWindow)
    || contextWindow < 8_000
  ) {
    return undefined;
  }
  return contextWindow;
}

function submitModelDetails(state: ModelConfigState): ModelConfigTransition {
  const contextWindow = validContextWindow(state);
  if (contextWindow === undefined) {
    return withError(state, '最大上下文必须是至少 8,000 的整数。');
  }
  const prepared = {
    ...state,
    form: {...state.form, contextWindow: String(contextWindow)},
  };
  const {config, provider, model} = buildAddedConfig(prepared);
  return pendingSave(prepared, config, {
    returnScreen: 'model_context_window',
    selectedModelId: model.id,
    credential: state.targetProviderId === undefined
      ? {
          providerId: provider.id,
          apiKey: state.form.apiKey,
        }
      : undefined,
  });
}

function submitEditContext(state: ModelConfigState): ModelConfigTransition {
  const model = selectedModel(state);
  if (model === undefined) return {state: {...state, screen: 'list'}};
  const contextWindow = validContextWindow(state);
  if (contextWindow === undefined) {
    return withError(state, '最大上下文必须是至少 8,000 的整数。');
  }
  const config = parseConfig({
    ...state.config,
    models: state.config.models.map(candidate => candidate.id === model.id
      ? {
        ...candidate,
        displayName: state.form.displayName,
        contextWindow,
      }
      : candidate),
  });
  return pendingSave(state, config, {
    returnScreen: 'edit_context_window',
    selectedModelId: model.id,
  });
}

function transitionSubmit(state: ModelConfigState): ModelConfigTransition {
  switch (state.screen) {
    case 'list':
      return submitList(state);
    case 'add_actions':
      return submitAddAction(state);
    case 'provider_name':
      return submitProviderName(state);
    case 'provider_base_url':
      return submitBaseUrl(state);
    case 'provider_api_key':
      return submitApiKey(state);
    case 'provider_actions':
      return submitProviderAction(state);
    case 'discovered_models': {
      const modelId = state.discoveredModelIds[state.selectedDiscoveredIndex];
      return modelId === undefined
        ? {state}
        : beginModelDetails(
          state,
          modelId,
          state.discoveredContextWindows[modelId],
        );
    }
    case 'manual_model_id':
      return beginModelDetails(state, state.form.modelId);
    case 'model_display_name': {
      const displayName = validDisplayName(state);
      if (displayName === undefined) return withError(state, '显示名称不能为空。');
      return {
        state: {
          ...withoutError(state),
          screen: 'model_context_window',
          form: {...state.form, displayName},
        },
      };
    }
    case 'model_context_window':
      return submitModelDetails(state);
    case 'edit_display_name': {
      const displayName = validDisplayName(state);
      if (displayName === undefined) return withError(state, '显示名称不能为空。');
      return {
        state: {
          ...withoutError(state),
          screen: 'edit_context_window',
          form: {...state.form, displayName},
        },
      };
    }
    case 'edit_context_window':
      return submitEditContext(state);
    default:
      return {state};
  }
}

function transitionAdd(state: ModelConfigState): ModelConfigTransition {
  if (state.screen !== 'list') return {state};
  const provider = selectedProvider(state);
  return {
    state: {
      ...state,
      screen: provider === undefined ? 'provider_name' : 'add_actions',
      selectedActionIndex: 0,
      targetProviderId: undefined,
      form: emptyForm(),
      error: undefined,
    },
  };
}

function transitionEdit(state: ModelConfigState): ModelConfigTransition {
  if (state.screen !== 'list') return {state};
  const model = selectedModel(state);
  if (model === undefined) return {state};
  return {
    state: {
      ...state,
      screen: 'edit_display_name',
      form: {
        ...emptyForm(),
        modelId: model.modelId,
        displayName: model.displayName,
        contextWindow: String(model.contextWindow),
      },
      error: undefined,
    },
  };
}

function transitionDelete(state: ModelConfigState): ModelConfigTransition {
  if (state.screen !== 'list') return {state};
  const model = selectedModel(state);
  if (model === undefined) return {state};
  const models = state.config.models.filter(candidate => candidate.id !== model.id);
  const providerStillUsed = models.some(candidate => candidate.providerId === model.providerId);
  const providers = providerStillUsed
    ? state.config.providers
    : state.config.providers.filter(provider => provider.id !== model.providerId);
  const config = parseConfig({
    ...state.config,
    providers,
    models,
    activeModelId: state.config.activeModelId === model.id
      ? undefined
      : state.config.activeModelId,
  });
  return pendingSave(state, config, {returnScreen: 'list'});
}

function transitionEscape(state: ModelConfigState): ModelConfigTransition {
  switch (state.screen) {
    case 'list':
      return {state, effect: {type: 'close'}};
    case 'add_actions':
      return {state: {...createModelConfigState(state.config), selectedModelIndex: state.selectedModelIndex}};
    case 'provider_name':
      return {state: {...createModelConfigState(state.config), selectedModelIndex: state.selectedModelIndex}};
    case 'provider_base_url':
      return {state: {...withoutError(state), screen: 'provider_name'}};
    case 'provider_api_key':
      return {state: {...withoutError(state), screen: 'provider_base_url'}};
    case 'provider_actions':
      return state.targetProviderId === undefined
        ? {state: {...withoutError(state), screen: 'provider_api_key'}}
        : {state: {...withoutError(state), screen: 'add_actions'}};
    case 'discovering':
      return {
        state: {...withoutError(state), screen: 'provider_actions'},
        effect: {type: 'cancel_discovery'},
      };
    case 'discovered_models':
    case 'manual_model_id':
      return {state: {...withoutError(state), screen: 'provider_actions'}};
    case 'model_display_name':
      return {state: {...withoutError(state), screen: 'provider_actions'}};
    case 'model_context_window':
      return {state: {...withoutError(state), screen: 'model_display_name'}};
    case 'edit_display_name':
      return {state: {...createModelConfigState(state.config), selectedModelIndex: state.selectedModelIndex}};
    case 'edit_context_window':
      return {state: {...withoutError(state), screen: 'edit_display_name'}};
    case 'saving':
      return {state};
  }
}

function transitionAbort(state: ModelConfigState): ModelConfigTransition {
  if (state.screen === 'discovering') {
    return {
      state: {...withoutError(state), screen: 'provider_actions'},
      effect: {type: 'abort_active'},
    };
  }
  if (state.screen === 'saving') {
    return {
      state: {
        ...withoutError(state),
        screen: state.pendingSave?.returnScreen ?? 'list',
        pendingSave: undefined,
      },
      effect: {type: 'abort_active'},
    };
  }
  return {state};
}

function transitionDiscoverySucceeded(
  state: ModelConfigState,
  modelIds: readonly string[],
  contextWindows: Readonly<Record<string, number>> = {},
): ModelConfigTransition {
  if (state.screen !== 'discovering') return {state};
  const normalized = [...new Set(
    modelIds.map(id => id.trim()).filter(id => id.length > 0),
  )].sort();
  if (normalized.length === 0) {
    return {
      state: {
        ...state,
        screen: 'provider_actions',
        error: '模型列表为空，请重试或手动添加 Model ID。',
      },
    };
  }
  const normalizedContextWindows: Record<string, number> = {};
  for (const modelId of normalized) {
    const contextWindow = contextWindows[modelId];
    if (
      contextWindow !== undefined
      && Number.isInteger(contextWindow)
      && contextWindow >= 8_000
    ) {
      normalizedContextWindows[modelId] = contextWindow;
    }
  }
  return {
    state: {
      ...withoutError(state),
      screen: 'discovered_models',
      discoveredModelIds: normalized,
      discoveredContextWindows: normalizedContextWindows,
      selectedDiscoveredIndex: 0,
    },
  };
}

function transitionSaveSucceeded(
  state: ModelConfigState,
  config: HaochenConfig,
): ModelConfigTransition {
  const parsed = parseConfig(config);
  const selectedId = state.pendingSave?.selectedModelId ?? parsed.activeModelId;
  const models = orderedModels(parsed);
  const selectedIndex = selectedId === undefined
    ? (models.length === 0 ? -1 : 0)
    : models.findIndex(model => model.id === selectedId);
  return {
    state: {
      ...createModelConfigState(parsed),
      selectedModelIndex: selectedIndex < 0
        ? (models.length === 0 ? -1 : 0)
        : selectedIndex,
    },
  };
}

export function transitionModelConfig(
  state: ModelConfigState,
  action: ModelConfigAction,
): ModelConfigTransition {
  switch (action.type) {
    case 'move':
      return transitionMove(state, action.delta);
    case 'character':
      return changeInput(state, current => `${current}${action.value}`);
    case 'backspace':
      return changeInput(state, current => [...current].slice(0, -1).join(''));
    case 'submit':
      return transitionSubmit(state);
    case 'add':
      return transitionAdd(state);
    case 'edit':
      return transitionEdit(state);
    case 'delete':
      return transitionDelete(state);
    case 'abort':
      return transitionAbort(state);
    case 'escape':
      return transitionEscape(state);
    case 'discovery_succeeded':
      return transitionDiscoverySucceeded(
        state,
        action.modelIds,
        action.contextWindows,
      );
    case 'discovery_failed':
      return state.screen !== 'discovering'
        ? {state}
        : {
          state: {
            ...state,
            screen: 'provider_actions',
            error: action.message,
          },
        };
    case 'save_succeeded':
      return transitionSaveSucceeded(state, action.config);
    case 'reconcile_committed': {
      const reconciled = transitionSaveSucceeded(
        {...state, pendingSave: undefined},
        action.config,
      );
      return action.message === undefined
        ? reconciled
        : {state: {...reconciled.state, error: action.message}};
    }
    case 'save_failed':
      return state.screen !== 'saving'
        ? {state}
        : {
          state: {
            ...state,
            screen: state.pendingSave?.returnScreen ?? 'list',
            pendingSave: undefined,
            error: action.message,
          },
        };
  }
}
