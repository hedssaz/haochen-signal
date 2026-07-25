import type {SessionInfo} from '../sessions/types.js';

export interface ResumePickerItem {
  group: 'current' | 'legacy';
  session: SessionInfo;
}

export interface ResumePickerState {
  items: ResumePickerItem[];
  selectedIndex: number;
  windowStart: number;
}

export function createResumePicker(
  sessions: readonly SessionInfo[],
  workspaceId: string,
): ResumePickerState {
  const current = sessions
    .filter(session => session.workspaceId === workspaceId)
    .map(session => ({group: 'current' as const, session}));
  const legacy = sessions
    .filter(session => session.workspaceId === undefined)
    .map(session => ({group: 'legacy' as const, session}));
  return {items: [...current, ...legacy], selectedIndex: 0, windowStart: 0};
}

export function moveResumeSelection(
  state: ResumePickerState,
  delta: number,
  windowSize: number,
): ResumePickerState {
  if (state.items.length === 0) return state;
  const selectedIndex = (
    state.selectedIndex + delta + state.items.length
  ) % state.items.length;
  const safeWindowSize = Math.max(1, Math.floor(windowSize));
  let windowStart = state.windowStart;
  if (selectedIndex < windowStart) windowStart = selectedIndex;
  if (selectedIndex >= windowStart + safeWindowSize) {
    windowStart = selectedIndex - safeWindowSize + 1;
  }
  return {...state, selectedIndex, windowStart};
}

export function visibleResumeItems(
  state: ResumePickerState,
  windowSize: number,
): ResumePickerItem[] {
  const safeWindowSize = Math.max(1, Math.floor(windowSize));
  return state.items.slice(state.windowStart, state.windowStart + safeWindowSize);
}
