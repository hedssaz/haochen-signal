import {describe, expect, it, vi} from 'vitest';
import {runFirstRun, runFirstRunWithCredentials} from '../../src/cli/first-run.js';

function scriptedInput(values: string[]) {
  const seen: Array<{prompt: string; hidden?: boolean}> = [];
  return {
    seen,
    read: async (prompt: string, options?: {hidden?: boolean}) => {
      seen.push({prompt, hidden: options?.hidden});
      const value = values.shift();
      if (value === undefined) throw new Error('输入脚本已耗尽');
      return value;
    },
  };
}

describe('runFirstRun', () => {
  it('asks for an endpoint and model when there is no config', async () => {
    const input = scriptedInput(['https://api.example.test/v1/', 'wolf-2', 'temp-key', 'n']);
    const output: string[] = [];

    const result = await runFirstRunWithCredentials(input, {write: value => output.push(value)});

    expect(result.config).toMatchObject({baseUrl: 'https://api.example.test/v1', model: 'wolf-2'});
    expect(result.apiKey).toBe('temp-key');
    expect(input.seen.map(value => value.prompt)).toEqual(expect.arrayContaining([
      'API 地址：',
      '模型：',
    ]));
  });

  it('retries an invalid endpoint', async () => {
    const input = scriptedInput(['not a url', 'https://api.example.test/v1', 'wolf-2', 'temp-key', 'n']);

    await runFirstRun(input, {write: () => undefined});

    expect(input.seen.filter(value => value.prompt.includes('API 地址'))).toHaveLength(2);
  });

  it('requests the API key without echoing it', async () => {
    const input = scriptedInput(['https://api.example.test/v1', 'wolf-2', 'temp-key', 'n']);

    await runFirstRun(input, {write: () => undefined});

    expect(input.seen.find(value => value.prompt.includes('API Key'))).toMatchObject({hidden: true});
  });

  it('does not save a temporarily used key', async () => {
    const input = scriptedInput(['https://api.example.test/v1', 'wolf-2', 'temp-key', 'n']);
    const saveKey = vi.fn(async () => undefined);

    await runFirstRun(input, {write: () => undefined, saveKey});

    expect(saveKey).not.toHaveBeenCalled();
  });

  it('never puts the API key in the returned configuration', async () => {
    const input = scriptedInput(['https://api.example.test/v1', 'wolf-2', 'temp-key', 'n']);

    const config = await runFirstRun(input, {write: () => undefined});

    expect(JSON.stringify(config)).not.toContain('temp-key');
    expect(config).not.toHaveProperty('apiKey');
  });
});
