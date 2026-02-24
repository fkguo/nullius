import pLimit from 'p-limit';
import { inspireFetch } from './rateLimiter.js';
import {
  INSPIRE_API_URL,
  type PaperSummary,
  type Paper,
  invalidParams,
  upstreamError,
  cleanMathTitle,
} from '@autoresearch/shared';
import {
  searchCache,
  buildSearchCacheKey,
  isExpired,
  getPaperFromCache,
  setPaperToCache,
  getReferencesFromCache,
  setReferencesToCache,
  getPaperSummaryFromCache,
  batchSetPaperSummariesToCache,
} from '../cache/memoryCache.js';

// ─────────────────────────────────────────────────────────────────────────────
// Global Concurrency Control (P3-2)
// ─────────────────────────────────────────────────────────────────────────────

/** Max concurrent API requests to prevent overwhelming the server */
const API_CONCURRENCY_LIMIT = 4;
const apiLimit = pLimit(API_CONCURRENCY_LIMIT);

/** Rate-limited and concurrency-controlled fetch */
function limitedFetch(url: string): Promise<Response> {
  return apiLimit(() => inspireFetch(url));
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = INSPIRE_API_URL;

// INSPIRE API limits (Reference: https://github.com/inspirehep/rest-api-doc)
const MAX_PAGE_SIZE = 1000;
const MAX_SEARCH_RESULTS = 10000;  // Technical limitation for search results

const ARXIV_NEW_ID_RE = /^\d{4}\.\d{4,5}(v\d+)?$/i;
const ARXIV_OLD_ID_RE = /^[a-z-]+\/\d{7}(v\d+)?$/i;

function normalizeArxivIdForLookup(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(/^arxiv\s*:/i, '').trim();
  if (!withoutPrefix) return null;

  if (!ARXIV_NEW_ID_RE.test(withoutPrefix) && !ARXIV_OLD_ID_RE.test(withoutPrefix)) {
    return null;
  }

  return withoutPrefix.replace(/v\d+$/i, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// API Field Configurations
// Reference: https://github.com/inspirehep/rest-api-doc
// Reference: zotero-inspire/src/modules/inspire/constants.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard search fields - reduces response size by ~98%
 * Includes document_type for conference paper detection
 * Includes texkeys for BibTeX key lookup
 */
const API_FIELDS_SEARCH = [
  'control_number',
  'titles.title',
  'authors.full_name',
  'author_count',
  'collaborations.value',
  'publication_info',
  'earliest_date',
  'dois',
  'arxiv_eprints',
  'citation_count',
  'citation_count_without_self_citations',
  'publication_type',
  'document_type',  // For conference paper detection (tc:c)
  'texkeys',        // For BibTeX key lookup
].join(',');

/**
 * Minimal fields for citation count only (~200 bytes vs ~5KB)
 */
export const API_FIELDS_CITATIONS = 'control_number,citation_count,citation_count_without_self_citations';

/**
 * Fields for reference enrichment
 */
export const API_FIELDS_ENRICHMENT = [
  'control_number',
  'titles.title',
  'authors.full_name',
  'author_count',
  'collaborations.value',
  'publication_info',
  'earliest_date',
  'dois',
  'arxiv_eprints',
  'citation_count',
  'citation_count_without_self_citations',
  'texkeys',
  'publication_type',
  'document_type',
].join(',');

// ─────────────────────────────────────────────────────────────────────────────
// Response Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchResult {
  total: number;
  papers: PaperSummary[];
  has_more: boolean;
  next_url?: string;
  /** Warning if results exceed API limit */
  warning?: string;
}

export interface SearchAllOptions {
  sort?: string;
  /**
   * Page size. INSPIRE enforces `1..1000` (see rest-api-doc).
   * Default: 1000 (minimize API calls while staying within limits).
   */
  size?: number;
  /**
   * Maximum number of papers to accumulate.
   * Default: 10000 (INSPIRE technical cap; see rest-api-doc).
   */
  max_results?: number;
}

// INSPIRE API Response Types (internal use)
interface InspireSearchResponse {
  hits?: {
    hits?: InspireHit[];
    total?: number;
  };
  links?: {
    next?: string;
  };
}

export function validateInspireApiUrl(
  rawUrl: string,
  options?: { max_page_size?: number; require_path_prefix?: string }
): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw invalidParams('next_url cannot be empty', { next_url: rawUrl });
  }

  const normalizePort = (u: URL): string => {
    if (u.port) return u.port;
    if (u.protocol === 'https:') return '443';
    if (u.protocol === 'http:') return '80';
    return '';
  };

  const hasPathPrefix = (pathname: string, prefixRaw: string): boolean => {
    const prefixTrimmed = prefixRaw.trim();
    if (!prefixTrimmed) return true;
    const prefix = prefixTrimmed.startsWith('/') ? prefixTrimmed : `/${prefixTrimmed}`;
    const normalized = prefix.replace(/\/+$/, '');
    if (!normalized) return true;
    return pathname === normalized || pathname.startsWith(`${normalized}/`);
  };

  const base = new URL(API_BASE);

  let url: URL;
  try {
    url = new URL(trimmed, base.origin);
  } catch {
    throw invalidParams('Invalid next_url', { next_url: rawUrl });
  }

  if (url.username || url.password) {
    throw invalidParams('next_url must not include URL credentials', { next_url: rawUrl });
  }

  if (url.protocol !== base.protocol || url.hostname !== base.hostname || normalizePort(url) !== normalizePort(base)) {
    throw invalidParams('next_url must have the same origin as INSPIRE API', {
      next_url: rawUrl,
      expected_origin: base.origin,
    });
  }

  const basePath = base.pathname.replace(/\/+$/, '');
  const allowedPrefix = `${basePath}/`;
  if (url.pathname !== basePath && !url.pathname.startsWith(allowedPrefix)) {
    throw invalidParams('next_url must point to INSPIRE API base path', {
      next_url: rawUrl,
      expected_prefix: allowedPrefix,
    });
  }

  const requiredPrefix = options?.require_path_prefix?.trim();
  if (requiredPrefix && !hasPathPrefix(url.pathname, requiredPrefix)) {
    throw invalidParams('next_url does not match required INSPIRE API endpoint', {
      next_url: rawUrl,
      required_path_prefix: requiredPrefix,
    });
  }

  const maxPageSize = options?.max_page_size;
  if (typeof maxPageSize === 'number') {
    const sizeParam = url.searchParams.get('size');
    if (sizeParam !== null) {
      const n = Number(sizeParam);
      if (!Number.isFinite(n) || n <= 0) {
        throw invalidParams('next_url has invalid size parameter', { next_url: rawUrl, size: sizeParam });
      }
      if (n > maxPageSize) {
        throw invalidParams(`next_url size exceeds inline limit (${maxPageSize})`, {
          next_url: rawUrl,
          size: n,
          max: maxPageSize,
        });
      }
    }
  }

  return url;
}

interface InspireHit {
  id?: string;
  metadata?: InspireMetadata;
}

interface InspireMetadata {
  control_number?: number;
  titles?: { title?: string }[];
  authors?: { full_name?: string }[];
  author_count?: number;
  publication_info?: InspirePublicationInfo[];
  earliest_date?: string;
  dois?: { value?: string }[];
  arxiv_eprints?: { value?: string; categories?: string[] }[];
  citation_count?: number;
  citation_count_without_self_citations?: number;
  abstracts?: { value?: string }[];
  collaborations?: { value?: string }[];
  keywords?: { value?: string }[];
  references?: InspireReference[];
  // INSPIRE publication type (e.g., ['review'], ['lectures', 'review'])
  publication_type?: string[];
  // INSPIRE document type (e.g., ['article'], ['conference paper'])
  document_type?: string[];
  // BibTeX keys (e.g., ['Maldacena:1997re'])
  texkeys?: string[];
}

interface InspirePublicationInfo {
  journal_title?: string;
  journal_title_abbrev?: string;
  journal_volume?: string;
  volume?: string;
  artid?: string;
  article_number?: string;
  page_start?: string;
  pagination?: string;
  year?: number;
  material?: string;
}

// Inner reference data (used when accessing refWrapper.reference or refWrapper directly)
interface InspireReferenceData {
  control_number?: number;
  title?: { title?: string };
  titles?: { title?: string }[];
  label?: string;
  authors?: { full_name?: string }[];
  publication_info?: InspirePublicationInfo;
  dois?: string[];
  arxiv_eprint?: string;
  arxiv_eprints?: { value?: string }[];
}

interface InspireReference {
  record?: { '$ref'?: string };
  reference?: InspireReferenceData;
}

interface InspireAuthorResponse {
  hits?: {
    hits?: { metadata?: InspireAuthorMetadata }[];
  };
  metadata?: InspireAuthorMetadata;
}

interface InspireAuthorMetadata {
  control_number?: number;
  name?: {
    preferred_name?: string;
    value?: string;
    native_names?: string[];
  };
  ids?: { schema?: string; value?: string }[];
  positions?: {
    institution?: string;
    country?: string;
    rank?: string;
    current?: boolean;
  }[];
  arxiv_categories?: string[];
  facet_author_name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse paper count from facet_author_name field
 * Format: "LastName, FirstName_123" where 123 is the paper count
 * Returns 0 if parsing fails or field is missing
 */
function parsePaperCount(facetAuthorName?: string): number {
  if (!facetAuthorName) return 0;
  const match = facetAuthorName.match(/_(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Format publication info as journal string
 * Reference: zotero-inspire/src/modules/inspire/formatters.ts
 * e.g., "Phys. Rev. D 90 (2018) 015004"
 */
function formatPublicationInfo(info?: InspirePublicationInfo, fallbackYear?: string): string {
  if (!info) return '';
  const parts: string[] = [];

  // Normalize journal title: "Phys.Rev.D" → "Phys. Rev. D"
  const rawJournal = info.journal_title || info.journal_title_abbrev || '';
  const journal = rawJournal ? rawJournal.replace(/\.\s|\./g, '. ').trim() : '';
  const volume = info.journal_volume || info.volume || '';
  const artid = info.artid || info.article_number || '';
  const pageStart = info.page_start || info.pagination || '';

  if (journal) parts.push(journal);
  if (volume) parts.push(volume);

  // Normalize year to 4-digit format
  const normalizedYear = fallbackYear?.match(/\d{4}/)?.[0];
  const year = info.year ?? normalizedYear;
  if (year) parts.push(`(${year})`);

  if (artid) parts.push(artid);
  else if (pageStart) parts.push(pageStart);

  return parts.join(' ').trim();
}

/**
 * Build publication summary with arXiv tag
 * e.g., "Phys. Rev. D 90 (2018) 015004 [arXiv:1705.00141]"
 */
function buildPublicationSummary(pubInfo: InspirePublicationInfo[] | undefined, arxivId?: string, fallbackYear?: string): string | undefined {
  const parts: string[] = [];

  // Get main publication info (skip erratum)
  if (pubInfo?.length) {
    const mainInfo = pubInfo.find((p) => p.material !== 'erratum') || pubInfo[0];
    const journalStr = formatPublicationInfo(mainInfo, fallbackYear);
    if (journalStr) parts.push(journalStr);
  }

  // Add arXiv tag
  if (arxivId) {
    parts.push(`[arXiv:${arxivId}]`);
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}

function extractPaperSummary(hit: InspireHit): PaperSummary {
  const meta = hit.metadata || {};
  const recid = String(meta.control_number || hit.id || '');

  // Extract arXiv ID
  let arxiv_id: string | undefined;
  if (meta.arxiv_eprints?.length) {
    arxiv_id = meta.arxiv_eprints[0].value;
  }

  // Extract DOI
  let doi: string | undefined;
  if (meta.dois?.length) {
    doi = meta.dois[0].value;
  }

  // Extract publication info
  const publication_summary = buildPublicationSummary(meta.publication_info, arxiv_id, meta.earliest_date);

  // Build document access URLs
  const pdf_url = arxiv_id ? `https://arxiv.org/pdf/${arxiv_id}.pdf` : undefined;
  const source_url = arxiv_id ? `https://arxiv.org/src/${arxiv_id}` : undefined;
  const collaborations = meta.collaborations?.map((c) => c.value).filter((v): v is string => !!v) || [];

  const texkey = Array.isArray(meta.texkeys)
    ? meta.texkeys
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map(k => k.trim())
      .sort((a, b) => a.localeCompare(b))[0]
    : undefined;

  return {
    recid,
    arxiv_id,
    doi,
    title: cleanMathTitle(meta.titles?.[0]?.title ?? '') || 'Untitled',
    authors: (meta.authors || []).slice(0, 10).map((a) => a.full_name || ''),
    author_count:
      typeof meta.author_count === 'number' && Number.isFinite(meta.author_count)
        ? meta.author_count
        : Array.isArray(meta.authors)
          ? meta.authors.length
          : undefined,
    collaborations: collaborations.length > 0 ? collaborations : undefined,
    year: meta.earliest_date ? parseInt(meta.earliest_date.slice(0, 4), 10) : undefined,
    earliest_date: meta.earliest_date,
    citation_count: meta.citation_count,
    citation_count_without_self_citations: meta.citation_count_without_self_citations,
    publication_summary,
    inspire_url: recid ? `https://inspirehep.net/literature/${recid}` : undefined,
    arxiv_url: arxiv_id ? `https://arxiv.org/abs/${arxiv_id}` : undefined,
    doi_url: doi ? `https://doi.org/${doi}` : undefined,
    pdf_url,
    source_url,
    // INSPIRE publication type for review detection
    publication_type: meta.publication_type,
    // INSPIRE document type for conference paper detection (tc:c)
    document_type: meta.document_type,
    // BibTeX keys (e.g., 'Maldacena:1997re')
    texkey,
    // arXiv primary category (e.g., 'hep-ph', 'hep-th')
    arxiv_primary_category: meta.arxiv_eprints?.[0]?.categories?.[0],
    // All arXiv categories (primary + cross-list)
    arxiv_categories: meta.arxiv_eprints?.[0]?.categories,
  } as PaperSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Preprocessing for Morphological Variants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common adjective/noun pairs in HEP terminology
 * Maps adjective form to noun form for wildcard expansion
 */
const ADJECTIVE_NOUN_PAIRS: Record<string, string> = {
  hadronic: 'hadron',
  mesonic: 'meson',
  baryonic: 'baryon',
  leptonic: 'lepton',
  bosonic: 'boson',
  fermionic: 'fermion',
  gluonic: 'gluon',
  photonic: 'photon',
  pionic: 'pion',
  kaonic: 'kaon',
  charmed: 'charm',
  bottomed: 'bottom',
  strange: 'strangeness',
  exotic: 'exotica',
  pentaquark: 'pentaquark',
  tetraquark: 'tetraquark',
};

/**
 * Preprocess title search terms to handle morphological variants
 * Adds wildcards to cover singular/plural and adjective/noun forms
 *
 * Examples:
 *   "hadronic molecule" → "hadron* molecule*"
 *   "tetraquark state" → "tetraquark* state*"
 */
function preprocessTitleSearch(term: string): string {
  // Split into words
  const words = term.trim().split(/\s+/);

  const processed = words.map(word => {
    const lower = word.toLowerCase();

    // Skip if already has wildcard
    if (word.endsWith('*')) return word;

    // Check if it's an adjective form, convert to noun stem
    if (ADJECTIVE_NOUN_PAIRS[lower]) {
      return ADJECTIVE_NOUN_PAIRS[lower] + '*';
    }

    // Add wildcard to cover plural forms
    return word + '*';
  });

  return processed.join(' ');
}

/**
 * Preprocess search query to handle morphological variants in title searches
 * Only affects t: (title) operator
 */
export function preprocessQuery(query: string): string {
  // Match t: or title: followed by content (with or without quotes)
  // Pattern: t:word or t:"phrase" or t:(phrase)
  return query.replace(
    /\b(t|title):("?)([^"\s]+|[^"]+)\2/gi,
    (match, op, quote, content) => {
      // Don't process if content already has wildcards
      if (content.includes('*')) return match;

      // Process the content
      const processed = preprocessTitleSearch(content);

      // Return with or without quotes based on original
      if (quote) {
        return `${op}:${quote}${processed}${quote}`;
      }
      return `${op}:${processed}`;
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

export async function search(
  query: string,
  options?: { sort?: string; size?: number; page?: number; arxiv_categories?: string }
): Promise<SearchResult> {
  // Preprocess query for morphological variants
  const processedQuery = preprocessQuery(query);

  // Check cache first (use processed query for cache key)
  const cacheKey = buildSearchCacheKey(processedQuery, options?.sort, options?.size, options?.page, options?.arxiv_categories);
  const cached = searchCache.get(cacheKey);
  if (cached && !isExpired(cached.timestamp)) {
    return {
      total: cached.total,
      papers: cached.papers,
      has_more: cached.has_more,
      next_url: cached.next_url,
      warning: cached.warning,
    };
  }

  const params = new URLSearchParams({ q: processedQuery });
  if (options?.sort) params.set('sort', options.sort);
  if (options?.size !== undefined) {
    const size = options.size;
    if (!Number.isFinite(size) || !Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw new Error(`Invalid size=${size}. INSPIRE API allows size=1..${MAX_PAGE_SIZE}.`);
    }
    params.set('size', String(size));
  }
  if (options?.page !== undefined) {
    const page = options.page;
    if (!Number.isFinite(page) || !Number.isInteger(page) || page < 1) {
      throw new Error(`Invalid page=${page}. page must be an integer >= 1.`);
    }
    params.set('page', String(page));
  }
  if (options?.arxiv_categories) params.set('arxiv_categories', options.arxiv_categories);
  // Add fields parameter to reduce response size
  params.set('fields', API_FIELDS_SEARCH);

  const url = `${API_BASE}/literature?${params}`;
  const response = await limitedFetch(url);

  if (!response.ok) {
    throw upstreamError(`INSPIRE API error: ${response.status}`, { url, status: response.status });
  }

  const data = await response.json() as InspireSearchResponse;
  const hits = data.hits?.hits || [];
  const papers = hits.map(extractPaperSummary);
  const total = data.hits?.total || 0;
  const next_url = data.links?.next;
  const has_more = Boolean(next_url);

  // Check for result limit warning
  const warning = total > MAX_SEARCH_RESULTS
    ? `Results exceed INSPIRE API limit (${MAX_SEARCH_RESULTS}). Consider narrowing your search.`
    : undefined;

  // Cache the result
  searchCache.set(cacheKey, { total, papers, has_more, next_url, warning, timestamp: Date.now() });

  return {
    total,
    papers,
    has_more,
    next_url,
    warning,
  };
}

export async function searchByUrl(
  nextUrl: string,
  options?: { max_page_size?: number }
): Promise<SearchResult> {
  const base = new URL(API_BASE);
  const requiredPrefix = `${base.pathname.replace(/\/+$/, '')}/literature`;
  const url = validateInspireApiUrl(nextUrl, { ...options, require_path_prefix: requiredPrefix });

  const response = await limitedFetch(url.toString());

  if (!response.ok) {
    throw upstreamError(`INSPIRE API error: ${response.status}`, { url: url.toString(), status: response.status });
  }

  const data = await response.json() as InspireSearchResponse;
  const hits = data.hits?.hits || [];
  const papers = hits.map(extractPaperSummary);
  const total = data.hits?.total || 0;

  // Check for result limit warning
  const warning = total > MAX_SEARCH_RESULTS
    ? `Results exceed INSPIRE API limit (${MAX_SEARCH_RESULTS}). Consider narrowing your search.`
    : undefined;

  return {
    total,
    papers,
    has_more: Boolean(data.links?.next),
    next_url: data.links?.next,
    warning,
  };
}

export interface SearchAllOptions {
  sort?: string;
  /** Page size (INSPIRE max is 1000) */
  size?: number;
  /** Hard cap on returned papers (defaults to INSPIRE technical limit) */
  max_results?: number;
}

/**
 * Fetch multiple pages for a search query (up to the INSPIRE technical limit).
 *
 * Notes:
 * - Keeps `size` constant across pages (page offset depends on size).
 * - Returns `has_more=true` when `total > papers.length` (i.e., truncated by budget/limit).
 */
export async function searchAll(
  query: string,
  options?: SearchAllOptions
): Promise<SearchResult> {
  const pageSizeRaw = options?.size ?? 1000;
  const pageSize = Math.min(1000, Math.max(1, Math.trunc(pageSizeRaw)));

  const maxResultsRaw = options?.max_results ?? MAX_SEARCH_RESULTS;
  const hardCap = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(maxResultsRaw)));

  const papers: PaperSummary[] = [];
  let total = 0;
  let warning: string | undefined;

  const maxPages = Math.ceil(MAX_SEARCH_RESULTS / pageSize) + 1;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await search(query, { sort: options?.sort, size: pageSize, page });
    if (page === 1) {
      total = res.total;
      warning = res.warning;
    }

    papers.push(...res.papers);

    if (!res.has_more) break;
    if (papers.length >= hardCap) break;
    if (res.papers.length === 0) break; // safety: avoid infinite loops on bad pagination
  }

  const sliced = papers.slice(0, hardCap);
  const has_more = total > sliced.length;

  if (has_more && options?.max_results !== undefined) {
    warning = warning
      ? `${warning} Truncated to max_results=${hardCap} (total=${total}).`
      : `Truncated to max_results=${hardCap} (total=${total}).`;
  }

  return {
    total,
    papers: sliced,
    has_more,
    warning,
  };
}

export async function getPaper(recid: string): Promise<Paper> {
  // Check cache first (with TTL)
  const cached = getPaperFromCache(recid);
  if (cached) return cached;

  const url = `${API_BASE}/literature/${recid}`;
  const response = await limitedFetch(url);

  if (!response.ok) {
    throw upstreamError(`INSPIRE API error: ${response.status}`, { url, status: response.status });
  }

  const data = await response.json() as InspireHit;
  const meta = data.metadata || {};
  const summary = extractPaperSummary(data);

  const paper: Paper = {
    ...summary,
    abstract: meta.abstracts?.[0]?.value,
    collaborations: meta.collaborations?.map((c) => c.value).filter((v): v is string => !!v) || [],
    keywords: meta.keywords?.map((k) => k.value).filter((v): v is string => !!v) || [],
    arxiv_categories: meta.arxiv_eprints?.[0]?.categories || [],
  };

  // Cache the result (with TTL)
  setPaperToCache(recid, paper);

  return paper;
}

/**
 * Get paper by DOI using direct endpoint
 * Reference: https://github.com/inspirehep/rest-api-doc
 * Example: /api/doi/10.1103/PhysRevLett.19.1264
 */
export async function getByDoi(doi: string): Promise<Paper> {
  const url = `${API_BASE}/doi/${encodeURIComponent(doi)}`;
  const response = await limitedFetch(url);

  if (!response.ok) {
    throw upstreamError(`INSPIRE API error: ${response.status}`, { url, status: response.status });
  }

  const data = await response.json() as InspireHit;
  const meta = data.metadata || {};
  const summary = extractPaperSummary(data);

  return {
    ...summary,
    abstract: meta.abstracts?.[0]?.value,
    collaborations: meta.collaborations?.map((c) => c.value).filter((v): v is string => !!v) || [],
    keywords: meta.keywords?.map((k) => k.value).filter((v): v is string => !!v) || [],
    arxiv_categories: meta.arxiv_eprints?.[0]?.categories || [],
  };
}

/**
 * Get paper by arXiv ID using direct endpoint
 * Reference: https://github.com/inspirehep/rest-api-doc
 * Example: /api/arxiv/1207.7214 or /api/arxiv/hep-ph/0603175
 */
export async function getByArxiv(arxivId: string): Promise<Paper> {
  const normalized = normalizeArxivIdForLookup(arxivId);
  if (!normalized) {
    throw invalidParams('Invalid arXiv identifier. Use plain arXiv ID like "2504.14997" or "hep-ph/0603175" (optional "arXiv:" prefix is accepted).', {
      input_arxiv_id: arxivId,
      examples: ['2504.14997', 'hep-ph/0603175'],
    });
  }

  const url = `${API_BASE}/arxiv/${encodeURIComponent(normalized)}`;
  const response = await limitedFetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw upstreamError('INSPIRE API error: 404 (arXiv record not found)', {
        url,
        status: response.status,
        input_arxiv_id: arxivId,
        normalized_arxiv_id: normalized,
      });
    }
    throw upstreamError(`INSPIRE API error: ${response.status}`, {
      url,
      status: response.status,
      input_arxiv_id: arxivId,
      normalized_arxiv_id: normalized,
    });
  }

  const data = await response.json() as InspireHit;
  const meta = data.metadata || {};
  const summary = extractPaperSummary(data);

  return {
    ...summary,
    abstract: meta.abstracts?.[0]?.value,
    collaborations: meta.collaborations?.map((c) => c.value).filter((v): v is string => !!v) || [],
    keywords: meta.keywords?.map((k) => k.value).filter((v): v is string => !!v) || [],
    arxiv_categories: meta.arxiv_eprints?.[0]?.categories || [],
  };
}

export async function getReferences(recid: string, size?: number): Promise<PaperSummary[]> {
  // Check cache first (only for full references, not size-limited, with TTL)
  if (!size) {
    const cached = getReferencesFromCache(recid);
    if (cached) return cached;
  }

  // Use fields parameter to get references from paper metadata (more reliable than /references endpoint)
  // This approach doesn't have size limits and returns all references
  const url = `${API_BASE}/literature/${recid}?fields=metadata.references`;
  const response = await limitedFetch(url);

  if (!response.ok) {
    throw upstreamError(`INSPIRE API error: ${response.status}`, { url, status: response.status });
  }

  const data = await response.json() as InspireHit;
  const refs = data.metadata?.references || [];

  // Apply size limit if specified
  const limitedRefs = size ? refs.slice(0, size) : refs;

  const result = limitedRefs.map((refWrapper: InspireReference) => {
    const ref = (refWrapper?.reference || refWrapper) as InspireReferenceData;
    // Extract recid from record.$ref or control_number
    let refRecid = '';
    if (refWrapper?.record?.['$ref']) {
      const match = refWrapper.record['$ref'].match(/\/(\d+)$/);
      if (match) refRecid = match[1];
    }
    if (!refRecid && ref.control_number) {
      refRecid = String(ref.control_number);
    }

    // Build title from available data
    let title = ref.title?.title || ref.titles?.[0]?.title || ref.label;
    if (!title && ref.publication_info) {
      const pi = ref.publication_info;
      title = `${pi.journal_title || ''} ${pi.journal_volume || ''} (${pi.year || ''})`.trim();
    }
    if (!title) title = 'Unknown';

    // Extract DOI
    const doi = Array.isArray(ref.dois) && ref.dois.length ? ref.dois[0] : undefined;

    // Build publication summary
    const arxiv_id = ref.arxiv_eprint || ref.arxiv_eprints?.[0]?.value;
    const publication_summary = buildPublicationSummary(
      ref.publication_info ? [ref.publication_info] : [],
      arxiv_id
    );

    return {
      recid: refRecid,
      title,
      authors: (ref.authors || []).slice(0, 5).map((a: { full_name?: string }) => a.full_name || ''),
      author_count: Array.isArray(ref.authors) ? ref.authors.length : undefined,
      year: ref.publication_info?.year,
      arxiv_id,
      doi,
      publication_summary,
      inspire_url: refRecid ? `https://inspirehep.net/literature/${refRecid}` : undefined,
      arxiv_url: arxiv_id ? `https://arxiv.org/abs/${arxiv_id}` : undefined,
      doi_url: doi ? `https://doi.org/${doi}` : undefined,
    } as PaperSummary;
  });

  // Cache full references (not size-limited, with TTL)
  if (!size) {
    setReferencesToCache(recid, result);
  }

  return result;
}

export async function getCitations(
  recid: string,
  options?: { sort?: string; size?: number; page?: number }
): Promise<SearchResult> {
  const query = `refersto:recid:${recid}`;
  return search(query, options);
}

export async function getBibtex(recids: string[]): Promise<string> {
  // INSPIRE supports fetching multiple records in BibTeX format.
  // Practical constraints:
  // - `size` is limited (<= 1000) per API docs
  // - `q=recid:... or recid:...` URLs can exceed typical URL length limits if too many ids are included
  // So we batch requests and concatenate the BibTeX blocks.
  const cleaned = recids.map(r => r.trim()).filter(r => r.length > 0);
  const unique = [...new Set(cleaned)];
  if (unique.length === 0) return '';

  const BIBTEX_BATCH_SIZE = 50;
  const parts: string[] = [];

  for (let i = 0; i < unique.length; i += BIBTEX_BATCH_SIZE) {
    const batch = unique.slice(i, i + BIBTEX_BATCH_SIZE);
    const query = batch.map(id => `recid:${id}`).join(' or ');
    const url = `${API_BASE}/literature?q=${encodeURIComponent(query)}&size=${batch.length}&format=bibtex`;
    const response = await limitedFetch(url);

    if (!response.ok) {
      throw upstreamError(`INSPIRE API error: ${response.status}`, { url, status: response.status });
    }

    parts.push(await response.text());
  }

  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Operations
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 25;

/**
 * Batch fetch paper summaries by recids
 * Uses "recid:1 or recid:2 ..." syntax for efficient batch queries
 * Results are cached for subsequent lookups
 */
export async function batchGetPapers(recids: string[]): Promise<PaperSummary[]> {
  if (!recids.length) return [];

  const results: PaperSummary[] = [];
  const uniqueRecids = [...new Set(recids.filter(id => id))];

  // Check cache first, collect uncached recids
  const uncachedRecids: string[] = [];
  for (const recid of uniqueRecids) {
    const cached = getPaperSummaryFromCache(recid);
    if (cached) {
      results.push(cached);
    } else {
      uncachedRecids.push(recid);
    }
  }

  // Fetch uncached papers in batches
  if (uncachedRecids.length > 0) {
    for (let i = 0; i < uncachedRecids.length; i += BATCH_SIZE) {
      const batch = uncachedRecids.slice(i, i + BATCH_SIZE);
      const query = batch.map(id => `recid:${id}`).join(' or ');
      const result = await search(query, { size: batch.length });

      // Cache the fetched papers
      batchSetPaperSummariesToCache(result.papers);
      results.push(...result.papers);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Builder Helpers
// Reference: https://help.inspirehep.net/knowledge-base/inspire-paper-search/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a query to find papers citing a specific paper
 * Uses refersto:recid:X syntax
 */
export function buildCitingQuery(recid: string): string {
  return `refersto:recid:${recid}`;
}

/**
 * Build a query to find papers by an author citing another author
 * Uses author:X refersto:author:Y syntax
 */
export function buildAuthorCitingAuthorQuery(authorBai: string, citedAuthorBai: string): string {
  return `author:${authorBai} refersto:author:${citedAuthorBai}`;
}

/**
 * Build a query for high-cited papers
 * Uses topcite:N+ syntax
 */
export function buildHighCitedQuery(minCitations: number, additionalQuery?: string): string {
  const base = `topcite:${minCitations}+`;
  return additionalQuery ? `${additionalQuery} and ${base}` : base;
}

/**
 * Build a query for papers in a date range
 * Uses date:YYYY->YYYY syntax
 */
export function buildDateRangeQuery(startYear: number, endYear: number, additionalQuery?: string): string {
  const dateRange = `date:${startYear}->${endYear}`;
  return additionalQuery ? `${additionalQuery} and ${dateRange}` : dateRange;
}

/**
 * Build a query excluding review papers
 * Uses not tc:r syntax
 */
export function excludeReviews(query: string): string {
  return `${query} not tc:r`;
}

/**
 * Build a query for conference papers only
 * Uses tc:c syntax
 */
export function buildConferencePapersQuery(topic: string): string {
  return `${topic} and tc:c`;
}

/**
 * Build a batch recid query with proper parentheses
 * Uses (recid:1 or recid:2 or ...) syntax for complex queries
 */
export function buildBatchRecidQuery(recids: string[]): string {
  if (recids.length === 0) return '';
  if (recids.length === 1) return `recid:${recids[0]}`;
  return `(${recids.map(id => `recid:${id}`).join(' or ')})`;
}

/**
 * Build a query for author + topic search
 * IMPORTANT: Must use 'and' operator between author and topic
 * Without 'and', INSPIRE treats the topic as part of the author name
 *
 * @param author - Author name or BAI (e.g., 'Witten' or 'E.Witten.1')
 * @param topic - Topic keywords
 * @param searchField - Search field type:
 *   - 'keyword' (k:) - searches in keywords field, broader than title
 *   - 'title' (t:) - searches in title only, more precise
 *   - 'fulltext' (ft:) - searches in full paper text, broadest
 * @returns Properly formatted query string
 *
 * @example
 * buildAuthorTopicQuery('Beane', 'entanglement suppression', 'keyword')
 * // Returns: 'a:Beane and k:entanglement suppression'
 */
export function buildAuthorTopicQuery(
  author: string,
  topic: string,
  searchField: 'keyword' | 'title' | 'fulltext' = 'keyword'
): string {
  const prefixMap = { keyword: 'k:', title: 't:', fulltext: 'ft:' };
  return `a:${author} and ${prefixMap[searchField]}${topic}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Author API
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthorProfile {
  bai?: string;
  name: string;
  native_name?: string;
  orcid?: string;
  affiliations: { name: string; country?: string }[];
  stats: {
    papers: number;
    citations: number;
    h_index?: number;
  };
  positions?: { institution: string; rank?: string; current?: boolean }[];
  arxiv_categories?: string[];
  inspire_url?: string;
}

export async function getAuthor(identifier: string): Promise<AuthorProfile> {
  let url: string;

  // Determine query type
  if (identifier.includes('.') && /\.\d+$/.test(identifier)) {
    // BAI format: E.Witten.1
    url = `${API_BASE}/authors?q=ids.value:${encodeURIComponent(identifier)}`;
  } else if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(identifier)) {
    // ORCID format
    url = `${API_BASE}/orcid/${identifier}`;
  } else {
    // Name search
    url = `${API_BASE}/authors?q=${encodeURIComponent(identifier)}`;
  }

  const response = await limitedFetch(url);

  if (!response.ok) {
    throw upstreamError(`INSPIRE API error: ${response.status}`, { url, status: response.status });
  }

  const data = await response.json() as InspireAuthorResponse;

  // Handle search results vs direct lookup
  const authorData = data.hits?.hits?.[0]?.metadata || data.metadata;

  if (!authorData) {
    throw upstreamError('Author not found', { identifier });
  }

  return extractAuthorProfile(authorData);
}

function extractAuthorProfile(data: InspireAuthorMetadata): AuthorProfile {
  const recid = data.control_number;

  return {
    bai: data.ids?.find((id) => id.schema === 'INSPIRE BAI')?.value,
    name: data.name?.preferred_name || data.name?.value || 'Unknown',
    native_name: data.name?.native_names?.[0],
    orcid: data.ids?.find((id) => id.schema === 'ORCID')?.value,
    affiliations: (data.positions || [])
      .filter((p) => p.current && p.institution)
      .map((p) => ({
        name: p.institution!,
        country: p.country,
      })),
    stats: {
      // Note: facet_author_name format is "Name_123" where 123 is paper count
      // This is not always reliable; consider using search API for accurate count
      papers: parsePaperCount(data.facet_author_name),
      citations: 0,  // Need separate API call
      h_index: undefined,
    },
    positions: (data.positions || [])
      .filter((p) => p.institution)
      .map((p) => ({
        institution: p.institution!,
        rank: p.rank,
        current: p.current,
      })),
    arxiv_categories: data.arxiv_categories,
    inspire_url: recid ? `https://inspirehep.net/authors/${recid}` : undefined,
  };
}
