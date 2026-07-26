import {execFile} from 'node:child_process';
import type {ProviderProfile} from './schema.js';

export type CredentialProvider = Pick<
  ProviderProfile,
  'id' | 'credentialRef'
> & Partial<Pick<ProviderProfile, 'name'>>;

export interface CredentialOptions {
  provider?: CredentialProvider;
  env: NodeJS.ProcessEnv;
  readKeychain: (
    providerId?: string,
    allowLegacyFallback?: boolean,
  ) => Promise<string | undefined>;
  prompt: () => Promise<string | undefined>;
}

export interface ProcessOutput {
  stdout: string;
}

export type ProcessRunner = (file: string, args: string[]) => Promise<ProcessOutput | string>;

function runProcess(file: string, args: string[]): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({stdout: stdout.toString()});
    });
  });
}

function trimmedCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function providerApiKeyEnvironmentVariable(providerId: string): string {
  if (providerId.length === 0) {
    throw new Error('供应商 ID 不能为空');
  }
  let encodedId = '';
  for (let index = 0; index < providerId.length; index += 1) {
    encodedId += providerId
      .charCodeAt(index)
      .toString(16)
      .toUpperCase()
      .padStart(4, '0');
  }
  return `HAOCHEN_PROVIDER_${encodedId}_API_KEY`;
}

function allowsLegacyFallback(
  provider: CredentialProvider | undefined,
): boolean {
  return provider === undefined
    || (
      provider.id === 'legacy-provider'
      && provider.credentialRef === 'legacy'
    );
}

export async function resolveApiKey(options: CredentialOptions): Promise<string | undefined> {
  const providerEnvKey = options.provider === undefined
    ? undefined
    : trimmedCredential(options.env[
      providerApiKeyEnvironmentVariable(options.provider.id)
    ]);
  if (providerEnvKey) return providerEnvKey;

  const allowLegacyFallback = allowsLegacyFallback(options.provider);
  const envKey = allowLegacyFallback
    ? trimmedCredential(options.env.HAOCHEN_API_KEY)
    : undefined;
  if (envKey) return envKey;
  const stored = trimmedCredential(
    await options.readKeychain(
      options.provider?.id,
      allowLegacyFallback,
    ),
  );
  if (stored) return stored;
  return trimmedCredential(await options.prompt());
}

function keychainService(providerId: string | undefined): string {
  return providerId
    ? `haochen-signal:${providerId}`
    : 'haochen-signal';
}

async function readKeychainService(
  service: string,
  run: ProcessRunner,
): Promise<string | undefined> {
  try {
    const output = await run('security', [
      'find-generic-password',
      '-a',
      'haochen',
      '-s',
      service,
      '-w',
    ]);
    const stdout = typeof output === 'string' ? output : output.stdout;
    return trimmedCredential(stdout);
  } catch {
    return undefined;
  }
}

export function readMacOsKeychain(
  providerId?: string,
  allowLegacyFallback?: boolean,
): Promise<string | undefined>;
export function readMacOsKeychain(
  run?: ProcessRunner,
  platform?: NodeJS.Platform,
  providerId?: string,
  allowLegacyFallback?: boolean,
): Promise<string | undefined>;
export async function readMacOsKeychain(
  providerIdOrRun?: string | ProcessRunner,
  platformOrAllowFallback?: NodeJS.Platform | boolean,
  injectedProviderId?: string,
  injectedAllowLegacyFallback = false,
): Promise<string | undefined> {
  const run = typeof providerIdOrRun === 'function'
    ? providerIdOrRun
    : runProcess;
  const providerId = typeof providerIdOrRun === 'string'
    ? providerIdOrRun
    : injectedProviderId;
  const effectivePlatform =
    typeof providerIdOrRun === 'function'
    && typeof platformOrAllowFallback === 'string'
      ? platformOrAllowFallback
      : process.platform;
  const allowLegacyFallback = typeof providerIdOrRun === 'function'
    ? injectedAllowLegacyFallback
    : platformOrAllowFallback === true;
  if (effectivePlatform !== 'darwin') return undefined;

  const stored = await readKeychainService(
    keychainService(providerId),
    run,
  );
  if (stored !== undefined) return stored;

  if (
    allowLegacyFallback
    && providerId === 'legacy-provider'
  ) {
    return readKeychainService(keychainService(undefined), run);
  }
  return undefined;
}

export async function saveMacOsKeychain(
  key: string,
  run: ProcessRunner = runProcess,
  platform: NodeJS.Platform = process.platform,
  providerId?: string,
): Promise<void> {
  if (platform !== 'darwin') return;

  await run('security', [
    'add-generic-password',
    '-U',
    '-a',
    'haochen',
    '-s',
    keychainService(providerId),
    '-w',
    key,
  ]);
}
