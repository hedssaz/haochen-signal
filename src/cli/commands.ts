export type KnownSlashCommandName =
  | 'help'
  | 'status'
  | 'model'
  | 'diff'
  | 'permissions'
  | 'compact'
  | 'clear'
  | 'resume'
  | 'exit';

export type SlashCommand =
  | {name: KnownSlashCommandName; args: string[]}
  | {name: 'unknown'; raw: string};

const knownCommands = new Set<KnownSlashCommandName>([
  'help',
  'status',
  'model',
  'diff',
  'permissions',
  'compact',
  'clear',
  'resume',
  'exit',
]);

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return undefined;

  const [rawName = '', ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (knownCommands.has(name as KnownSlashCommandName)) {
    return {name: name as KnownSlashCommandName, args};
  }
  return {name: 'unknown', raw: trimmed};
}
