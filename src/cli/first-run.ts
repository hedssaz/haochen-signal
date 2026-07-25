import {parseConfig, type HaochenConfig} from '../config/schema.js';

export interface FirstRunInput {
  read(prompt: string, options?: {hidden?: boolean}): Promise<string>;
}

export interface FirstRunOutput {
  write(text: string): void;
  saveKey?: (key: string) => Promise<void>;
}

export interface FirstRunResult {
  config: HaochenConfig;
  apiKey: string;
  keySaved: boolean;
}

async function askNonEmpty(input: FirstRunInput, output: FirstRunOutput, prompt: string, hidden = false): Promise<string> {
  while (true) {
    const value = (await input.read(prompt, {hidden})).trim();
    if (value.length > 0) return value;
    output.write('输入不能为空，请重新输入。\n');
  }
}

async function askConfig(input: FirstRunInput, output: FirstRunOutput): Promise<HaochenConfig> {
  while (true) {
    const baseUrl = await askNonEmpty(input, output, 'API 地址：');
    try {
      parseConfig({baseUrl, model: '验证模型'});
    } catch {
      output.write('API 地址无效，请输入完整的 http:// 或 https:// 地址。\n');
      continue;
    }
    const model = await askNonEmpty(input, output, '模型：');
    return parseConfig({baseUrl, model});
  }
}

export async function runFirstRunWithCredentials(
  input: FirstRunInput,
  output: FirstRunOutput,
): Promise<FirstRunResult> {
  output.write('首次进入信号场：请配置 OpenAI-compatible 服务。\n');
  const config = await askConfig(input, output);
  const apiKey = await askNonEmpty(input, output, 'API Key：', true);
  if (output.saveKey !== undefined) {
    const choice = (
      await input.read('将 API Key 保存到系统钥匙串？[y/N]：')
    ).trim().toLowerCase();
    if (choice === 'y' || choice === 'yes') {
      await output.saveKey(apiKey);
      output.write('API Key 已保存到系统钥匙串。\n');
      return {config, apiKey, keySaved: true};
    }
  }

  output.write('API Key 仅在本次进程中使用，不会写入配置文件。\n');
  return {config, apiKey, keySaved: false};
}

/** First-run public contract: configuration never contains a credential. */
export async function runFirstRun(
  input: FirstRunInput,
  output: FirstRunOutput,
): Promise<HaochenConfig> {
  return (await runFirstRunWithCredentials(input, output)).config;
}
