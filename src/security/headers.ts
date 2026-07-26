const SENSITIVE_CREDENTIAL_SEGMENT =
  /(?:^|[-_])(?:(?:proxy[-_]?)?(?:authorization|auth)|(?:subscription|encryption)[-_]?key|token|secret|cookie|set[-_]?cookie)(?:$|[-_])/i;
const API_KEY_SUFFIX = /api[-_]?key(?:$|[-_])/i;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_CREDENTIAL_SEGMENT.test(name)
    || API_KEY_SUFFIX.test(name);
}
