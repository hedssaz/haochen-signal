import {expect, it} from 'vitest';
import {redactValue} from '../../src/security/redact.js';

it('redacts credentials recursively without changing safe values', () => {
  expect(redactValue({
    authorization: 'Bearer secret-token',
    nested: {apiKey: 'sk-test-1234567890', file: 'src/index.ts'},
  })).toEqual({
    authorization: '[REDACTED]',
    nested: {apiKey: '[REDACTED]', file: 'src/index.ts'},
  });
});

it('redacts credential patterns embedded in strings', () => {
  expect(redactValue(
    'auth Bearer abc.def key sk-test-1234567890 token ghp_1234567890abcdef',
  )).toBe('auth [REDACTED] key [REDACTED] token [REDACTED]');

  expect(redactValue(
    'before -----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY----- after',
  )).toBe('before [REDACTED] after');
});

it('does not retain material after an unterminated private-key header', () => {
  expect(redactValue(
    'before -----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material',
  )).toBe('before [REDACTED]');
});

it('preserves arrays and primitive values while redacting their strings', () => {
  expect(redactValue([
    'Bearer token-value',
    42,
    true,
    false,
    null,
    {password: 'unsafe', safe: 'value'},
  ])).toEqual([
    '[REDACTED]',
    42,
    true,
    false,
    null,
    {password: '[REDACTED]', safe: 'value'},
  ]);
});

it('does not modify the input object', () => {
  const input = {
    nested: {token: 'unsafe', file: 'src/index.ts'},
    list: ['sk-test-1234567890'],
  };

  redactValue(input);

  expect(input).toEqual({
    nested: {token: 'unsafe', file: 'src/index.ts'},
    list: ['sk-test-1234567890'],
  });
});

it('replaces circular references deterministically', () => {
  const input: {name: string; self?: unknown} = {name: 'safe'};
  input.self = input;

  expect(redactValue(input)).toEqual({
    name: 'safe',
    self: '[CIRCULAR]',
  });
});

it('removes complete environment maps', () => {
  expect(redactValue({
    env: {PATH: '/usr/bin', SAFE_FLAG: 'true'},
    nested: {environment: {HOME: '/private/home'}},
  })).toEqual({
    env: '[REDACTED]',
    nested: {environment: '[REDACTED]'},
  });
});
