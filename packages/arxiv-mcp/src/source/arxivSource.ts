/**
 * arXiv Source — ID normalization, metadata, and availability checking
 *
 * Domain-agnostic: no INSPIRE dependency.
 */

import { arxivFetch } from '../api/rateLimiter.js';
import { fetchArxivMetadata, type ArxivMetadata } from '../api/searchClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

/** Shared regex — used by BOTH ArxivIdSchema and normalizeArxivId (SSOT, §3.0) */
export const ARXIV_ID_REGEX = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[a-z-]+)?\/\d{7}(v\d+)?)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type { ArxivMetadata };

export interface ArxivSourceResult {
  metadata: ArxivMetadata;
  source_url: string;
  pdf_url: string;
  abs_url: string;
  html_url?: string;
  source_available: boolean;
  source_hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize various arXiv ID formats to a canonical form.
 * Returns null if the input is not a recognized arXiv ID format.
 *
 * Supports: bare IDs, arXiv URLs, `arXiv:` prefix.
 * Uses ARXIV_ID_REGEX as the single source of truth for bare ID validation.
 */
export function normalizeArxivId(id: string): string | null {
  const stripVersion = (s: string) => s.replace(/v\d+$/, '');

  // Try bare ID first (uses shared ARXIV_ID_REGEX — SSOT)
  if (ARXIV_ID_REGEX.test(id)) {
    return stripVersion(id);
  }

  // Extract from URL: https://arxiv.org/abs/2301.12345
  const urlMatch = id.match(/arxiv\.org\/(?:abs|pdf|src)\/([^\s?/]+)/i);
  if (urlMatch) {
    return stripVersion(urlMatch[1]);
  }

  // Extract from arXiv: prefix
  const prefixMatch = id.match(/^arXiv:(.+)$/i);
  if (prefixMatch) {
    return stripVersion(prefixMatch[1]);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Availability Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if arXiv source (LaTeX/tar.gz) is available via HEAD request.
 */
export async function checkSourceAvailability(arxivId: string): Promise<boolean> {
  const sourceUrl = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;

  try {
    const response = await arxivFetch(sourceUrl, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Hint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract source hint from author comment (e.g., "15 pages, 3 figures, LaTeX").
 */
export function extractSourceHint(comment?: string): string | undefined {
  if (!comment) return undefined;

  const hints: string[] = [];

  if (/latex/i.test(comment)) hints.push('LaTeX');
  if (/pdf/i.test(comment) && !/pdflatex/i.test(comment)) hints.push('PDF');

  const pages = comment.match(/(\d+)\s*pages?/i);
  if (pages) hints.push(`${pages[1]} pages`);

  const figures = comment.match(/(\d+)\s*figures?/i);
  if (figures) hints.push(`${figures[1]} figures`);

  const tables = comment.match(/(\d+)\s*tables?/i);
  if (tables) hints.push(`${tables[1]} tables`);

  return hints.length > 0 ? hints.join(', ') : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get Full arXiv Source Info
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get arXiv source info for a paper: metadata + URLs + availability.
 * The identifier must be a valid arXiv ID (use normalizeArxivId first).
 */
export async function getArxivSource(arxivId: string): Promise<ArxivSourceResult> {
  const metadata = await fetchArxivMetadata(arxivId);
  if (!metadata) {
    throw new Error(`Could not fetch arXiv metadata for: ${arxivId}`);
  }

  const sourceAvailable = await checkSourceAvailability(arxivId);

  return {
    metadata,
    source_url: `${ARXIV_EXPORT_BASE}/src/${arxivId}`,
    pdf_url: `${ARXIV_EXPORT_BASE}/pdf/${arxivId}.pdf`,
    abs_url: `https://arxiv.org/abs/${arxivId}`,
    html_url: `https://ar5iv.labs.arxiv.org/html/${arxivId}`,
    source_available: sourceAvailable,
    source_hint: extractSourceHint(metadata.comment),
  };
}
