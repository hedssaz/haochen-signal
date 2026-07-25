import {describe, expect, it} from 'vitest';
import {
  createResumePicker,
  moveResumeSelection,
  visibleResumeItems,
} from '../../src/cli/resume-picker.js';

const sessions = [
  {id: 'current-1', updatedAt: 30, preview: '最近会话', workspaceId: 'workspace-a'},
  {id: 'other-1', updatedAt: 40, preview: '其他项目', workspaceId: 'workspace-b'},
  {id: 'current-2', updatedAt: 20, preview: '较早会话', workspaceId: 'workspace-a'},
  {id: 'legacy-1', updatedAt: 50, preview: '旧版会话'},
];

describe('resume picker', () => {
  it('groups current-workspace sessions before legacy sessions', () => {
    const picker = createResumePicker(sessions, 'workspace-a');

    expect(picker.items.map(item => [item.session.id, item.group])).toEqual([
      ['current-1', 'current'],
      ['current-2', 'current'],
      ['legacy-1', 'legacy'],
    ]);
  });

  it('wraps selection and keeps it inside the visible window', () => {
    const picker = createResumePicker(sessions, 'workspace-a');
    const wrapped = moveResumeSelection(picker, -1, 2);

    expect(wrapped.selectedIndex).toBe(2);
    expect(visibleResumeItems(wrapped, 2).map(item => item.session.id)).toEqual([
      'current-2',
      'legacy-1',
    ]);
  });
});
