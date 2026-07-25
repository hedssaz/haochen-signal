import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {parseSlashCommand, suggestSlashCommands} from './commands.js';
import {initialUiState, uiReducer, type AgentUiEvent, type UiEntry} from './reducer.js';
import type {ToolResult} from '../tools/types.js';
import type {ConfirmationBroker, PendingConfirmation} from './confirmation.js';
import {
  createResumePicker,
  moveResumeSelection,
  visibleResumeItems,
  type ResumePickerState,
} from './resume-picker.js';
import type {GateReporter} from './gate-reporter.js';

export interface SessionSummary {
  id: string;
  updatedAt: number;
  preview: string;
  workspaceId?: string;
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
  workspaceId?: string;
  sessionId: string;
  model: string;
  contextTokens?: number;
  sessionGrants?: ReadonlySet<string>;
  executeTool?: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolResult>;
  compact?: () => Promise<CompactResult>;
  saveSession?: (reason: 'clear' | 'exit') => Promise<void>;
  appendInterrupted?: (reason: string) => Promise<void>;
  createSession?: () => Promise<string>;
  listSessions?: () => Promise<SessionSummary[]>;
  resumeSession?: (id: string) => Promise<ResumeResult>;
  onModelChange?: (model: string) => void;
  onExit?: () => Promise<void> | void;
  confirmation?: ConfirmationBroker;
  gateReporter?: GateReporter;
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

type LocalNoticePrefix = '◆' | '◇' | '◉' | '✓' | '✗' | '浩宸 ›';

function localEntry(prefix: LocalNoticePrefix, text: string): UiEntry {
  if (prefix === '浩宸 ›') return {kind: 'user', title: '你', text};
  if (prefix === '◉') return {kind: 'review', title: '审查', text};
  if (prefix === '✗') return {kind: 'error', title: '错误', text};
  if (prefix === '✓') return {kind: 'success', title: '完成', text};
  return {kind: 'status', title: '状态', text};
}

function entryLabel(item: UiEntry): string {
  switch (item.kind) {
    case 'user': return '你 ›';
    case 'assistant': return '浩宸 ›';
    case 'tool': return `工具 › ${item.title}`;
    case 'result': return `结果 › ${item.title}`;
    case 'approval': return `审批 › ${item.title}`;
    case 'review': return `审查 › ${item.title}`;
    case 'error': return `错误 › ${item.title}`;
    case 'success': return `完成 › ${item.title}`;
    case 'status': return `状态 › ${item.title}`;
  }
}

function entryColor(kind: UiEntry['kind']): 'cyan' | 'white' | 'magenta' | 'green' | 'yellow' | 'red' | 'gray' {
  switch (kind) {
    case 'user': return 'cyan';
    case 'assistant': return 'white';
    case 'tool': return 'magenta';
    case 'result':
    case 'success': return 'green';
    case 'approval':
    case 'review': return 'yellow';
    case 'error': return 'red';
    case 'status': return 'gray';
  }
}

export function App<Event extends AgentUiEvent = AgentUiEvent>(props: AppProps<Event>): React.JSX.Element {
  const {exit} = useApp();
  const [state, setState] = useState(initialUiState);
  const [model, setModel] = useState(props.model);
  const [sessionId, setSessionId] = useState(props.sessionId);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | undefined>(
    () => props.confirmation?.getPending(),
  );
  const [resumePicker, setResumePicker] = useState<ResumePickerState | undefined>();
  const [runtimeStatus, setRuntimeStatus] = useState<string | undefined>();
  const resumePickerRef = useRef<ResumePickerState | undefined>(undefined);
  const inputRef = useRef('');
  const activeController = useRef<AbortController | undefined>(undefined);
  const abortRequested = useRef(false);
  const interruptedPersisted = useRef(false);
  const exiting = useRef(false);

  const dispatch = useCallback((event: Parameters<typeof uiReducer>[1]) => {
    setState(previous => uiReducer(previous, event));
  }, []);

  const appendNotice = useCallback((prefix: LocalNoticePrefix, text: string) => {
    dispatch({type: 'notice', entry: localEntry(prefix, text)});
  }, [dispatch]);

  useEffect(() => props.confirmation?.subscribe(() => {
    setPendingConfirmation(props.confirmation?.getPending());
  }), [props.confirmation]);

  useEffect(() => props.gateReporter?.subscribe(event => {
    if (event.type === 'review_started') {
      if (activeController.current !== undefined) {
        setRuntimeStatus(`AI 自动审查 ${event.tool}`);
      }
      return;
    }
    if (event.type === 'classified' && event.action === 'confirm') {
      if (activeController.current !== undefined) {
        setRuntimeStatus(`等待确认 ${event.tool}`);
      }
      return;
    }
    if (event.type === 'gate_finished') {
      dispatch({
        type: 'notice',
        entry: {
          kind: 'approval',
          title: event.tool,
          text: event.summary,
        },
      });
      if (activeController.current !== undefined) {
        setRuntimeStatus(event.outcome === 'execute'
          ? `正在执行 ${event.tool}`
          : `审批拒绝 ${event.tool}`);
      }
    }
  }), [dispatch, props.gateReporter]);

  const persistInterrupted = useCallback(async (reason: string) => {
    if (interruptedPersisted.current) return;
    interruptedPersisted.current = true;
    await props.appendInterrupted?.(reason);
  }, [props.appendInterrupted]);

  const leave = useCallback(async (interrupted = false) => {
    if (exiting.current) return;
    exiting.current = true;
    try {
      if (interrupted) {
        await persistInterrupted('用户中止');
        dispatch({type: 'interrupted', reason: '用户中止'});
      }
      props.confirmation?.close();
      await props.saveSession?.('exit');
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
    setRuntimeStatus('正在理解任务');
    try {
      for await (const event of props.runTask(task, controller.signal)) {
        if (event.type === 'interrupted') interruptedPersisted.current = true;
        if (event.type === 'assistant_delta' || event.type === 'assistant_message') {
          setRuntimeStatus('正在规划');
        } else if (event.type === 'tool_started') {
          setRuntimeStatus(`正在调用 ${event.name}`);
        } else if (event.type === 'tool_finished') {
          setRuntimeStatus('正在整理结果');
        } else if (event.type === 'review') {
          setRuntimeStatus('正在审查操作');
        } else if (event.type === 'status') {
          setRuntimeStatus(event.text);
        }
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
      setRuntimeStatus(undefined);
      abortRequested.current = false;
      setState(previous => previous.phase === 'idle' || previous.phase === 'error'
        ? previous
        : {...previous, phase: 'idle', activeTool: undefined});
    }
  }, [appendNotice, dispatch, props]);

  const submitCommand = useCallback(async (input: string) => {
    appendNotice('浩宸 ›', input);
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
        appendNotice('◉', `固定规则：越界与非公开网络直接拒绝；受限操作必须确认。\n本次会话许可：${props.sessionGrants?.size ?? 0} 项`);
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
        await props.saveSession?.('clear');
        const id = await props.createSession?.();
        if (id !== undefined) setSessionId(id);
        setState({...initialUiState, transcript: [localEntry('✓', `已创建新会话${id === undefined ? '' : `：${id}`}`)]});
        return;
      }
      case 'resume': {
        if (command.args.length === 0) {
          const sessions = await props.listSessions?.() ?? [];
          const picker = createResumePicker(sessions, props.workspaceId ?? '');
          if (picker.items.length === 0) {
            appendNotice('◆', '当前工作区没有可恢复的会话。');
          } else {
            resumePickerRef.current = picker;
            setResumePicker(picker);
          }
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
    if (key.ctrl && input.toLowerCase() === 'c') {
      const controller = activeController.current;
      if (controller === undefined) {
        void leave();
      } else if (abortRequested.current) {
        void leave(true);
      } else {
        abortRequested.current = true;
        props.confirmation?.respond('deny');
        controller.abort(new DOMException('用户中止', 'AbortError'));
        appendNotice('✗', '正在中止当前任务。再次 Ctrl+C 将直接退出。');
      }
      return;
    }
    if (pendingConfirmation !== undefined) {
      if (input === 'a') props.confirmation?.respond('allow_once');
      else if (input === 's') props.confirmation?.respond('allow_session');
      else if (input === 'd' || key.escape) props.confirmation?.respond('deny');
      return;
    }
    if (resumePicker !== undefined) {
      if (key.escape) {
        resumePickerRef.current = undefined;
        setResumePicker(undefined);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const currentPicker = resumePickerRef.current ?? resumePicker;
        const next = moveResumeSelection(
          currentPicker,
          key.upArrow ? -1 : 1,
          8,
        );
        resumePickerRef.current = next;
        setResumePicker(next);
        return;
      }
      if (key.return) {
        const currentPicker = resumePickerRef.current ?? resumePicker;
        const selected = currentPicker.items[currentPicker.selectedIndex]?.session;
        if (selected !== undefined && props.resumeSession !== undefined) {
          void (async () => {
            try {
              const restored = await props.resumeSession!(selected.id);
              setSessionId(restored.id);
              resumePickerRef.current = undefined;
              setResumePicker(undefined);
              appendNotice('✓', restored.message);
            } catch (error) {
              appendNotice('✗', error instanceof Error ? error.message : '恢复会话失败');
            }
          })();
        }
        return;
      }
      return;
    }
    if (activeController.current !== undefined) {
      return;
    }
    if (key.tab) {
      const suggestion = suggestSlashCommands(inputRef.current)[0];
      if (suggestion !== undefined) {
        inputRef.current = `/${suggestion.name}`;
        dispatch({type: 'input', input: inputRef.current});
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

  const commandSuggestions = suggestSlashCommands(state.input);
  const resumeItems = resumePicker === undefined
    ? []
    : visibleResumeItems(resumePicker, 8);

  return <Box flexDirection="column">
    <Text>{banner}</Text>
    <Box flexDirection="column" marginTop={1}>
      {state.transcript.map((item, index) => <Box
        key={`${index}-${item.text}`}
        flexDirection="column"
        marginBottom={1}
      >
        <Text color={entryColor(item.kind)} bold>{entryLabel(item)}</Text>
        <Text>{item.text}</Text>
        {item.detail === undefined ? null : <Text dimColor>{`参数  ${item.detail}`}</Text>}
      </Box>)}
    </Box>
    {pendingConfirmation === undefined ? null : <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">◉ 确认请求 · {pendingConfirmation.operation.tool}</Text>
      <Text>{`风险：${pendingConfirmation.boundary.risk}\n范围：${pendingConfirmation.boundary.normalizedScope.join(', ')}\n${pendingConfirmation.boundary.reasons.join('；')}`}</Text>
      <Text color="yellow">a 仅本次允许 · s 本会话允许 · d 拒绝</Text>
    </Box>}
    {resumePicker === undefined ? null : <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text color="cyan">恢复对话 · 当前工作区</Text>
      {resumeItems.map((item, visibleIndex) => {
        const index = resumePicker.windowStart + visibleIndex;
        const previous = resumeItems[visibleIndex - 1];
        const showGroup = previous === undefined || previous.group !== item.group;
        const date = item.session.updatedAt <= 0
          ? '-- --'
          : new Date(item.session.updatedAt).toISOString().slice(5, 16).replace('T', ' ');
        return <React.Fragment key={item.session.id}>
          {showGroup ? <Text dimColor>
            {item.group === 'current' ? '当前工作区' : '工作区未知'}
          </Text> : null}
          <Text color={index === resumePicker.selectedIndex ? 'cyan' : undefined}>
            {`${index === resumePicker.selectedIndex ? '›' : ' '} ${date}  ${item.session.preview} · ${item.session.id.slice(0, 8)}`}
          </Text>
        </React.Fragment>;
      })}
      <Text dimColor>↑/↓ 选择 · Enter 恢复 · Esc 取消</Text>
    </Box>}
    {runtimeStatus === undefined ? null : <Text color="yellow">
      {`状态 › 运行中 · ${runtimeStatus} · Ctrl+C 中止`}
    </Text>}
    {runtimeStatus === undefined ? <Box marginTop={1}>
      <Text color="cyan">浩宸 › </Text><Text>{state.input}</Text>
    </Box> : <Box marginTop={1}>
      <Text color="yellow">输入已锁定 · 等待任务完成，Ctrl+C 中止</Text>
    </Box>}
    {runtimeStatus !== undefined || commandSuggestions.length === 0 ? null : <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text color="cyan">斜杠命令 · Tab 补全</Text>
      {commandSuggestions.map(command => <Text key={command.name}>
        <Text color="cyan">{command.usage.padEnd(20)}</Text>
        <Text dimColor>{command.description}</Text>
      </Text>)}
    </Box>}
  </Box>;
}
