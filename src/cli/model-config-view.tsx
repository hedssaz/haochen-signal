import React from 'react';
import {Box, Text, useInput} from 'ink';
import {
  activeModelConfigProvider,
  orderedModels,
  type ModelConfigAction,
  type ModelConfigState,
} from './model-config.js';
import {providerApiKeyEnvironmentVariable} from '../config/credentials.js';

export interface ModelConfigViewProps {
  state: ModelConfigState;
  onAction: (action: ModelConfigAction) => void;
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

function InputLine(props: {
  label: string;
  value: string;
  hidden?: boolean;
}): React.JSX.Element {
  const rendered = props.hidden ? '•'.repeat([...props.value].length) : props.value;
  return <Text>
    <Text color="cyan">{props.label}</Text>
    <Text>{rendered}</Text>
  </Text>;
}

function ModelList(props: ModelConfigViewProps): React.JSX.Element {
  const {state} = props;
  const ordered = orderedModels(state.config);
  if (ordered.length === 0) {
    return <Box flexDirection="column">
      <Text dimColor>尚未添加模型。</Text>
      <Text color="cyan">A 添加供应商</Text>
      <Text dimColor>Esc 返回</Text>
    </Box>;
  }

  return <Box flexDirection="column">
    {state.config.providers.map(provider => {
      const models = ordered
        .map((model, index) => ({model, index}))
        .filter(item => item.model.providerId === provider.id);
      if (models.length === 0) return null;
      return <Box key={provider.id} flexDirection="column" marginBottom={1}>
        <Text bold>{provider.name}</Text>
        {models.map(({model, index}) => {
          const current = model.id === state.config.activeModelId;
          const selected = index === state.selectedModelIndex;
          return <Text
            key={model.id}
            color={selected ? 'cyan' : undefined}
          >
            {`${selected ? '›' : ' '} ${current ? '●' : '○'} ${model.displayName}  ${formatContextWindow(model.contextWindow)}${current ? '  当前' : ''}`}
          </Text>;
        })}
      </Box>;
    })}
    <Text color="cyan">A 添加模型  E 编辑  D 删除  Enter 切换</Text>
    <Text dimColor>↑/↓ 选择 · Esc 返回</Text>
  </Box>;
}

const providerActions = [
  '[ 获取模型 ]',
  '[ 手动添加 Model ID ]',
  '取消',
] as const;

function ProviderActions(props: ModelConfigViewProps): React.JSX.Element {
  const provider = activeModelConfigProvider(props.state);
  return <Box flexDirection="column">
    <Text dimColor>{`${props.state.form.providerName} · ${props.state.form.baseUrl}`}</Text>
    {provider === undefined ? null : <Text dimColor>
      {`环境变量：${providerApiKeyEnvironmentVariable(provider.id)}`}
    </Text>}
    {providerActions.map((action, index) => <Text
      key={action}
      color={index === props.state.selectedActionIndex ? 'cyan' : undefined}
    >
      {`${index === props.state.selectedActionIndex ? '›' : ' '} ${action}`}
    </Text>)}
    <Text dimColor>↑/↓ 选择 · Enter 继续 · Esc 返回</Text>
  </Box>;
}

const addActions = [
  '添加到当前供应商',
  '添加新供应商',
  '取消',
] as const;

function AddActions(props: ModelConfigViewProps): React.JSX.Element {
  const selected = orderedModels(props.state.config)[props.state.selectedModelIndex];
  const provider = selected === undefined
    ? undefined
    : props.state.config.providers.find(
      candidate => candidate.id === selected.providerId,
    );
  return <Box flexDirection="column">
    <Text bold>添加模型</Text>
    {addActions.map((action, index) => <Text
      key={action}
      color={index === props.state.selectedActionIndex ? 'cyan' : undefined}
    >
      {`${index === props.state.selectedActionIndex ? '›' : ' '} ${
        index === 0
          ? `添加到当前供应商（${provider?.name ?? '未知'}）`
          : action
      }`}
    </Text>)}
    <Text dimColor>↑/↓ 选择 · Enter 继续 · Esc 返回</Text>
  </Box>;
}

function DiscoveredModels(props: ModelConfigViewProps): React.JSX.Element {
  return <Box flexDirection="column">
    <Text color="cyan" bold>选择要添加的模型</Text>
    {props.state.discoveredModelIds.map((modelId, index) => <Text
      key={modelId}
      color={index === props.state.selectedDiscoveredIndex ? 'cyan' : undefined}
    >
      {`${index === props.state.selectedDiscoveredIndex ? '›' : ' '} ${modelId}`}
    </Text>)}
    <Text dimColor>Enter 添加  ↑↓ 选择  Esc 返回</Text>
  </Box>;
}

function ScreenContents(props: ModelConfigViewProps): React.JSX.Element {
  const {state} = props;
  switch (state.screen) {
    case 'list':
      return <ModelList {...props}/>;
    case 'add_actions':
      return <AddActions {...props}/>;
    case 'provider_name':
      return <Box flexDirection="column">
        <Text bold>添加供应商 · 1/3</Text>
        <InputLine label="供应商名称：" value={state.form.providerName}/>
        <Text dimColor>Enter 下一步 · Esc 取消</Text>
      </Box>;
    case 'provider_base_url':
      return <Box flexDirection="column">
        <Text bold>添加供应商 · 2/3</Text>
        <InputLine label="API 地址：" value={state.form.baseUrl}/>
        <Text dimColor>Enter 下一步 · Esc 返回</Text>
      </Box>;
    case 'provider_api_key':
      return <Box flexDirection="column">
        <Text bold>添加供应商 · 3/3</Text>
        <InputLine label="API Key：" value={state.form.apiKey} hidden/>
        <Text dimColor>Key 不会写入配置 · Enter 下一步 · Esc 返回</Text>
      </Box>;
    case 'provider_actions':
      return <ProviderActions {...props}/>;
    case 'discovering':
      return <Box flexDirection="column">
        <Text color="yellow">正在获取模型…</Text>
        <Text dimColor>Esc 取消并返回</Text>
      </Box>;
    case 'discovered_models':
      return <DiscoveredModels {...props}/>;
    case 'manual_model_id':
      return <Box flexDirection="column">
        <Text bold>手动添加模型</Text>
        <InputLine label="Model ID：" value={state.form.modelId}/>
        <Text dimColor>Enter 继续 · Esc 返回</Text>
      </Box>;
    case 'model_display_name':
      return <Box flexDirection="column">
        <Text bold>模型详情 · 1/2</Text>
        <Text dimColor>{`Model ID（只读）：${state.form.modelId}`}</Text>
        <InputLine label="显示名称：" value={state.form.displayName}/>
        <Text dimColor>Enter 下一步 · Esc 返回</Text>
      </Box>;
    case 'model_context_window':
      return <Box flexDirection="column">
        <Text bold>模型详情 · 2/2</Text>
        <Text dimColor>{`Model ID（只读）：${state.form.modelId}`}</Text>
        <InputLine label="最大上下文：" value={state.form.contextWindow}/>
        <Text dimColor>Enter 保存 · Esc 返回</Text>
      </Box>;
    case 'edit_display_name':
      return <Box flexDirection="column">
        <Text bold>编辑模型 · 1/2</Text>
        <Text dimColor>{`Model ID（只读）：${state.form.modelId}`}</Text>
        <InputLine label="显示名称：" value={state.form.displayName}/>
        <Text dimColor>Enter 下一步 · Esc 取消</Text>
      </Box>;
    case 'edit_context_window':
      return <Box flexDirection="column">
        <Text bold>编辑模型 · 2/2</Text>
        <InputLine label="最大上下文：" value={state.form.contextWindow}/>
        <Text dimColor>Enter 保存 · Esc 返回</Text>
      </Box>;
    case 'saving':
      return <Text color="yellow">正在保存模型配置…</Text>;
  }
}

function keyboardAction(
  state: ModelConfigState,
  input: string,
  key: {
    upArrow: boolean;
    downArrow: boolean;
    return: boolean;
    escape: boolean;
    backspace: boolean;
    delete: boolean;
    ctrl: boolean;
    meta: boolean;
  },
): ModelConfigAction | undefined {
  if (key.escape) {
    return {type: 'escape'};
  }
  if (key.upArrow) return {type: 'move', delta: -1};
  if (key.downArrow) return {type: 'move', delta: 1};
  if (key.return) return {type: 'submit'};
  if (key.backspace || key.delete) return {type: 'backspace'};
  if (state.screen === 'list') {
    switch (input.toLowerCase()) {
      case 'a': return {type: 'add'};
      case 'e': return {type: 'edit'};
      case 'd': return {type: 'delete'};
      default: return undefined;
    }
  }
  if (!key.ctrl && !key.meta && input.length > 0) {
    return {type: 'character', value: input};
  }
  return undefined;
}

export function ModelConfigView(props: ModelConfigViewProps): React.JSX.Element {
  useInput((input, key) => {
    const action = keyboardAction(props.state, input, key);
    if (action !== undefined) props.onAction(action);
  });

  return <Box
    borderStyle="round"
    borderColor="cyan"
    flexDirection="column"
    paddingX={1}
  >
    <Text color="cyan" bold>模型配置</Text>
    <ScreenContents {...props}/>
    {props.state.error === undefined
      ? null
      : <Text color="red">{props.state.error}</Text>}
  </Box>;
}
