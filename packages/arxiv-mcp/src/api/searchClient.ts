/**
 * arXiv Atom API Search Client
 *
 * Queries the arXiv API (https://export.arxiv.org/api/query) and parses
 * Atom XML responses into structured metadata.
 *
 * Reference: https://arxiv.org/help/api/user-manual
 */

import { arxivFetch } from './rateLimiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ArxivMetadata {
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract?: string;
  primary_category?: string;
  categories?: string[];
  published?: string;
  updated?: string;
  comment?: string;
  journal_ref?: string;
  doi?: string;
}

export interface ArxivSearchResult {
  total_results: number;
  start: number;
  entries: ArxivMetadata[];
}

export interface SearchParams {
  query: string;
  categories?: string[];
  max_results?: number;
  start?: number;
  date_from?: string;
  date_to?: string;
  sort_by?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Normalization (§7a, §7g)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a query string that may contain pre-encoded characters.
 * Treats input as raw unencoded text: replace `+` with spaces, apply
 * tolerant `decodeURIComponent`, then trim.
 */
function normalizeQuery(raw: string): string {
  const plusNormalized = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plusNormalized).trim();
  } catch {
    return plusNormalized.trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildSearchUrl(params: SearchParams): string {
  const {
    query,
    categories,
    max_results = 10,
    start = 0,
    date_from,
    date_to,
    sort_by = 'relevance',
  } = params;

  const normalized = normalizeQuery(query);

  // Build search_query parts
  const parts: string[] = [];

  // Main query
  if (categories && categories.length > 0) {
    const catFilter = categories.map(c => `cat:${c}`).join(' OR ');
    parts.push(`(${normalized}) AND (${catFilter})`);
  } else {
    parts.push(normalized);
  }

  // Date range filter
  if (date_from || date_to) {
    const from = date_from ?? '00000000';
    const to = date_to ?? '99999999';
    parts.push(`submittedDate:[${from} TO ${to}]`);
  }

  const searchQuery = parts.join(' AND ');

  // Sort mapping
  const sortMap: Record<string, string> = {
    relevance: 'relevance',
    lastUpdatedDate: 'lastUpdatedDate',
    submittedDate: 'submittedDate',
  };

  // Build URL manually (not URLSearchParams) to control encoding (§7a)
  const encodedQuery = encodeURIComponent(searchQuery);
  const sortParam = sortMap[sort_by] ?? 'relevance';

  return `${ARXIV_API_BASE}?search_query=${encodedQuery}&start=${start}&max_results=${max_results}&sortBy=${sortParam}&sortOrder=descending`;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML Parsing (§7b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse arXiv API Atom feed entry into ArxivMetadata.
 * Uses battle-tested regex patterns ported from hep-mcp.
 */
export function parseArxivAtomEntry(xml: string): ArxivMetadata | null {
  const getTag = (tag: string): string | undefined => {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return match ? match[1].trim() : undefined;
  };

  const entryId = getTag('id');
  if (!entryId) return null;

  const arxivIdMatch = entryId.match(/arxiv\.org\/abs\/(.+)/);
  if (!arxivIdMatch) return null;

  const arxiv_id = arxivIdMatch[1];

  const authorMatches = xml.matchAll(/<author>\s*<name>([^<]+)<\/name>/gi);
  const authors = Array.from(authorMatches).map(m => m[1].trim());

  const categoryMatches = xml.matchAll(/category[^>]*term="([^"]+)"/gi);
  const categories = Array.from(categoryMatches).map(m => m[1]);

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

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search the arXiv API and return parsed results.
 */
export async function searchArxiv(params: SearchParams): Promise<ArxivSearchResult> {
  const url = buildSearchUrl(params);

  const response = await arxivFetch(url);
  if (!response.ok) {
    throw new Error(`arXiv API error: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();

  // Parse total results
  const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
  const total_results = totalMatch ? parseInt(totalMatch[1], 10) : 0;

  const startMatch = xml.match(/<opensearch:startIndex[^>]*>(\d+)<\/opensearch:startIndex>/);
  const start = startMatch ? parseInt(startMatch[1], 10) : 0;

  // Extract entries
  const entries: ArxivMetadata[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const parsed = parseArxivAtomEntry(match[0]);
    if (parsed) entries.push(parsed);
  }

  return { total_results, start, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-paper metadata fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch metadata for a single paper by arXiv ID.
 */
export async function fetchArxivMetadata(arxivId: string): Promise<ArxivMetadata | null> {
  const url = `${ARXIV_API_BASE}?id_list=${encodeURIComponent(arxivId)}`;

  try {
    const response = await arxivFetch(url);
    if (!response.ok) return null;

    const xml = await response.text();

    if (xml.includes('<opensearch:totalResults>0</opensearch:totalResults>')) {
      return null;
    }

    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) return null;

    return parseArxivAtomEntry(entryMatch[0]);
  } catch {
    return null;
  }
}
