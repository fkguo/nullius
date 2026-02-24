/**
 * Download URLs Tool
 * Returns download URLs for a paper without side effects
 *
 * This is a lightweight tool that only generates URLs and optionally checks availability,
 * without fetching full arXiv metadata.
 */

import * as api from '../../api/client.js';
import {
  normalizeArxivId,
  checkSourceAvailability,
} from './arxivSource.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tri-state source availability probe result:
 * - `true`  => source is available
 * - `false` => source is unavailable
 * - `null`  => not checked
 */
export type SourceAvailability = boolean | null;

export interface GetDownloadUrlsParams {
  /** Paper identifier: INSPIRE recid, arXiv ID, or DOI */
  identifier: string;
  /** Whether to check source availability via HEAD request (default: false) */
  check_availability?: boolean;
}

export interface GetDownloadUrlsResult {
  /** Resolved arXiv ID (if available) */
  arxiv_id?: string;
  /** LaTeX source URL (tar.gz) */
  arxiv_source?: string;
  /** PDF URL */
  arxiv_pdf?: string;
  /** Abstract page URL */
  arxiv_abs?: string;
  /** HTML version URL (ar5iv) */
  arxiv_html?: string;
  /** DOI URL */
  doi_url?: string;
  /** INSPIRE page URL */
  inspire_url?: string;
  /**
   * Whether LaTeX source is available.
   *
   * Backward-compat alias:
   * - `true`  => `source_available === true`
   * - `false` => `source_available !== true` (either not checked, or unavailable)
   */
  has_source: boolean;
  /** Availability probe result. `null` means not checked. */
  source_available: SourceAvailability;
  /** Source format hint from arXiv comment */
  source_hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function getDownloadUrls(
  params: GetDownloadUrlsParams
): Promise<GetDownloadUrlsResult> {
  const { identifier, check_availability = false } = params;

  // Step 1: Try to normalize as arXiv ID directly
  let arxivId = normalizeArxivId(identifier);
  let recid: string | undefined;
  let doi: string | undefined;

  // Step 2: If not arXiv ID, look up via INSPIRE
  if (!arxivId) {
    let query: string;
    if (/^\d+$/.test(identifier)) {
      // Pure digits = recid
      query = `recid:${identifier}`;
      recid = identifier;
    } else if (identifier.startsWith('10.')) {
      // Starts with 10. = DOI
      query = `doi:${identifier}`;
      doi = identifier;
    } else {
      // Generic search
      query = identifier;
    }

    const result = await api.search(query, { size: 1 });

    if (result.papers.length === 0) {
      // Paper not found, return minimal result
      return {
        has_source: false,
        source_available: null,
        doi_url: doi ? `https://doi.org/${doi}` : undefined,
      };
    }

    const paper = result.papers[0];
    recid = paper.recid;
    arxivId = paper.arxiv_id ?? null;
    doi = paper.doi;
  }

  // Step 3: Build result
  const result: GetDownloadUrlsResult = {
    has_source: false,
    source_available: null,
  };

  // Add INSPIRE URL if we have recid
  if (recid) {
    result.inspire_url = `https://inspirehep.net/literature/${recid}`;
  }

  // Add DOI URL if available
  if (doi) {
    result.doi_url = `https://doi.org/${doi}`;
  }

  // Step 4: If we have arXiv ID, build arXiv URLs and check source availability
  if (arxivId) {
    result.arxiv_id = arxivId;
    result.arxiv_source = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;
    result.arxiv_pdf = `${ARXIV_EXPORT_BASE}/pdf/${arxivId}.pdf`;
    result.arxiv_abs = `https://arxiv.org/abs/${arxivId}`;
    result.arxiv_html = `https://ar5iv.labs.arxiv.org/html/${arxivId}`;

    // Check if source is available (only if requested)
    if (check_availability) {
      const available = await checkSourceAvailability(arxivId);
      result.source_available = available;
      result.has_source = available;
    }

    // Try to get source hint from arXiv metadata (lightweight check)
    // We skip this for now to keep the tool fast - use inspire_get_arxiv_source for full metadata
  }

  return result;
}
