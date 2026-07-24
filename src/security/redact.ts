const SENSITIVE_KEY = /authorization|api[-_]?key|token|password|secret|cookie/i;
const ENVIRONMENT_KEY = /^(?:env|environment)$/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const PRIVATE_KEY_REMAINDER =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/g;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PREFIXED_CREDENTIAL = /\b(?:sk-|ghp_)[A-Za-z0-9_-]+/g;

function redactString(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED]')
    .replace(PRIVATE_KEY_REMAINDER, '[REDACTED]')
    .replace(BEARER_CREDENTIAL, '[REDACTED]')
    .replace(PREFIXED_CREDENTIAL, '[REDACTED]');
}

function redact(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) return '[CIRCULAR]';
    ancestors.add(value);

    try {
      if (Array.isArray(value)) {
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
