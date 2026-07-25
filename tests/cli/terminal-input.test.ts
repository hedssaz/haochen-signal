import {PassThrough} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {createFirstRunInput} from '../../src/cli/terminal-input.js';

describe('createFirstRunInput', () => {
  it('resumes a paused TTY while waiting for a hidden value', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: true;
      setRawMode(mode: boolean): void;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const output = new PassThrough();
    const terminalInput = createFirstRunInput(input, output);
    const resume = vi.spyOn(input, 'resume');

    const value = terminalInput.read('API Key：', {hidden: true});

    expect(resume).toHaveBeenCalledOnce();
    input.write('secret');
    input.write('\n');
    await expect(value).resolves.toBe('secret');
    terminalInput.close();
  });
});
