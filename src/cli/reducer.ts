import type {ReviewDecision} from '../security/reviewer.js';
import type {ToolResult} from '../tools/types.js';
import {summarizeToolInput} from './tool-summary.js';

export type UiPhase =
  | 'idle'
  | 'thinking'
  | 'running_tool'
  | 'reviewing'
  | 'confirming'
  | 'error';

export type UiEntryKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'result'
  | 'approval'
  | 'status'
  | 'review'
  | 'error'
  | 'success';

export interface UiEntry {
  kind: UiEntryKind;
  title: string;
  text: string;
  detail?: string;
}

export interface UiState {
  phase: UiPhase;
  input: string;
  transcript: UiEntry[];
  liveReasoning: string;
  liveAssistant: string;
  activeTool?: {name: string; summary: string};
  error?: string;
}

/**
 * The agent loop is intentionally injected structurally. This keeps the UI
 * independently testable while the loop module is integrated at the entrypoint.
 */
export type AgentUiEvent =
  | {type: 'status'; text: string}
  | {type: 'reasoning_delta'; text: string}
  | {type: 'assistant_delta'; text: string}
  | {type: 'assistant_turn_finished'}
  | {type: 'assistant_message'; text: string}
  | {type: 'assistant_text'; text: string}
  | {type: 'tool_started'; name: string; input: unknown}
  | {type: 'tool_finished'; name: string; result: ToolResult}
  | {type: 'review'; decision: ReviewDecision}
  | {type: 'limit_reached'; limit: 'turns' | 'tools'}
  | {type: 'interrupted'; reason: string}
  | {type: 'error'; message: string};

export type UiEvent = AgentUiEvent
  | {type: 'input'; input: string}
  | {type: 'notice'; entry: UiEntry; phase?: UiPhase};

export const initialUiState: UiState = {
  phase: 'idle',
  input: '',
  transcript: [],
  liveReasoning: '',
  liveAssistant: '',
};

const toolSummary: Record<string, string> = {
  list_files: '扫描信号',
  search_text: '扫描信号',
  read_file: '读取碎片',
  apply_patch: '修改节点',
  run_command: '执行验证',
  git_status: '读取 Git 状态',
  git_diff: '读取 Git 差异',
  git_log: '读取 Git 记录',
  web_search: '搜索公开资料',
  web_fetch: '读取公开资料',
};

function entry(
  kind: UiEntryKind,
  title: string,
  text: string,
  detail?: string,
): UiEntry {
  return {kind, title, text, ...(detail === undefined ? {} : {detail})};
}

function append(state: UiState, value: UiEntry, overrides: Partial<UiState> = {}): UiState {
  return {...state, ...overrides, transcript: [...state.transcript, value]};
}

function describeTool(name: string): string {
  return toolSummary[name] ?? `执行工具 ${name}`;
}

function failureDetails(result: ToolResult): string {
  const data = result.data;
  if (data === null || typeof data !== 'object') return result.error?.message ?? result.summary;
  const record = data as Record<string, unknown>;
  const exitCode = typeof record.exitCode === 'number' ? `退出码 ${record.exitCode}` : undefined;
  const stderr = typeof record.stderr === 'string' && record.stderr.trim()
    ? record.stderr.trim().slice(0, 600)
    : undefined;
  return [result.summary, exitCode, stderr, result.error?.message]
    .filter((value, index, values): value is string => typeof value === 'string'
      && value.length > 0
      && values.indexOf(value) === index)
    .join('\n');
}

export function uiReducer(state: UiState, event: UiEvent): UiState {
  if (event.type === 'input') return {...state, input: event.input};
  if (event.type === 'notice') {
    return append(state, event.entry, event.phase === undefined ? {} : {phase: event.phase});
  }

  switch (event.type) {
    case 'status':
      return {...state, phase: 'thinking', error: undefined};
    case 'reasoning_delta':
      return {
        ...state,
        phase: 'thinking',
        error: undefined,
        liveReasoning: state.liveReasoning + event.text,
      };
    case 'assistant_delta':
      return {
        ...state,
        phase: 'thinking',
        error: undefined,
        liveAssistant: state.liveAssistant + event.text,
      };
    case 'assistant_turn_finished':
      return {...state, liveReasoning: '', liveAssistant: ''};
    case 'assistant_message':
      return append(state, entry('assistant', '浩宸', event.text), {
        phase: 'thinking',
        error: undefined,
        liveReasoning: '',
        liveAssistant: '',
      });
    case 'assistant_text':
      return append(state, entry('assistant', '浩宸', event.text), {
        phase: 'idle',
        activeTool: undefined,
        error: undefined,
        liveReasoning: '',
        liveAssistant: '',
      });
    case 'tool_started': {
      const summary = describeTool(event.name);
      return append(state, entry(
        'tool',
        event.name,
        summary,
        summarizeToolInput(event.name, event.input),
      ), {
        phase: 'running_tool',
        activeTool: {name: event.name, summary},
        error: undefined,
      });
    }
    case 'tool_finished': {
      const summary = describeTool(event.name);
      if (!event.result.ok) {
        return append(state, entry('error', event.name, failureDetails(event.result)), {
          phase: 'thinking',
          activeTool: undefined,
          error: event.result.error?.message ?? event.result.summary,
        });
      }
      return append(state, entry('result', event.name, event.result.summary), {
        phase: 'thinking',
        activeTool: undefined,
      });
    }
    case 'review':
      return append(state, entry('review', '红眼审查', `${event.decision.risk} 风险 · ${event.decision.summary}`), {
        phase: event.decision.verdict === 'ask_user' ? 'confirming' : 'reviewing',
      });
    case 'limit_reached':
      return append(state, entry('error', '达到上限', `已达到${event.limit === 'turns' ? '轮次' : '工具调用'}上限`), {
        phase: 'idle',
        liveReasoning: '',
        liveAssistant: '',
      });
    case 'interrupted':
      return append(state, entry('error', '已中止', event.reason), {
        phase: 'idle',
        activeTool: undefined,
        liveReasoning: '',
        liveAssistant: '',
      });
    case 'error':
      return append(state, entry('error', '错误', event.message), {
        phase: 'error',
        activeTool: undefined,
        error: event.message,
        liveReasoning: '',
        liveAssistant: '',
      });
  }
}
