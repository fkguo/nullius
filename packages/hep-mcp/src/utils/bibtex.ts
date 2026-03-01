/**
 * BibTeX key extraction utilities.
 *
 * Extracted from tools/writing/reference/bibtexUtils.ts for use by KEEP modules
 * (registry.ts inspire_resolve_citekey handler) without depending on the writing pipeline.
 */

/**
 * Extract the citation key from a BibTeX string.
 *
 * Strategy:
 * 1. Remove BOM if present
 * 2. Skip @comment, @preamble, @string entries
 * 3. Find first valid entry and extract its key
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
