import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {parseSlashCommand} from './commands.js';
import {initialUiState, uiReducer, type AgentUiEvent, type UiEntry} from './reducer.js';
import type {ToolResult} from '../tools/types.js';
import type {ConfirmationBroker, PendingConfirmation} from './confirmation.js';

export interface SessionSummary {
  id: string;
  updatedAt?: number;
}

export interface CompactResult {
  ok: boolean;
  message: string;
}

export interface ResumeResult {
  id: string;
  message: string;
}

export interface AppProps<Event extends AgentUiEvent = AgentUiEvent> {
  runTask: (task: string, signal: AbortSignal) => AsyncIterable<Event>;
  workspace: string;
  sessionId: string;
  model: string;
  contextTokens?: number;
  sessionGrants?: number;
  executeTool?: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolResult>;
  compact?: () => Promise<CompactResult>;
  saveSession?: () => Promise<void>;
  appendInterrupted?: (reason: string) => Promise<void>;
  createSession?: () => Promise<string>;
  listSessions?: () => Promise<SessionSummary[]>;
  resumeSession?: (id: string) => Promise<ResumeResult>;
  onModelChange?: (model: string) => void;
  onExit?: () => Promise<void> | void;
  confirmation?: ConfirmationBroker;
}

const banner = [
  '╭─ 浩宸信号 · HAOCHEN SIGNAL ──────────────────╮',
  '│ 身份确认——浩宸代理，已进入信号场。            │',
  '╰───────────────────────────────────────────────╯',
].join('\n');

const helpText = [
  '内置命令：',
  '/help  帮助  /status  状态  /model [名称]  模型',
  '/diff  差异  /permissions  权限  /compact  压缩',
  '/clear  新会话  /resume [ID]  恢复  /exit  退出',
].join('\n');

function localEntry(prefix: UiEntry['prefix'], text: string): UiEntry {
  return {prefix, text};
}

export function App<Event extends AgentUiEvent = AgentUiEvent>(props: AppProps<Event>): React.JSX.Element {
  const {exit} = useApp();
  const [state, setState] = useState(initialUiState);
  const [model, setModel] = useState(props.model);
  const [sessionId, setSessionId] = useState(props.sessionId);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | undefined>(
    () => props.confirmation?.getPending(),
  );
  const inputRef = useRef('');
  const activeController = useRef<AbortController | undefined>(undefined);
  const abortRequested = useRef(false);
  const interruptedPersisted = useRef(false);
  const exiting = useRef(false);

  const dispatch = useCallback((event: Parameters<typeof uiReducer>[1]) => {
    setState(previous => uiReducer(previous, event));
  }, []);

  const appendNotice = useCallback((prefix: UiEntry['prefix'], text: string) => {
    dispatch({type: 'notice', entry: localEntry(prefix, text)});
  }, [dispatch]);

  useEffect(() => props.confirmation?.subscribe(() => {
    setPendingConfirmation(props.confirmation?.getPending());
  }), [props.confirmation]);

  const persistInterrupted = useCallback(async (reason: string) => {
    if (interruptedPersisted.current) return;
    interruptedPersisted.current = true;
    await props.appendInterrupted?.(reason);
  }, [props.appendInterrupted]);

  const leave = useCallback(async (interrupted = false) => {
    if (exiting.current) return;
    exiting.current = true;
    if (interrupted) {
      await persistInterrupted('用户中止');
      dispatch({type: 'interrupted', reason: '用户中止'});
    }
    try {
      props.confirmation?.close();
      await props.saveSession?.();
      await props.onExit?.();
    } finally {
      exit();
    }
  }, [dispatch, exit, persistInterrupted, props]);

  const runTask = useCallback(async (task: string) => {
    if (activeController.current !== undefined) {
      appendNotice('✗', '当前任务仍在运行，请先中止。');
      return;
    }
    const controller = new AbortController();
    activeController.current = controller;
    abortRequested.current = false;
    interruptedPersisted.current = false;
    dispatch({type: 'status', text: '正在理解任务'});
    try {
      for await (const event of props.runTask(task, controller.signal)) {
        if (event.type === 'interrupted') interruptedPersisted.current = true;
        dispatch(event);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        dispatch({type: 'interrupted', reason: '用户中止'});
      } else {
        dispatch({type: 'error', message: error instanceof Error ? error.message : '代理任务失败'});
      }
    } finally {
      if (activeController.current === controller) activeController.current = undefined;
      abortRequested.current = false;
      setState(previous => previous.phase === 'idle' || previous.phase === 'error'
        ? previous
        : {...previous, phase: 'idle', activeTool: undefined});
    }
  }, [appendNotice, dispatch, props]);

  const submitCommand = useCallback(async (input: string) => {
    const command = parseSlashCommand(input);
    if (command === undefined) {
      await runTask(input);
      return;
    }

    switch (command.name) {
      case 'help':
        appendNotice('◆', helpText);
        return;
      case 'status':
        appendNotice('◆', [
          `模型：${model}`,
          `工作区：${props.workspace}`,
          `会话：${sessionId}`,
          `上下文估算：${props.contextTokens ?? 0} tokens`,
          `当前阶段：${state.phase}`,
        ].join('\n'));
        return;
      case 'model': {
        const nextModel = command.args.join(' ').trim();
        if (nextModel.length === 0) {
          appendNotice('◆', `当前模型：${model}`);
          return;
        }
        setModel(nextModel);
        props.onModelChange?.(nextModel);
        appendNotice('◆', `当前会话模型已切换为：${nextModel}`);
        return;
      }
      case 'diff': {
        if (props.executeTool === undefined) {
          appendNotice('✗', '当前未配置只读 Git 差异工具。');
          return;
        }
        const controller = new AbortController();
        dispatch({type: 'tool_started', name: 'git_diff', input: {}});
        try {
          dispatch({type: 'tool_finished', name: 'git_diff', result: await props.executeTool('git_diff', {}, controller.signal)});
        } catch (error) {
          dispatch({type: 'error', message: error instanceof Error ? error.message : '读取 Git 差异失败'});
        }
        return;
      }
      case 'permissions':
        appendNotice('◉', `固定规则：越界与非公开网络直接拒绝；受限操作必须确认。\n本次会话许可：${props.sessionGrants ?? 0} 项`);
        return;
      case 'compact': {
        if (props.compact === undefined) {
          appendNotice('✗', '当前无法压缩历史。');
          return;
        }
        const result = await props.compact();
        appendNotice(result.ok ? '✓' : '✗', result.message);
        return;
      }
      case 'clear': {
        await props.saveSession?.();
        const id = await props.createSession?.();
        if (id !== undefined) setSessionId(id);
        setState({...initialUiState, transcript: [localEntry('✓', `已创建新会话${id === undefined ? '' : `：${id}`}`)]});
        return;
      }
      case 'resume': {
        if (command.args.length === 0) {
          const sessions = await props.listSessions?.() ?? [];
          appendNotice('◆', sessions.length === 0
            ? '没有可恢复的历史会话。'
            : `最近会话：\n${sessions.slice(0, 10).map(item => item.id).join('\n')}`);
          return;
        }
        if (props.resumeSession === undefined) {
          appendNotice('✗', '当前无法恢复历史会话。');
          return;
        }
        const restored = await props.resumeSession(command.args[0]!);
        setSessionId(restored.id);
        appendNotice('✓', restored.message);
        return;
      }
      case 'exit':
        await leave();
        return;
      case 'unknown':
        appendNotice('✗', `未知命令：${command.raw}`);
        return;
    }
  }, [appendNotice, dispatch, leave, model, props, runTask, sessionId, state.phase]);

  useInput((input, key) => {
    if (pendingConfirmation !== undefined) {
      if (input === 'a') props.confirmation?.respond('allow_once');
      else if (input === 's') props.confirmation?.respond('allow_session');
      else if (input === 'd' || key.escape) props.confirmation?.respond('deny');
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      const controller = activeController.current;
      if (controller === undefined) {
        void leave();
      } else if (abortRequested.current) {
        void leave(true);
      } else {
        abortRequested.current = true;
        controller.abort(new DOMException('用户中止', 'AbortError'));
        appendNotice('✗', '正在中止当前任务。再次 Ctrl+C 将直接退出。');
      }
      return;
    }
    if (key.return) {
      const text = inputRef.current.trim();
      inputRef.current = '';
      dispatch({type: 'input', input: ''});
      if (text.length > 0) void submitCommand(text);
      return;
    }
    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      dispatch({type: 'input', input: inputRef.current});
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      inputRef.current += input;
      dispatch({type: 'input', input: inputRef.current});
    }
  });

  return <Box flexDirection="column">
    <Text>{banner}</Text>
    <Box flexDirection="column" marginTop={1}>
      {state.transcript.map((item, index) => <Text key={`${index}-${item.text}`}>{`${item.prefix} ${item.text}`}</Text>)}
    </Box>
    {pendingConfirmation === undefined ? null : <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">◉ 确认请求 · {pendingConfirmation.operation.tool}</Text>
      <Text>{`风险：${pendingConfirmation.boundary.risk}\n范围：${pendingConfirmation.boundary.normalizedScope.join(', ')}\n${pendingConfirmation.boundary.reasons.join('；')}`}</Text>
      <Text color="yellow">a 仅本次允许 · s 本会话允许 · d 拒绝</Text>
    </Box>}
    <Box marginTop={1}>
      <Text color="cyan">浩宸 › </Text><Text>{state.input}</Text>
    </Box>
  </Box>;
}
