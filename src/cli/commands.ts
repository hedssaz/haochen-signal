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

export interface SlashCommandDefinition {
  name: KnownSlashCommandName;
  usage: string;
  description: string;
}

export const slashCommandDefinitions: readonly SlashCommandDefinition[] = [
  {name: 'help', usage: '/help', description: '查看帮助'},
  {name: 'status', usage: '/status', description: '查看会话状态'},
  {name: 'model', usage: '/model', description: '打开模型配置'},
  {name: 'diff', usage: '/diff', description: '查看 Git 差异'},
  {name: 'permissions', usage: '/permissions', description: '查看权限规则'},
  {name: 'compact', usage: '/compact', description: '压缩会话上下文'},
  {name: 'clear', usage: '/clear', description: '新建空白会话'},
  {name: 'resume', usage: '/resume [ID]', description: '恢复历史会话'},
  {name: 'exit', usage: '/exit', description: '保存并退出'},
];

export function suggestSlashCommands(input: string): readonly SlashCommandDefinition[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  return slashCommandDefinitions.filter(command => command.name.startsWith(prefix));
}

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
