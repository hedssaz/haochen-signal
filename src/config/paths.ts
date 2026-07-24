import {isAbsolute, join} from 'node:path';

export interface AppPaths {
  configFile: string;
  sessionsDir: string;
  auditDir: string;
}

function getXdgHome(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && isAbsolute(candidate) ? candidate : fallback;
}

export function getAppPaths(env: NodeJS.ProcessEnv, home: string): AppPaths {
  const configHome = getXdgHome(env.XDG_CONFIG_HOME, join(home, '.config'));
  const dataHome = getXdgHome(env.XDG_DATA_HOME, join(home, '.local', 'share'));
  const stateHome = getXdgHome(env.XDG_STATE_HOME, join(home, '.local', 'state'));

  return {
    configFile: join(configHome, 'haochen', 'config.json'),
    sessionsDir: join(dataHome, 'haochen', 'sessions'),
    auditDir: join(stateHome, 'haochen', 'audit'),
  };
}
