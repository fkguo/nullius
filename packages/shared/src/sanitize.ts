/**
 * H-08: Input sanitization utilities.
 *
 * Shared across TS packages for path, filename, and query string sanitization.
 */

/**
 * Sanitize a file path by rejecting path traversal attempts.
 *
 * @throws {Error} if the path contains `..` segments or null bytes.
 */
export function sanitizePath(input: string): string {
  if (input.includes('\0')) {
    throw new Error('UNSAFE_PATH: path contains null byte');
  }
  // Normalize separators for cross-platform checks.
  const normalized = input.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`UNSAFE_PATH: path contains traversal segment: ${input}`);
    }
  }
  return input;
}

/**
 * Sanitize a filename by stripping unsafe characters.
 *
 * Allows only alphanumeric, hyphen, underscore, dot, and space.
 * Rejects empty results and names starting with dot.
 *
 * @throws {Error} if the sanitized filename is empty or starts with dot.
 */
export function sanitizeFilename(input: string): string {
  if (input.includes('\0')) {
    throw new Error('UNSAFE_FILENAME: filename contains null byte');
  }
  // Strip path separators.
  let name = input.replace(/[\\/]/g, '');
  // Strip control characters and other unsafe chars.
  name = name.replace(/[^\w\s.\-]/g, '');
  name = name.trim();
  if (!name) {
    throw new Error(`UNSAFE_FILENAME: sanitized filename is empty (input: ${input})`);
  }
  if (name.startsWith('.')) {
    throw new Error(`UNSAFE_FILENAME: filename starts with dot: ${name}`);
  }
  return name;
}

/**
 * Sanitize a query string for use in INSPIRE fulltext searches.
 *
 * Escapes double quotes, strips control characters, and limits length.
 */
export function sanitizeQueryString(input: string, maxLength = 500): string {
  // Strip null bytes and control characters (except common whitespace).
  let cleaned = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Escape double quotes to prevent query injection.
  cleaned = cleaned.replace(/"/g, '\\"');
  // Truncate to max length.
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
  }
  return cleaned.trim();
}
