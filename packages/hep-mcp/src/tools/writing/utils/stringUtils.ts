/**
 * Shared string utilities for writing tools
 */

/**
 * Escape special regex characters in a string
 * Used for safe regex replacement of recids and other dynamic values
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
