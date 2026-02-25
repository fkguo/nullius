/**
 * M-14a: Log redaction layer.
 *
 * Pure function that redacts sensitive patterns from text.
 * Designed for use in logging pipelines — no async, no side effects.
 */

// Patterns ordered from most specific to least specific.
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys: sk-..., key-..., Bearer tokens
  { pattern: /\b(sk-)[a-zA-Z0-9]{20,}/g, replacement: '$1***' },
  { pattern: /\b(key-)[a-zA-Z0-9]{20,}/g, replacement: '$1***' },
  { pattern: /(Bearer\s+)[a-zA-Z0-9._\-]{20,}/gi, replacement: '$1***' },

  // Generic long hex/alphanumeric tokens (e.g. API keys without prefix)
  { pattern: /\b(api[_-]?key[=: ]+)[a-zA-Z0-9]{16,}/gi, replacement: '$1***' },

  // User home directory paths
  { pattern: /\/Users\/[^/\s]+\//g, replacement: '/Users/<redacted>/' },
  { pattern: /\/home\/[^/\s]+\//g, replacement: '/home/<redacted>/' },
  { pattern: /C:\\Users\\[^\\]+\\/gi, replacement: 'C:\\Users\\<redacted>\\' },
];

/**
 * Redact sensitive patterns from text.
 *
 * @param text - Input text (e.g. log message, error message).
 * @returns Text with sensitive values replaced by `***` or `<redacted>`.
 */
export function redact(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}
