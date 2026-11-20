/**
 * Automatic secret redaction scrubber (spec §8C).
 *
 * Mandatory middleware concept: tokens, Bearer headers and passwords must be
 * stripped from execution logs, error traces, WebSockets and AI prompts
 * before storage or display. `redact` deep-clones a value and replaces the
 * values of sensitive keys (and common token patterns inside strings) with
 * "[REDACTED]". `redactString` scrubs a single log line / free-text string.
 *
 * The input is never mutated.
 */

export const REDACTED = '[REDACTED]';

/**
 * Key names (normalized: lowercased, non-alphanumerics removed) whose values
 * are always replaced wholesale.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'authtoken',
  'bearertoken',
  'secret',
  'clientsecret',
  'appsecret',
  'webhooksecret',
  'signingsecret',
  'apikey',
  'apisecret',
  'privatekey',
  'masterkey',
  'encryptionkey',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'session',
  'sessionid',
  'credential',
  'credentials',
  'totpsecret',
  'otp',
  'pin',
  'cvv',
  'cardnumber',
  'creditcard',
  'ssn',
  'dek',
  'wrappeddek',
]);

/** Substrings that mark a key as sensitive even in compound names. */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'apikey',
  'token',
  'authorization',
  'cookie',
  'privatekey',
  'masterkey',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/**
 * Patterns scrubbed out of free-text strings. Each entry replaces the
 * captured secret portion (group 1 where present, else the whole match).
 */
const STRING_PATTERNS: Array<{ regex: RegExp; replace: (m: RegExpExecArray) => string }> = [
  {
    // Authorization: Bearer <token> / Basic <base64>
    regex: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
    replace: (m) => `${m[1]} ${REDACTED}`,
  },
  {
    // key=value / key: value pairs for sensitive keys inside text
    regex:
      /\b(password|passwd|pwd|passphrase|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|api[_-]?secret|authorization|cookie|private[_-]?key|master[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|(?!Bearer\s|Basic\s)[^\s,;}&"']+)/giu,
    replace: (m) => `${m[1]}${m[2]}${REDACTED}`,
  },
  {
    // Credentials embedded in URLs: scheme://user:pass@host
    regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/giu,
    replace: (m) => `${m[1]}${REDACTED}@`,
  },
  {
    // JWTs (three base64url segments, header starts with eyJ)
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
    replace: () => REDACTED,
  },
  {
    // GitHub tokens (classic + fine-grained)
    regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
    replace: () => REDACTED,
  },
  {
    // OpenAI / Anthropic style keys
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/gu,
    replace: () => REDACTED,
  },
  {
    // AWS access key IDs
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replace: () => REDACTED,
  },
  {
    // Google API keys
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/gu,
    replace: () => REDACTED,
  },
  {
    // Slack tokens
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
    replace: () => REDACTED,
  },
];

/** Scrub secrets out of a single string (log line, error message, prompt). */
export function redactString(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  for (const { regex, replace } of STRING_PATTERNS) {
    out = out.replace(regex, (...args: unknown[]) => {
      // Rebuild a minimal RegExpExecArray-like view for the replacer.
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const fake = [match, ...groups] as unknown as RegExpExecArray;
      return replace(fake);
    });
  }
  return out;
}

export interface RedactOptions {
  /** Replacement string (default "[REDACTED]"). */
  replacement?: string;
  /** Additional key names to treat as sensitive. */
  extraKeys?: Iterable<string>;
}

/**
 * Deep-clone `value`, replacing sensitive-key values and in-string token
 * patterns with "[REDACTED]". Handles plain objects, arrays, strings,
 * Errors (message + stack + own enumerable props), Dates and primitives.
 * Circular references become the string "[Circular]".
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const replacement = options.replacement ?? REDACTED;
  const extra = new Set(
    [...(options.extraKeys ?? [])].map((k) => k.toLowerCase().replace(/[^a-z0-9]/gu, '')),
  );
  const keyIsSensitive = (key: string): boolean =>
    isSensitiveKey(key) ||
    extra.has(key.toLowerCase().replace(/[^a-z0-9]/gu, ''));
  const scrubString = (s: string): string =>
    replacement === REDACTED ? redactString(s) : redactString(s).split(REDACTED).join(replacement);

  const seen = new WeakSet<object>();
  const walk = (val: unknown): unknown => {
    if (typeof val === 'string') return scrubString(val);
    if (val === null || typeof val !== 'object') return val;
    if (val instanceof Date) return new Date(val.getTime());
    if (seen.has(val)) return '[Circular]';
    seen.add(val);
    try {
      if (Array.isArray(val)) {
        return val.map((item) => walk(item));
      }
      if (val instanceof Error) {
        const clone = new Error(scrubString(val.message));
        clone.name = val.name;
        if (val.stack) clone.stack = scrubString(val.stack);
        for (const [k, v] of Object.entries(val)) {
          (clone as unknown as Record<string, unknown>)[k] = keyIsSensitive(k)
            ? replacement
            : walk(v);
        }
        return clone;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = keyIsSensitive(k) ? replacement : walk(v);
      }
      return out;
    } finally {
      seen.delete(val);
    }
  };

  return walk(value) as T;
}
