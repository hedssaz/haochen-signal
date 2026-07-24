import {join} from 'node:path';

export interface AppPaths {
  configFile: string;
  sessionsDir: string;
  auditDir: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv, home: string): AppPaths {
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config');
  const dataHome = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const stateHome = env.XDG_STATE_HOME ?? join(home, '.local', 'state');

  return {
    configFile: join(configHome, 'haochen', 'config.json'),
    sessionsDir: join(dataHome, 'haochen', 'sessions'),
    auditDir: join(stateHome, 'haochen', 'audit'),
  };
}
