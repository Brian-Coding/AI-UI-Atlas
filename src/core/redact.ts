const REDACTED = '<redacted-token>';
const HEADER_NAME = /^(?:x-atlas-qa-token|(?:proxy-)?authorization)$/i;
// Covers shell headers, HTTP diagnostics and quoted JSON/JS header pairs.
// Quoted values can contain spaces (e.g. Basic/Bearer/Digest credentials).
const HEADER_VALUE = /(\b(?:x-atlas-qa-token|(?:proxy-)?authorization)(?:\\?["'])?\s*[:=]\s*)(\\"(?:[^"\\\r\n]|\\(?!"))*\\"|"[^"\r\n]*"|'[^'\r\n]*'|(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"'`,;\\}\]]+)/gi;

/** Redact before truncating, summarizing, logging, or persisting provider data. */
export function redactSecrets(text: string, values: readonly string[] = []): string {
  for (const value of values) if (value) text = text.split(value).join(REDACTED);
  return text.replace(HEADER_VALUE, (_match, prefix: string, value: string) => {
    const quote = value.startsWith('\\"') ? '\\"' : /^["']/.test(value) ? value[0]! : '';
    return `${prefix}${quote}${REDACTED}${quote}`;
  });
}

/** Preserve JSON types/escaping, including structured header maps. */
export function redactData<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map(item => redactData(item, secrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactSecrets(key, secrets), HEADER_NAME.test(key) ? REDACTED : redactData(item, secrets),
    ])) as T;
  }
  return value;
}
