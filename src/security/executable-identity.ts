import {constants as fsConstants} from 'node:fs';
import {access, realpath, stat} from 'node:fs/promises';
import {posix, win32} from 'node:path';

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(
    candidate => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : env[key];
}

function windowsExtensions(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const configured = environmentValue(env, 'PATHEXT', 'win32')
    ?? '.EXE;.CMD;.BAT;.COM';
  const extensions = configured
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension => (
      extension.startsWith('.') ? extension : `.${extension}`
    ));
  return win32.extname(win32.basename(command)).length > 0
    ? ['', ...extensions]
    : extensions;
}

function unquotePathEntry(entry: string): string {
  const trimmed = entry.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Produces deterministic executable candidates without filesystem access.
 * On Windows, unlike `which`, a bare command never receives an implicit cwd
 * candidate. Only absolute PATH entries participate in bare-command lookup.
 */
export function executableSearchCandidates(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix;
  const hasPath = platform === 'win32'
    ? command.includes('/') || command.includes('\\')
    : command.includes('/');
  const extensions = platform === 'win32'
    ? windowsExtensions(command, env)
    : [''];
  const bases: string[] = [];

  if (hasPath) {
    bases.push(
      pathApi.isAbsolute(command)
        ? pathApi.normalize(command)
        : pathApi.resolve(cwd, command),
    );
  } else {
    const pathValue = environmentValue(env, 'PATH', platform) ?? '';
    for (const rawEntry of pathValue.split(pathApi.delimiter)) {
      const entry = unquotePathEntry(rawEntry);
      if (entry.length === 0 || !pathApi.isAbsolute(entry)) continue;
      bases.push(pathApi.join(entry, command));
    }
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function resolveExecutableIdentity(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  for (const candidate of executableSearchCandidates(
    command,
    cwd,
    env,
    platform,
  )) {
    try {
      await access(candidate, mode);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      // Continue through the deterministic candidate list.
    }
  }
  return undefined;
}
