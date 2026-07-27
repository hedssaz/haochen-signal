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
  | 'reasoning'
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
  compact?: boolean;
  toolStatus?: 'pending' | 'success' | 'failure';
}

export interface UiState {
  phase: UiPhase;
  input: string;
  transcript: UiEntry[];
  liveReasoning: string;
  liveAssistant: string;
  usedContext: number;
  roundUsageTotal?: number;
  previousRoundTotal?: number;
  showPreviousRoundUsage: boolean;
  taskTranscriptStart?: number;
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
  | {type: 'usage'; inputTokens: number; outputTokens: number}
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
  | {type: 'task_started'}
  | {type: 'input'; input: string}
  | {type: 'notice'; entry: UiEntry; phase?: UiPhase};

export const initialUiState: UiState = {
  phase: 'idle',
  input: '',
  transcript: [],
  liveReasoning: '',
  liveAssistant: '',
  usedContext: 0,
  showPreviousRoundUsage: false,
};

const toolSummary: Record<string, string> = {
  list_files: '扫描信号',
  search_text: '扫描信号',
  read_file: '读取碎片',
  write_file: '创建文件',
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

function finalizeLiveRound(state: UiState): UiState {
  return {
    ...state,
    transcript: state.liveReasoning.length === 0
      ? state.transcript
      : [...state.transcript, entry('reasoning', '思考', state.liveReasoning)],
    liveReasoning: '',
    liveAssistant: '',
  };
}

const collapsibleProcessKinds = new Set<UiEntryKind>([
  'reasoning',
  'tool',
  'result',
  'approval',
  'review',
  'status',
]);

function collapseCurrentTaskProcess(state: UiState): UiEntry[] {
  if (state.taskTranscriptStart === undefined) return state.transcript;
  return [
    ...state.transcript.slice(0, state.taskTranscriptStart),
    ...state.transcript
      .slice(state.taskTranscriptStart)
      .filter(item => !collapsibleProcessKinds.has(item.kind)),
  ];
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function updatePendingTool(
  state: UiState,
  name: string,
  result: ToolResult,
): UiState | undefined {
  let index = -1;
  for (let itemIndex = state.transcript.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = state.transcript[itemIndex];
    if (
      item?.kind === 'tool'
      && item.title === name
      && item.toolStatus === 'pending'
    ) {
      index = itemIndex;
      break;
    }
  }
  if (index < 0) return undefined;

  const current = state.transcript[index]!;
  const outcome = result.ok
    ? `✓ ${singleLine(result.summary)}`
    : `✗ ${singleLine(failureDetails(result))}`;
  const updated: UiEntry = {
    ...current,
    detail: [current.detail, outcome].filter(Boolean).join(' · '),
    toolStatus: result.ok ? 'success' : 'failure',
  };
  return {
    ...state,
    transcript: state.transcript.map((item, itemIndex) => (
      itemIndex === index ? updated : item
    )),
  };
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
  if (event.type === 'task_started') {
    return {
      ...state,
      roundUsageTotal: undefined,
      previousRoundTotal: undefined,
      showPreviousRoundUsage: false,
      taskTranscriptStart: state.transcript.length,
    };
  }
  if (event.type === 'input') return {...state, input: event.input};
  if (event.type === 'notice') {
    return append(state, event.entry, event.phase === undefined ? {} : {phase: event.phase});
  }

  switch (event.type) {
    case 'status':
      return {
        ...state,
        phase: 'thinking',
        showPreviousRoundUsage: false,
        error: undefined,
      };
    case 'reasoning_delta':
      return {
        ...state,
        phase: 'thinking',
        showPreviousRoundUsage: false,
        error: undefined,
        liveReasoning: state.liveReasoning + event.text,
      };
    case 'assistant_delta':
      if (event.text.length === 0) return state;
      return {
        ...state,
        phase: 'thinking',
        showPreviousRoundUsage: false,
        error: undefined,
        transcript: collapseCurrentTaskProcess(state),
        liveReasoning: '',
        liveAssistant: state.liveAssistant + event.text,
      };
    case 'usage': {
      const total = event.inputTokens + event.outputTokens;
      return {
        ...state,
        usedContext: total,
        roundUsageTotal: total,
      };
    }
    case 'assistant_turn_finished': {
      const finalized = finalizeLiveRound(state);
      return {
        ...finalized,
        roundUsageTotal: undefined,
        previousRoundTotal: state.roundUsageTotal,
        showPreviousRoundUsage: false,
      };
    }
    case 'assistant_message': {
      const finalized = finalizeLiveRound(state);
      return append(finalized, entry('assistant', '浩宸', event.text), {
        phase: 'thinking',
        roundUsageTotal: undefined,
        previousRoundTotal: state.roundUsageTotal,
        showPreviousRoundUsage: false,
        error: undefined,
      });
    }
    case 'assistant_text': {
      const finalized = finalizeLiveRound(state);
      return append(finalized, entry('assistant', '浩宸', event.text), {
        phase: 'idle',
        roundUsageTotal: undefined,
        previousRoundTotal: undefined,
        showPreviousRoundUsage: false,
        taskTranscriptStart: undefined,
        activeTool: undefined,
        error: undefined,
      });
    }
    case 'tool_started': {
      const summary = describeTool(event.name);
      return append(state, {
        ...entry(
          'tool',
          event.name,
          summary,
          summarizeToolInput(event.name, event.input),
        ),
        compact: true,
        toolStatus: 'pending',
      }, {
        phase: 'running_tool',
        showPreviousRoundUsage: true,
        activeTool: {name: event.name, summary},
        error: undefined,
      });
    }
    case 'tool_finished': {
      const summary = describeTool(event.name);
      const merged = updatePendingTool(state, event.name, event.result);
      if (merged !== undefined) {
        return {
          ...merged,
          phase: 'thinking',
          showPreviousRoundUsage: false,
          activeTool: undefined,
          ...(event.result.ok
            ? {}
            : {error: event.result.error?.message ?? event.result.summary}),
        };
      }
      if (!event.result.ok) {
        return append(state, entry('error', event.name, failureDetails(event.result)), {
          phase: 'thinking',
          showPreviousRoundUsage: false,
          activeTool: undefined,
          error: event.result.error?.message ?? event.result.summary,
        });
      }
      return append(state, entry('result', event.name, event.result.summary), {
        phase: 'thinking',
        showPreviousRoundUsage: false,
        activeTool: undefined,
      });
    }
    case 'review':
      return append(state, entry('review', '红眼审查', `${event.decision.risk} 风险 · ${event.decision.summary}`), {
        phase: event.decision.verdict === 'ask_user' ? 'confirming' : 'reviewing',
        showPreviousRoundUsage: true,
      });
    case 'limit_reached': {
      const finalized = finalizeLiveRound(state);
      return append(finalized, entry('error', '达到上限', `已达到${event.limit === 'turns' ? '轮次' : '工具调用'}上限`), {
        phase: 'idle',
        showPreviousRoundUsage: false,
        taskTranscriptStart: undefined,
      });
    }
    case 'interrupted': {
      const finalized = finalizeLiveRound(state);
      return append(finalized, entry('error', '已中止', event.reason), {
        phase: 'idle',
        showPreviousRoundUsage: false,
        taskTranscriptStart: undefined,
        activeTool: undefined,
      });
    }
    case 'error': {
      const finalized = finalizeLiveRound(state);
      return append(finalized, entry('error', '错误', event.message), {
        phase: 'error',
        showPreviousRoundUsage: false,
        taskTranscriptStart: undefined,
        activeTool: undefined,
        error: event.message,
      });
    }
  }
}
