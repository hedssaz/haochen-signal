import {describe, expect, it, vi} from 'vitest';
import {runFirstRun} from '../../src/cli/first-run.js';

describe('runFirstRun', () => {
  it('creates an empty v2 config without asking for a provider, model, or key', async () => {
    const input = {
      read: vi.fn(async () => {
        throw new Error('无模型启动不应读取终端输入');
      }),
    };
    const output = {
      write: vi.fn(),
      saveKey: vi.fn(async () => undefined),
    };

    await expect(runFirstRun(input, output)).resolves.toEqual({
      version: 2,
      providers: [],
      models: [],
      timeoutMs: 60_000,
    });

    expect(input.read).not.toHaveBeenCalled();
    expect(output.write).not.toHaveBeenCalled();
    expect(output.saveKey).not.toHaveBeenCalled();
  });
});
