const SENSITIVE_KEY =
  /^(?:(?:[a-z0-9_-]*)(?:api[-_]?key|token|password|passwd|secret|cookie|private[-_]?key)|(?:proxy[-_]?)?authorization(?:[-_]?header)?|database[-_]?url|db[-_]?url)$/i;
const ENVIRONMENT_KEY = /^(?:env|environment)$/i;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ([^\r\n]*PRIVATE KEY[^\r\n]*?)-----[\s\S]*?-----END \1-----/gi;
const PRIVATE_KEY_REMAINDER =
  /-----BEGIN [^\r\n]*PRIVATE KEY[^\r\n]*?-----[\s\S]*/gi;
const CREDENTIAL_HEADER =
  /(^|[^A-Za-z0-9_-])((?:proxy-authorization|authorization|set-cookie|cookie|x-api-key|api-key|api_key)[ \t]*[:=][ \t]*)[^\r\n]*/gim;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PREFIXED_CREDENTIAL =
  /\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]+/g;
const URL_CREDENTIAL =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^:/@\s]+:[^/@\s]+@/gi;
const CLI_CREDENTIAL =
  /(^|[\s"'`])(-{1,2}[A-Za-z0-9_-]*(?:api[-_]?key|token|password|passwd|secret|cookie|private[-_]?key|authorization))(=|[ \t\r\n]+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s"'`])+/gim;

function redactString(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, '[REDACTED]')
    .replace(PRIVATE_KEY_REMAINDER, '[REDACTED]')
    .replace(CREDENTIAL_HEADER, '$1$2[REDACTED]')
    .replace(URL_CREDENTIAL, '$1[REDACTED]@')
    .replace(BEARER_CREDENTIAL, '[REDACTED]')
    .replace(PREFIXED_CREDENTIAL, '[REDACTED]')
    .replace(CLI_CREDENTIAL, '$1$2$3[REDACTED]');
}

function isSeparatedCliCredentialOption(value: string): boolean {
  if (!/^-{1,2}[^=]+$/u.test(value)) return false;
  return SENSITIVE_KEY.test(value.replace(/^-{1,2}/u, ''));
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
        const redacted: unknown[] = [];
        let redactNext = false;
        for (const item of value) {
          if (redactNext) {
            redacted.push('[REDACTED]');
            redactNext = false;
            continue;
          }
          redacted.push(redact(item, ancestors));
          redactNext = typeof item === 'string'
            && isSeparatedCliCredentialOption(item);
        }
        return redacted;
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
