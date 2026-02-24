/**
 * Shared utility functions for LaTeX preprocessing
 */

/**
 * Get line number at character position (1-based)
 */
export function getLineAtPosition(content: string, position: number): number {
  const beforePos = content.substring(0, position);
  return (beforePos.match(/\n/g) || []).length + 1;
}

/**
 * Count lines in a string
 */
export function countLines(str: string): number {
  if (!str) return 0;
  return (str.match(/\n/g) || []).length + 1;
}

/**
 * Remove LaTeX comments from content
 * Preserves line structure (replaces comment with empty string)
 */
export function stripComments(content: string): string {
  // Match % not preceded by \ (unescaped percent)
  return content.replace(/(?<!\\)%.*$/gm, '');
}

/**
 * Clean MathML and HTML tags from text, converting to readable format.
 * Handles INSPIRE API's MathML-formatted abstracts.
 */
export function cleanMathML(text: string): string {
  let cleaned = text;

  // Step 1: Extract text content from MathML elements (preserve order)
  // Handle mml:mi, mml:mn, mml:mo, mml:mtext - extract inner text
  cleaned = cleaned.replace(/<mml:(mi|mn|mo|mtext)[^>]*>([^<]*)<\/mml:\1>/g, '$2');

  // Step 2: Handle subscripts and superscripts
  cleaned = cleaned.replace(/<mml:msup[^>]*>.*?<\/mml:msup>/gs, (match) => {
    const content = match.replace(/<[^>]+>/g, '');
    return content.length > 0 ? `^{${content}}` : '';
  });
  cleaned = cleaned.replace(/<mml:msub[^>]*>.*?<\/mml:msub>/gs, (match) => {
    const content = match.replace(/<[^>]+>/g, '');
    return content.length > 0 ? `_{${content}}` : '';
  });

  // Step 3: Remove all remaining MathML tags (aggressive cleanup)
  cleaned = cleaned.replace(/<\/?mml:[^>]*>/g, '');

  // Step 4: Remove inline-formula and other HTML wrappers
  cleaned = cleaned.replace(/<\/?inline-formula>/g, '');
  cleaned = cleaned.replace(/<\/?p>/g, '');

  // Step 5: Remove any remaining HTML/XML tags
  cleaned = cleaned.replace(/<[^>]+>/g, '');

  // Step 6: Clean up whitespace and formatting
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/→/g, ' → ')
    .replace(/±/g, ' ± ')
    .trim();

  return cleaned;
}
