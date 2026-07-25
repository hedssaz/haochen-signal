import {describe, expect, it} from 'vitest';
import {summarizeToolInput} from '../../src/cli/tool-summary.js';

describe('summarizeToolInput', () => {
  it('redacts credentials before serializing ordinary tool input', () => {
    expect(summarizeToolInput('read_file', {
      path: 'README.md',
      authorization: 'Bearer secret-value',
    })).toBe('{"path":"README.md","authorization":"[REDACTED]"}');
  });

  it('summarizes patch operations without exposing replacement content', () => {
    expect(summarizeToolInput('apply_patch', {
      operations: [
        {type: 'update', path: 'src/a.ts', replacement: 'private replacement'},
        {type: 'delete', path: 'src/b.ts', sha256: 'abc'},
      ],
    })).toBe(
      '{"operations":[{"type":"update","path":"src/a.ts"},{"type":"delete","path":"src/b.ts"}]}',
    );
  });

  it('limits long summaries to the requested number of code points', () => {
    const result = summarizeToolInput('read_file', {text: '狼'.repeat(500)}, 80);

    expect(Array.from(result)).toHaveLength(80);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles circular input without throwing', () => {
    const input: Record<string, unknown> = {path: 'README.md'};
    input.self = input;

    expect(summarizeToolInput('read_file', input)).toContain('[CIRCULAR]');
  });
});
