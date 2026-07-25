import {resolveApiKey} from '../config/credentials.js';
import type {FirstRunInput} from './first-run.js';

interface TemporaryCredentialInput extends FirstRunInput {
  close(): void;
}

export interface StartupApiKeyOptions {
  env: NodeJS.ProcessEnv;
  readKeychain: () => Promise<string | undefined>;
  createInput: () => TemporaryCredentialInput;
  write: (text: string) => void;
}

export async function resolveStartupApiKey(
  options: StartupApiKeyOptions,
): Promise<string | undefined> {
  let input: TemporaryCredentialInput | undefined;
  try {
    return await resolveApiKey({
      env: options.env,
      readKeychain: options.readKeychain,
      prompt: async () => {
        input ??= options.createInput();
        while (true) {
          const key = (
            await input.read('API Key：', {hidden: true})
          ).trim();
          if (key.length > 0) return key;
          options.write('输入不能为空，请重新输入。\n');
        }
      },
    });
  } finally {
    input?.close();
  }
}
