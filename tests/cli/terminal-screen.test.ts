import {describe, expect, it, vi} from 'vitest';
import {clearTerminalScreen} from '../../src/cli/terminal-screen.js';

describe('clearTerminalScreen', () => {
  it('clears the visible screen and scrollback before the UI starts', () => {
    const write = vi.fn();

    clearTerminalScreen({isTTY: true, write});

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('\u001B[2J\u001B[3J\u001B[H');
  });

  it('does not emit terminal control sequences outside a TTY', () => {
    const write = vi.fn();

    clearTerminalScreen({isTTY: false, write});

    expect(write).not.toHaveBeenCalled();
  });
});
