import {parseConfig, type HaochenConfig} from '../config/schema.js';

export interface FirstRunInput {
  read(prompt: string, options?: {hidden?: boolean}): Promise<string>;
}

export interface FirstRunOutput {
  write(text: string): void;
  saveKey?: (key: string) => Promise<void>;
}

export function createFirstRunConfig(): HaochenConfig {
  return parseConfig({
    version: 2,
    providers: [],
    models: [],
    timeoutMs: 60_000,
  });
}

export async function runFirstRun(
  _input: FirstRunInput,
  _output: FirstRunOutput,
): Promise<HaochenConfig> {
  return createFirstRunConfig();
}
