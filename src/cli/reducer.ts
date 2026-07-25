import type {ReviewDecision} from '../security/reviewer.js';
import type {ToolResult} from '../tools/types.js';

export type UiPhase =
  | 'idle'
  | 'thinking'
  | 'running_tool'
  | 'reviewing'
  | 'confirming'
  | 'error';

export interface UiEntry {
  prefix: '◆' | '◇' | '◉' | '✓' | '✗';
  text: string;
}

export interface UiState {
  phase: UiPhase;
  input: string;
  transcript: UiEntry[];
  activeTool?: {name: string; summary: string};
  error?: string;
}

/**
 * The agent loop is intentionally injected structurally. This keeps the UI
 * independently testable while the loop module is integrated at the entrypoint.
 */
export type AgentUiEvent =
  | {type: 'status'; text: string}
  | {type: 'assistant_delta'; text: string}
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
};

const toolSummary: Record<string, {text: string; prefix: UiEntry['prefix']}> = {
  list_files: {text: '扫描信号', prefix: '◆'},
  search_text: {text: '扫描信号', prefix: '◆'},
  read_file: {text: '读取碎片', prefix: '◆'},
  apply_patch: {text: '修改节点', prefix: '◆'},
  run_command: {text: '执行验证', prefix: '◇'},
  git_status: {text: '读取 Git 状态', prefix: '◆'},
  git_diff: {text: '读取 Git 差异', prefix: '◆'},
  git_log: {text: '读取 Git 记录', prefix: '◆'},
  web_search: {text: '搜索公开资料', prefix: '◆'},
  web_fetch: {text: '读取公开资料', prefix: '◆'},
};

function entry(prefix: UiEntry['prefix'], text: string): UiEntry {
  return {prefix, text};
}

function append(state: UiState, value: UiEntry, overrides: Partial<UiState> = {}): UiState {
  return {...state, ...overrides, transcript: [...state.transcript, value]};
}

function describeTool(name: string): {text: string; prefix: UiEntry['prefix']} {
  return toolSummary[name] ?? {text: `执行工具 ${name}`, prefix: '◆'};
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
      return append(state, entry('◆', event.text), {phase: 'thinking', error: undefined});
    case 'assistant_delta':
      return {...state, phase: 'thinking', error: undefined};
    case 'assistant_message':
      return append(state, entry('◆', event.text), {
        phase: 'thinking',
        error: undefined,
      });
    case 'assistant_text':
      return append(state, entry('✓', `任务完成\n${event.text}`), {
        phase: 'idle',
        activeTool: undefined,
        error: undefined,
      });
    case 'tool_started': {
      const summary = describeTool(event.name);
      return append(state, entry(summary.prefix, summary.text), {
        phase: 'running_tool',
        activeTool: {name: event.name, summary: summary.text},
        error: undefined,
      });
    }
    case 'tool_finished': {
      const summary = describeTool(event.name);
      if (!event.result.ok) {
        return append(state, entry('✗', failureDetails(event.result)), {
          phase: 'thinking',
          activeTool: undefined,
          error: event.result.error?.message ?? event.result.summary,
        });
      }
      return append(state, entry(summary.prefix, event.result.summary), {
        phase: 'thinking',
        activeTool: undefined,
      });
    }
    case 'review':
      return append(state, entry('◉', `红眼审查\n${event.decision.risk} 风险 · ${event.decision.summary}`), {
        phase: event.decision.verdict === 'ask_user' ? 'confirming' : 'reviewing',
      });
    case 'limit_reached':
      return append(state, entry('✗', `已达到${event.limit === 'turns' ? '轮次' : '工具调用'}上限`), {
        phase: 'idle',
      });
    case 'interrupted':
      return append(state, entry('✗', `已中止：${event.reason}`), {
        phase: 'idle',
        activeTool: undefined,
      });
    case 'error':
      return append(state, entry('✗', event.message), {
        phase: 'error',
        activeTool: undefined,
        error: event.message,
      });
  }
}
