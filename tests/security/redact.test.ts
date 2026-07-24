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

it('redacts Basic and API key headers in strings, objects, and tuples', () => {
  expect(redactValue({
    basicLine: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    apiLine: 'X-API-Key: api-value',
    headers: {
      Authorization: 'Basic dXNlcjpwYXNzd29yZA==',
      'X-API-Key': 'api-value',
    },
    headerTuples: [
      ['Authorization', 'Basic dXNlcjpwYXNzd29yZA=='],
      ['X-API-Key', 'api-value'],
    ],
  })).toEqual({
    basicLine: 'Authorization: [REDACTED]',
    apiLine: 'X-API-Key: [REDACTED]',
    headers: {
      Authorization: '[REDACTED]',
      'X-API-Key': '[REDACTED]',
    },
    headerTuples: [
      ['Authorization', '[REDACTED]'],
      ['X-API-Key', '[REDACTED]'],
    ],
  });
});

it('redacts GitHub, Stripe, and credential-bearing database URLs', () => {
  expect(redactValue({
    github: 'github_pat_1234567890abcdef',
    stripeLive: 'sk_live_1234567890abcdef',
    stripeTest: 'sk_test_1234567890abcdef',
    DATABASE_URL: 'postgresql://app:db-password@db.example.test/app',
    message: 'connect mongodb://worker:mongo-secret@db.example.test/jobs now',
  })).toEqual({
    github: '[REDACTED]',
    stripeLive: '[REDACTED]',
    stripeTest: '[REDACTED]',
    DATABASE_URL: '[REDACTED]',
    message: 'connect mongodb://[REDACTED]@db.example.test/jobs now',
  });
});

it('replaces binary containers instead of expanding their bytes', () => {
  expect(redactValue({
    buffer: Buffer.from('secret-bytes'),
    bytes: new Uint8Array([115, 101, 99, 114, 101, 116]),
    view: new DataView(new Uint8Array([1, 2, 3]).buffer),
  })).toEqual({
    buffer: '[REDACTED_BINARY]',
    bytes: '[REDACTED_BINARY]',
    view: '[REDACTED_BINARY]',
  });
});

it('does not redact safe keys that only contain sensitive substrings', () => {
  expect(redactValue({
    tokenCount: 42,
    secretary: 'Ada',
    cookiePolicy: 'strict',
  })).toEqual({
    tokenCount: 42,
    secretary: 'Ada',
    cookiePolicy: 'strict',
  });
});

it('redacts explicit compound credential field names', () => {
  expect(redactValue({
    sessionToken: 'opaque-session-value',
    githubToken: 'opaque-github-value',
    apiToken: 'opaque-api-value',
    privateKey: 'opaque-private-material',
    authorizationHeader: 'Basic dXNlcjpwYXNz',
  })).toEqual({
    sessionToken: '[REDACTED]',
    githubToken: '[REDACTED]',
    apiToken: '[REDACTED]',
    privateKey: '[REDACTED]',
    authorizationHeader: '[REDACTED]',
  });
});
