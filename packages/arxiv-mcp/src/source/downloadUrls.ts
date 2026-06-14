/**
 * Download URLs — arXiv-only URL construction (no INSPIRE)
 *
 * Lightweight tool that generates URLs and optionally checks availability,
 * without fetching full metadata.
 */

import { normalizeArxivId, checkSourceAvailability } from './arxivSource.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Source/PDF download URLs point at the main `arxiv.org` site; the
// `export.arxiv.org` API mirror truncates large source archives at a ~2 MiB
// boundary. See rateLimiter ARXIV_ALLOWED_HOSTS.
const ARXIV_DOWNLOAD_BASE = 'https://arxiv.org';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Tri-state: true=available, false=unavailable, null=not checked */
export type SourceAvailability = boolean | null;

export interface GetDownloadUrlsParams {
  identifier: string;
  check_availability?: boolean;
}

export interface GetDownloadUrlsResult {
  arxiv_id?: string;
  arxiv_source?: string;
  arxiv_pdf?: string;
  arxiv_abs?: string;
  arxiv_html?: string;
  has_source: boolean;
  source_available: SourceAvailability;
  source_hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get download URLs for an arXiv paper.
 * Domain-agnostic: only normalizes arXiv IDs (no INSPIRE fallback).
 */
export async function getDownloadUrls(
  params: GetDownloadUrlsParams
): Promise<GetDownloadUrlsResult> {
  const { identifier, check_availability = false } = params;

  const arxivId = normalizeArxivId(identifier);

  if (!arxivId) {
    return { has_source: false, source_available: null };
  }

  const result: GetDownloadUrlsResult = {
    arxiv_id: arxivId,
    arxiv_source: `${ARXIV_DOWNLOAD_BASE}/e-print/${arxivId}`,
    arxiv_pdf: `${ARXIV_DOWNLOAD_BASE}/pdf/${arxivId}`,
    arxiv_abs: `https://arxiv.org/abs/${arxivId}`,
    arxiv_html: `https://ar5iv.labs.arxiv.org/html/${arxivId}`,
    has_source: false,
    source_available: null,
  };

  if (check_availability) {
    const available = await checkSourceAvailability(arxivId);
    result.source_available = available;
    result.has_source = available;
  }

  return result;
}
