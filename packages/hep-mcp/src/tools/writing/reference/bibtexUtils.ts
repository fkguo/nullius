/**
 * BibTeX key extraction utilities
 *
 * Extracts citation keys from INSPIRE BibTeX entries,
 * handling edge cases like @comment, @preamble, BOM, etc.
 */

/**
 * Extract the citation key from a BibTeX string
 *
 * Strategy:
 * 1. Remove BOM if present
 * 2. Skip @comment, @preamble, @string entries
 * 3. Find first valid entry and extract its key
 *
 * @param bibtex - Raw BibTeX content
 * @returns Citation key or null if not found
 *
 * @example
 * extractKeyFromBibtex('@article{Guo:2017jvc, title={...}}')
 * // => 'Guo:2017jvc'
 *
 * @example
 * extractKeyFromBibtex('@comment{...}\n@article{Real:2020, ...}')
 * // => 'Real:2020'
 */
export function extractKeyFromBibtex(bibtex: string): string | null {
  // Remove BOM (Byte Order Mark)
  const cleaned = bibtex.replace(/^\uFEFF/, '').trim();

  if (!cleaned) {
    return null;
  }

  // Regex to match BibTeX entries: @type{key,
  // Captures: [1] = entry type, [2] = key
  const entryRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;

  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(cleaned)) !== null) {
    const entryType = match[1].toLowerCase();

    // Skip special BibTeX directives
    if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') {
      continue;
    }

    // Found a valid entry
    const key = match[2].trim();

    // Validate key format (should not be empty or contain invalid chars)
    if (key && /^[a-zA-Z0-9:._-]+$/.test(key)) {
      return key;
    }
  }

  return null;
}

/**
 * Validate a BibTeX key format
 *
 * Valid keys contain only: letters, digits, colon, period, underscore, hyphen
 */
export function isValidBibtexKey(key: string): boolean {
  return /^[a-zA-Z0-9:._-]+$/.test(key);
}

/**
 * Generate a fallback citation key from INSPIRE recid
 */
export function generateFallbackKey(recid: string): string {
  return `INSPIRE_${recid}`;
}

/**
 * Check if a key is a fallback key (generated, not from INSPIRE)
 */
export function isFallbackKey(key: string): boolean {
  return key.startsWith('INSPIRE_');
}
