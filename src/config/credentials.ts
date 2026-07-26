import {execFile} from 'node:child_process';
import type {ProviderProfile} from './schema.js';

export type CredentialProvider = Pick<
  ProviderProfile,
  'id' | 'credentialRef'
> & Partial<Pick<ProviderProfile, 'name'>>;

export interface CredentialOptions {
  provider?: CredentialProvider;
  env: NodeJS.ProcessEnv;
  readKeychain: (credentialRef?: string) => Promise<string | undefined>;
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
  const normalizedId = providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalizedId.length === 0) {
    throw new Error('供应商 ID 无法生成环境变量名');
  }
  return `HAOCHEN_${normalizedId}_API_KEY`;
}

function isLegacyProvider(
  provider: CredentialProvider | undefined,
): boolean {
  return provider === undefined
    || provider.credentialRef === 'legacy';
}

export async function resolveApiKey(options: CredentialOptions): Promise<string | undefined> {
  const providerEnvKey = options.provider === undefined
    ? undefined
    : trimmedCredential(options.env[
      providerApiKeyEnvironmentVariable(options.provider.id)
    ]);
  if (providerEnvKey) return providerEnvKey;

  const envKey = isLegacyProvider(options.provider)
    ? trimmedCredential(options.env.HAOCHEN_API_KEY)
    : undefined;
  if (envKey) return envKey;
  const stored = trimmedCredential(
    await options.readKeychain(options.provider?.credentialRef),
  );
  if (stored) return stored;
  return trimmedCredential(await options.prompt());
}

function keychainService(credentialRef: string | undefined): string {
  const normalizedRef = credentialRef?.trim();
  return normalizedRef
    ? `haochen-signal:${normalizedRef}`
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
  credentialRef?: string,
): Promise<string | undefined>;
export function readMacOsKeychain(
  run?: ProcessRunner,
  platform?: NodeJS.Platform,
  credentialRef?: string,
): Promise<string | undefined>;
export async function readMacOsKeychain(
  credentialRefOrRun: string | ProcessRunner = runProcess,
  platform: NodeJS.Platform = process.platform,
  injectedCredentialRef?: string,
): Promise<string | undefined> {
  const run = typeof credentialRefOrRun === 'function'
    ? credentialRefOrRun
    : runProcess;
  const credentialRef = typeof credentialRefOrRun === 'string'
    ? credentialRefOrRun
    : injectedCredentialRef;
  const effectivePlatform = typeof credentialRefOrRun === 'string'
    ? process.platform
    : platform;
  if (effectivePlatform !== 'darwin') return undefined;

  const stored = await readKeychainService(
    keychainService(credentialRef),
    run,
  );
  if (stored !== undefined) return stored;

  if (credentialRef === 'legacy') {
    return readKeychainService(keychainService(undefined), run);
  }
  return undefined;
}

export async function saveMacOsKeychain(
  key: string,
  run: ProcessRunner = runProcess,
  platform: NodeJS.Platform = process.platform,
  credentialRef?: string,
): Promise<void> {
  if (platform !== 'darwin') return;

  await run('security', [
    'add-generic-password',
    '-U',
    '-a',
    'haochen',
    '-s',
    keychainService(credentialRef),
    '-w',
    key,
  ]);
}
