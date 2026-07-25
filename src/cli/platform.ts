export function resolveUserHome(
  env: NodeJS.ProcessEnv,
  fallback: string,
): string {
  const home = env.HOME?.trim();
  return home || fallback;
}

export function credentialSaverForPlatform(
  platform: NodeJS.Platform,
  saveKey: (key: string) => Promise<void>,
): ((key: string) => Promise<void>) | undefined {
  return platform === 'darwin' ? saveKey : undefined;
}
