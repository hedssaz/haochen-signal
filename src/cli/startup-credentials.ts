import {resolveApiKey} from '../config/credentials.js';
import type {CredentialProvider} from '../config/credentials.js';

export interface StartupApiKeyOptions {
  provider?: CredentialProvider;
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readKeychain: (
    providerId?: string,
    allowLegacyFallback?: boolean,
  ) => Promise<string | undefined>;
  prompt: () => Promise<string | undefined>;
}

export async function resolveStartupApiKey(
  options: StartupApiKeyOptions,
): Promise<string | undefined> {
  return resolveApiKey({
    provider: options.provider,
    env: options.env,
    readKeychain: (options.platform ?? process.platform) === 'darwin'
      ? options.readKeychain
      : async () => undefined,
    prompt: options.prompt,
  });
}
