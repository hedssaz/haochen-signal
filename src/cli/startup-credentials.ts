import {resolveApiKey} from '../config/credentials.js';
import type {CredentialProvider} from '../config/credentials.js';
import type {FirstRunInput} from './first-run.js';

interface TemporaryCredentialInput extends FirstRunInput {
  close(): void;
}

export interface StartupApiKeyOptions {
  provider?: CredentialProvider;
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readKeychain: (providerId?: string) => Promise<string | undefined>;
  createInput: () => TemporaryCredentialInput;
  write: (text: string) => void;
}

export async function resolveStartupApiKey(
  options: StartupApiKeyOptions,
): Promise<string | undefined> {
  let input: TemporaryCredentialInput | undefined;
  try {
    return await resolveApiKey({
      provider: options.provider,
      env: options.env,
      readKeychain: (options.platform ?? process.platform) === 'darwin'
        ? options.readKeychain
        : async () => undefined,
      prompt: async () => {
        input ??= options.createInput();
        while (true) {
          const key = (
            await input.read(
              options.provider?.name === undefined
                ? 'API Key：'
                : `${options.provider.name} API Key：`,
              {hidden: true},
            )
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
