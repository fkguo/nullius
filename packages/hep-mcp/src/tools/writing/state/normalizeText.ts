/**
 * LaTeX text normalization with placeholder method
 *
 * Handles tricky cases like:
 * - \% (escaped percent, should NOT be treated as comment)
 * - \\% (double backslash followed by percent comment, SHOULD be treated as comment)
 *
 * Uses Unicode Private Use Area characters as placeholders to avoid regex complexity.
 */

// Unicode Private Use Area characters for placeholders
const ESCAPED_PERCENT = '\uE000';  // Placeholder for \%
const DOUBLE_BACKSLASH = '\uE001'; // Placeholder for \\

/**
 * Normalize LaTeX text for consistent processing
 *
 * Operations:
 * 1. Normalize line endings
 * 2. Protect double backslash (\\)
 * 3. Protect escaped percent (\%)
 * 4. Remove % comments
 * 5. Restore protected sequences
 * 6. Normalize whitespace
 *
 * @param text - LaTeX text to normalize
 * @returns Normalized text
 *
 * @example
 * // Preserves escaped percent
 * normalizeText('90\\% efficiency') // => '90\\% efficiency'
 *
 * @example
 * // Removes comment after double backslash
 * normalizeText('line end \\\\% comment') // => 'line end \\\\'
 *
 * @example
 * // Removes regular comment
 * normalizeText('text % comment') // => 'text'
 */
export function normalizeText(text: string): string {
  return text
    // Step 1: Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

    // Step 2: Protect double backslash (must come before Step 3)
    .replace(/\\\\/g, DOUBLE_BACKSLASH)

    // Step 3: Protect escaped percent
    .replace(/\\%/g, ESCAPED_PERCENT)

    // Step 4: Remove % comments (now safe since \% is protected)
    .replace(/%[^\n]*/g, '')

    // Step 5: Restore protected sequences
    .replace(new RegExp(ESCAPED_PERCENT, 'g'), '\\%')
    .replace(new RegExp(DOUBLE_BACKSLASH, 'g'), '\\\\')

    // Step 6: Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')

    // Step 7: Normalize LaTeX spacing commands
    .replace(/\\,/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')

    // Step 8: Trim
    .trim();
}

/**
 * Normalize text and compute a hash for change detection
 *
 * @param text - LaTeX text
 * @returns Object containing normalized text and hash
 */
export function normalizeTextWithHash(text: string): {
  normalized: string;
  hash: string;
} {
  const normalized = normalizeText(text);
  const hash = computeSimpleHash(normalized);
  return { normalized, hash };
}

/**
 * Simple string hash for change detection
 * NOT cryptographically secure - just for quick comparison
 */
function computeSimpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Check if text contains significant changes after normalization
 *
 * @param oldText - Previous text
 * @param newText - New text
 * @returns True if content differs after normalization
 */
export function hasContentChanged(oldText: string, newText: string): boolean {
  return normalizeText(oldText) !== normalizeText(newText);
}
