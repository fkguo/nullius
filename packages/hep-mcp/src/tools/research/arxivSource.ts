/**
 * arXiv Source Tool
 * Provides access to arXiv paper metadata and source files
 *
 * arXiv API Reference: https://arxiv.org/help/api/user-manual
 * - Query endpoint: https://export.arxiv.org/api/query
 * - Source URL: https://export.arxiv.org/src/{arxiv_id}
 * - PDF URL: https://export.arxiv.org/pdf/{arxiv_id}
 */

import * as api from '../../api/client.js';
import { arxivFetch } from '../../api/rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';
const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ArxivSourceParams {
  /** Paper identifier: INSPIRE recid, arXiv ID, or DOI */
  identifier: string;
}

export interface ArxivMetadata {
  /** arXiv ID (e.g., "2301.12345" or "hep-th/0601001") */
  arxiv_id: string;
  /** Paper title */
  title: string;
  /** Authors list */
  authors: string[];
  /** Abstract */
  abstract?: string;
  /** Primary category (e.g., "hep-th") */
  primary_category?: string;
  /** All categories */
  categories?: string[];
  /** Published date */
  published?: string;
  /** Last updated date */
  updated?: string;
  /** Author comment (e.g., "15 pages, 3 figures") */
  comment?: string;
  /** Journal reference if published */
  journal_ref?: string;
  /** DOI if available */
  doi?: string;
}

export interface ArxivSourceResult {
  /** arXiv metadata */
  metadata: ArxivMetadata;
  /** Source download URL (tar.gz) */
  source_url: string;
  /** PDF URL */
  pdf_url: string;
  /** Abstract page URL */
  abs_url: string;
  /** HTML version URL (if available) */
  html_url?: string;
  /** Source availability status */
  source_available: boolean;
  /** Source format hint from comment */
  source_hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract arXiv ID from various formats
 * @exported for use by downloadUrls.ts
 */
export function normalizeArxivId(id: string): string | null {
  // Remove version suffix for consistency
  const stripVersion = (s: string) => s.replace(/v\d+$/, '');

  // New format: 2301.12345 or 2301.12345v1
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) {
    return stripVersion(id);
  }

  // Old format: hep-th/0601001 or quant-ph/0201082v1
  if (/^[a-z-]+\/\d{7}(v\d+)?$/i.test(id)) {
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

/**
 * Parse arXiv API Atom feed response
 */
function parseArxivAtomEntry(xml: string): ArxivMetadata | null {
  // Simple XML parsing for arXiv Atom feed
  const getTag = (tag: string): string | undefined => {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return match ? match[1].trim() : undefined;
  };

  // Extract entry ID to get arXiv ID
  const entryId = getTag('id');
  if (!entryId) return null;

  const arxivIdMatch = entryId.match(/arxiv\.org\/abs\/(.+)/);
  if (!arxivIdMatch) return null;

  const arxiv_id = arxivIdMatch[1];

  // Extract authors
  const authorMatches = xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/gi);
  const authors = Array.from(authorMatches).map(m => m[1].trim());

  // Extract categories
  const categoryMatches = xml.matchAll(/category[^>]*term="([^"]+)"/gi);
  const categories = Array.from(categoryMatches).map(m => m[1]);

  // Extract primary category
  const primaryMatch = xml.match(/arxiv:primary_category[^>]*term="([^"]+)"/i);
  const primary_category = primaryMatch ? primaryMatch[1] : categories[0];

  return {
    arxiv_id,
    title: getTag('title')?.replace(/\s+/g, ' ') || 'Unknown',
    authors,
    abstract: getTag('summary')?.replace(/\s+/g, ' '),
    primary_category,
    categories,
    published: getTag('published'),
    updated: getTag('updated'),
    comment: getTag('arxiv:comment'),
    journal_ref: getTag('arxiv:journal_ref'),
    doi: getTag('arxiv:doi'),
  };
}

/**
 * Fetch paper metadata from arXiv API
 */
async function fetchArxivMetadata(arxivId: string): Promise<ArxivMetadata | null> {
  const url = `${ARXIV_API_BASE}?id_list=${encodeURIComponent(arxivId)}`;

  try {
    const response = await arxivFetch(url);
    if (!response.ok) {
      return null;
    }

    const xml = await response.text();

    // Check if we got results
    if (xml.includes('<opensearch:totalResults>0</opensearch:totalResults>')) {
      return null;
    }

    // Extract the entry
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) {
      return null;
    }

    return parseArxivAtomEntry(entryMatch[0]);
  } catch {
    return null; // Skip on error
  }
}

/**
 * Check if arXiv source is available
 * @exported for use by downloadUrls.ts
 */
export async function checkSourceAvailability(arxivId: string): Promise<boolean> {
  const sourceUrl = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;

  try {
    const response = await arxivFetch(sourceUrl, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false; // Skip on error
  }
}

/**
 * Resolve any identifier (recid, DOI, arXiv ID) to arXiv ID
 * @exported for use by paperContent.ts and other modules
 */
export async function resolveArxivId(identifier: string): Promise<string | null> {
  // Try direct normalization first
  const arxivId = normalizeArxivId(identifier);
  if (arxivId) return arxivId;

  // Look up via INSPIRE
  let query: string;
  const recidMatch = identifier.match(/^(?:inspire:)?(\d+)$/);
  if (recidMatch) {
    query = `recid:${recidMatch[1]}`;
  } else if (identifier.startsWith('10.')) {
    query = `doi:${identifier}`;
  } else {
    query = identifier;
  }

  const result = await api.search(query, { size: 1 });
  if (result.papers.length === 0) return null;

  return result.papers[0].arxiv_id ?? null;
}

/**
 * Extract source hint from comment (e.g., "15 pages, 3 figures, LaTeX")
 * @exported for use by downloadUrls.ts
 */
export function extractSourceHint(comment?: string): string | undefined {
  if (!comment) return undefined;

  const hints: string[] = [];

  // Check for common source indicators
  if (/latex/i.test(comment)) hints.push('LaTeX');
  if (/pdf/i.test(comment) && !/pdflatex/i.test(comment)) hints.push('PDF');
  if (/\d+\s*pages?/i.test(comment)) {
    const match = comment.match(/(\d+)\s*pages?/i);
    if (match) hints.push(`${match[1]} pages`);
  }
  if (/\d+\s*figures?/i.test(comment)) {
    const match = comment.match(/(\d+)\s*figures?/i);
    if (match) hints.push(`${match[1]} figures`);
  }
  if (/\d+\s*tables?/i.test(comment)) {
    const match = comment.match(/(\d+)\s*tables?/i);
    if (match) hints.push(`${match[1]} tables`);
  }

  return hints.length > 0 ? hints.join(', ') : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function getArxivSource(
  params: ArxivSourceParams
): Promise<ArxivSourceResult> {
  const { identifier } = params;

  // Step 1: Resolve identifier to arXiv ID using shared function
  const arxivId = await resolveArxivId(identifier);

  if (!arxivId) {
    throw new Error(`Could not resolve arXiv ID for: ${identifier}`);
  }

  // Step 2: Fetch metadata from arXiv API
  const metadata = await fetchArxivMetadata(arxivId);

  if (!metadata) {
    throw new Error(`Could not fetch arXiv metadata for: ${arxivId}`);
  }

  // Step 3: Check source availability
  const sourceAvailable = await checkSourceAvailability(arxivId);

  // Step 4: Build URLs
  const sourceUrl = `${ARXIV_EXPORT_BASE}/src/${arxivId}`;
  const pdfUrl = `${ARXIV_EXPORT_BASE}/pdf/${arxivId}.pdf`;
  const absUrl = `https://arxiv.org/abs/${arxivId}`;

  // Check for HTML version (ar5iv)
  const htmlUrl = `https://ar5iv.labs.arxiv.org/html/${arxivId}`;

  // Step 5: Extract source hint from comment
  const sourceHint = extractSourceHint(metadata.comment);

  return {
    metadata,
    source_url: sourceUrl,
    pdf_url: pdfUrl,
    abs_url: absUrl,
    html_url: htmlUrl,
    source_available: sourceAvailable,
    source_hint: sourceHint,
  };
}
