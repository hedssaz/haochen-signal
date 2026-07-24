import {execFile} from 'node:child_process';

export interface CredentialOptions {
  env: NodeJS.ProcessEnv;
  readKeychain: () => Promise<string | undefined>;
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

export async function resolveApiKey(options: CredentialOptions): Promise<string | undefined> {
  const envKey = options.env.HAOCHEN_API_KEY?.trim();
  if (envKey) return envKey;
  const stored = await options.readKeychain();
  if (stored) return stored;
  return options.prompt();
}

export async function readMacOsKeychain(
  run: ProcessRunner = runProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform !== 'darwin') return undefined;

  try {
    const output = await run('security', [
      'find-generic-password',
      '-a',
      'haochen',
      '-s',
      'haochen-signal',
      '-w',
    ]);
    const stdout = typeof output === 'string' ? output : output.stdout;
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function saveMacOsKeychain(
  key: string,
  run: ProcessRunner = runProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return;

  await run('security', [
    'add-generic-password',
    '-U',
    '-a',
    'haochen',
    '-s',
    'haochen-signal',
    '-w',
    key,
  ]);
}
