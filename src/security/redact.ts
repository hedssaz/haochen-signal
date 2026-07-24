const SENSITIVE_KEY =
  /^(?:(?:[a-z0-9_-]*)(?:api[-_]?key|token|password|passwd|secret|cookie|private[-_]?key)|(?:proxy[-_]?)?authorization(?:[-_]?header)?|database[-_]?url|db[-_]?url)$/i;
const ENVIRONMENT_KEY = /^(?:env|environment)$/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const PRIVATE_KEY_REMAINDER =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/g;
const AUTHORIZATION_HEADER =
  /\b(Authorization\s*:\s*)(?:Basic|Bearer)\s+[^\s,;]+/gi;
const API_KEY_HEADER = /\b((?:X-API-Key|Api-Key)\s*:\s*)[^\s,;]+/gi;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PREFIXED_CREDENTIAL =
  /\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]+/g;
const URL_CREDENTIAL =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^:/@\s]+:[^/@\s]+@/gi;

function redactString(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED]')
    .replace(PRIVATE_KEY_REMAINDER, '[REDACTED]')
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(API_KEY_HEADER, '$1[REDACTED]')
    .replace(URL_CREDENTIAL, '$1[REDACTED]@')
    .replace(BEARER_CREDENTIAL, '[REDACTED]')
    .replace(PREFIXED_CREDENTIAL, '[REDACTED]');
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value)
    || value instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined'
      && value instanceof SharedArrayBuffer);
}

function redact(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value !== null && typeof value === 'object') {
    if (isBinary(value)) return '[REDACTED_BINARY]';
    if (ancestors.has(value)) return '[CIRCULAR]';
    ancestors.add(value);

    try {
      if (Array.isArray(value)) {
        if (value.length === 2
          && typeof value[0] === 'string'
          && SENSITIVE_KEY.test(value[0])) {
          return [value[0], '[REDACTED]'];
        }
        return value.map((item) => redact(item, ancestors));
      }

      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          SENSITIVE_KEY.test(key) || ENVIRONMENT_KEY.test(key)
            ? '[REDACTED]'
            : redact(item, ancestors),
        ]),
      );
    } finally {
      ancestors.delete(value);
    }
  }

  return value;
}

export function redactValue(value: unknown): unknown {
  return redact(value, new WeakSet());
}
