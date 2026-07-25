import {describe, expect, it} from 'vitest';
import {parseSlashCommand} from '../../src/cli/commands.js';

describe('parseSlashCommand', () => {
  it.each([
    ['/help', {name: 'help', args: []}],
    ['/status', {name: 'status', args: []}],
    ['/model wolf-2', {name: 'model', args: ['wolf-2']}],
    ['/diff', {name: 'diff', args: []}],
    ['/permissions', {name: 'permissions', args: []}],
    ['/compact', {name: 'compact', args: []}],
    ['/clear', {name: 'clear', args: []}],
    ['/resume abc', {name: 'resume', args: ['abc']}],
    ['/exit', {name: 'exit', args: []}],
  ])('parses %s', (input, expected) => {
    expect(parseSlashCommand(input)).toEqual(expected);
  });

  it('preserves an unknown command for local feedback', () => {
    expect(parseSlashCommand('/howl now')).toEqual({name: 'unknown', raw: '/howl now'});
  });

  it('does not treat ordinary task text as a command', () => {
    expect(parseSlashCommand('读取 README')).toBeUndefined();
  });
});
