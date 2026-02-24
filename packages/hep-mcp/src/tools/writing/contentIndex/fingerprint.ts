/**
 * Fingerprint Generation Utilities
 * Generates stable hashes for evidence tracking
 */

import { createHash } from 'crypto';

/**
 * Normalize whitespace in text for consistent hashing
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a stable hash for content
 * Uses SHA-256 truncated to 16 characters for readability
 */
export function stableHash(content: string): string {
  const hash = createHash('sha256')
    .update(content)
    .digest('hex');
  return hash.substring(0, 16);
}

/**
 * Generate fingerprint for any content
 */
export function generateFingerprint(content: string): string {
  return stableHash(normalizeWhitespace(content));
}

/**
 * Generate evidence ID following the pattern:
 * stableHash(paper_id + kind + (label ?? number ?? locator.latex_line ?? first8(fingerprint)))
 */
export function generateEvidenceId(
  paperId: string,
  kind: string,
  identifier: string | number | undefined,
  fingerprint: string
): string {
  const idPart = identifier?.toString() ?? fingerprint.substring(0, 8);
  const combined = `${paperId}:${kind}:${idPart}`;
  return stableHash(combined);
}
