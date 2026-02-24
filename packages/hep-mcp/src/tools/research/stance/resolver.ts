/**
 * Citekey to Recid Resolver
 *
 * Maps bibliography citekeys to INSPIRE recids.
 * Implements the mapping strategy from design document section 4.4.
 */

import type { BibEntryIdentifiers, ResolutionMethod, PipelineError } from './types.js';
import { resolverCache, normalizeCacheKey } from './cache.js';
import * as api from '../../../api/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// arXiv ID Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize arXiv ID to standard format
 * Handles: arxiv:2301.12345, https://arxiv.org/abs/2301.12345, 2301.12345v2
 */
export function normalizeArxivId(id: string): string | null {
  if (!id) return null;

  let normalized = id.toLowerCase().trim();

  // Remove URL prefix
  normalized = normalized.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '');

  // Remove arxiv: prefix
  normalized = normalized.replace(/^arxiv\s*:\s*/i, '');

  // Remove version suffix
  normalized = normalized.replace(/v\d{1,2}$/i, '');

  // Validate format: YYMM.NNNNN or subject-class/YYMMNNN
  if (/^\d{4}\.\d{4,5}$/.test(normalized)) return normalized;
  if (/^[a-z-]+\/\d{7}$/.test(normalized)) return normalized;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Journal Name Normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Common journal name mappings */
const JOURNAL_MAPPINGS: Record<string, string> = {
  // Physical Review
  'phys. rev. lett.': 'Phys.Rev.Lett.',
  'physical review letters': 'Phys.Rev.Lett.',
  'prl': 'Phys.Rev.Lett.',
  'phys. rev. d': 'Phys.Rev.D',
  'physical review d': 'Phys.Rev.D',
  'prd': 'Phys.Rev.D',
  'phys. rev. c': 'Phys.Rev.C',
  'phys. rev.': 'Phys.Rev.',

  // JHEP, JCAP
  'jhep': 'JHEP',
  'j. high energy phys.': 'JHEP',
  'jcap': 'JCAP',
  'j. cosmol. astropart. phys.': 'JCAP',

  // Nuclear Physics
  'nucl. phys. b': 'Nucl.Phys.B',
  'nucl. phys. a': 'Nucl.Phys.A',
  'nuclear physics b': 'Nucl.Phys.B',

  // Physics Letters
  'phys. lett. b': 'Phys.Lett.B',
  'physics letters b': 'Phys.Lett.B',
  'plb': 'Phys.Lett.B',

  // European Physical Journal
  'eur. phys. j. c': 'Eur.Phys.J.C',
  'epjc': 'Eur.Phys.J.C',

  // Chinese Physics
  'chin. phys. c': 'Chin.Phys.C',
  'cpc': 'Chin.Phys.C',
};

/**
 * Normalize journal name to INSPIRE format
 */
export function normalizeJournal(journal: string): string {
  if (!journal) return '';

  const lower = journal.toLowerCase().trim();
  return JOURNAL_MAPPINGS[lower] || journal;
}

// ─────────────────────────────────────────────────────────────────────────────
// INSPIRE Lookup Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lookup paper by arXiv ID
 */
export async function inspireLookupByArxiv(arxivId: string): Promise<string | null> {
  const normalized = normalizeArxivId(arxivId);
  if (!normalized) return null;

  try {
    const paper = await api.getByArxiv(normalized);
    if (paper?.recid) {
      return paper.recid;
    }
  } catch (err) {
    // Expected for non-existent papers, debug level only
    if (process.env.DEBUG) {
      console.debug(`[stance/resolver] arXiv lookup failed for ${normalized}: ${(err as Error).message}`);
    }
  }
  return null;
}

/**
 * Lookup paper by DOI
 */
export async function inspireLookupByDOI(doi: string): Promise<string | null> {
  if (!doi) return null;

  try {
    const paper = await api.getByDoi(doi);
    if (paper?.recid) {
      return paper.recid;
    }
  } catch (err) {
    // Expected for non-existent papers, debug level only
    if (process.env.DEBUG) {
      console.debug(`[stance/resolver] DOI lookup failed for ${doi}: ${(err as Error).message}`);
    }
  }
  return null;
}

/**
 * Lookup paper by journal + volume + page
 */
export async function inspireLookupByJournal(
  journal: string,
  volume: string,
  page: string
): Promise<string | null> {
  if (!journal || !volume || !page) return null;

  const normalizedJournal = normalizeJournal(journal);
  const query = `j:${normalizedJournal},${volume},${page}`;

  try {
    const result = await api.search(query, { size: 1 });
    if (result.papers?.[0]?.recid) {
      return result.papers[0].recid;
    }
  } catch (err) {
    // Expected for non-existent papers, debug level only
    if (process.env.DEBUG) {
      console.debug(`[stance/resolver] Journal lookup failed for ${query}: ${(err as Error).message}`);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Resolver Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve citekey to INSPIRE recid
 * Priority: doi > arxiv > journal+vol+page > inspire (recid rarely in bib files)
 */
export async function resolveCitekeyToRecid(
  ids: BibEntryIdentifiers
): Promise<string | null> {
  // 1. DOI lookup (most reliable)
  if (ids.doi) {
    const recid = await inspireLookupByDOI(ids.doi);
    if (recid) return recid;
  }

  // 2. arXiv ID lookup (very common in HEP)
  const arxivId = ids.arxiv || ids.eprint;
  if (arxivId) {
    const recid = await inspireLookupByArxiv(arxivId);
    if (recid) return recid;
  }

  // 3. Journal + volume + page lookup
  if (ids.journal && ids.volume && ids.page) {
    const recid = await inspireLookupByJournal(ids.journal, ids.volume, ids.page);
    if (recid) return recid;
  }

  // 4. Direct INSPIRE recid (rarely present in bib files)
  if (ids.inspire) {
    return ids.inspire;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry Configuration (R3 P1-3)
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_CONFIG = {
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryableStatusCodes: [429, 502, 503],
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'],
};

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Check if error is retryable */
function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // Check network errors
    if (RETRY_CONFIG.retryableErrors.some(e => err.message.includes(e))) {
      return true;
    }
    // Check HTTP status codes
    const statusCode = (err as { statusCode?: number; status?: number }).statusCode ||
                       (err as { statusCode?: number; status?: number }).status;
    if (statusCode && RETRY_CONFIG.retryableStatusCodes.includes(statusCode)) {
      return true;
    }
  }
  return false;
}

/** Retry wrapper with exponential backoff and jitter */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (!isRetryable(err)) throw err;

      if (attempt < RETRY_CONFIG.maxRetries) {
        // R3 P1-3: Add jitter (0.7~1.3 random factor)
        const jitter = 0.7 + Math.random() * 0.6;
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt) * jitter,
          RETRY_CONFIG.maxDelayMs
        );
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Resolver (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

/** Batch resolver result */
export interface BatchResolveResult {
  citekeyToRecid: Map<string, string | null>;
  citekeyToMethod: Map<string, ResolutionMethod>;
  resolverErrors: PipelineError[];
  cacheHits: number;
  cacheMisses: number;
}

/** Default concurrency for batch resolution */
const DEFAULT_CONCURRENCY = 4;

/**
 * Resolve a single citekey with caching and retry
 */
async function resolveWithCache(
  _citekey: string,
  ids: BibEntryIdentifiers
): Promise<{ recid: string | null; method: ResolutionMethod; fromCache: boolean }> {
  const cacheKey = normalizeCacheKey(ids);

  // Check cache first
  const cached = resolverCache.get(cacheKey);
  if (cached) {
    return { recid: cached.recid, method: cached.resolutionMethod, fromCache: true };
  }

  // Resolve with retry
  let recid: string | null = null;
  let method: ResolutionMethod = 'texkey';

  try {
    // Try DOI first
    if (ids.doi) {
      recid = await withRetry(() => inspireLookupByDOI(ids.doi!));
      if (recid) method = 'doi';
    }

    // Try arXiv
    if (!recid) {
      const arxivId = ids.arxiv || ids.eprint;
      if (arxivId) {
        recid = await withRetry(() => inspireLookupByArxiv(arxivId));
        if (recid) method = 'arxiv';
      }
    }

    // Try journal
    if (!recid && ids.journal && ids.volume && ids.page) {
      recid = await withRetry(() => inspireLookupByJournal(ids.journal!, ids.volume!, ids.page!));
      if (recid) method = 'journal';
    }

    // Direct INSPIRE recid
    if (!recid && ids.inspire) {
      recid = ids.inspire;
      method = 'inspire';
    }
  } catch {
    // Resolution failed, will cache as null
  }

  // Cache result
  resolverCache.set(cacheKey, recid, method);

  return { recid, method, fromCache: false };
}

/**
 * Batch resolve citekeys to recids with concurrency control
 */
export async function batchResolveCitekeys(
  citekeys: string[],
  bibEntries: Map<string, BibEntryIdentifiers>,
  concurrency = DEFAULT_CONCURRENCY
): Promise<BatchResolveResult> {
  const citekeyToRecid = new Map<string, string | null>();
  const citekeyToMethod = new Map<string, ResolutionMethod>();
  const resolverErrors: PipelineError[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  // Deduplicate citekeys
  const uniqueCitekeys = [...new Set(citekeys)];

  // Process in batches with concurrency limit
  for (let i = 0; i < uniqueCitekeys.length; i += concurrency) {
    const batch = uniqueCitekeys.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async (citekey) => {
        const ids = bibEntries.get(citekey) || { citekey };

        try {
          const result = await resolveWithCache(citekey, ids);
          if (result.fromCache) cacheHits++;
          else cacheMisses++;
          return { citekey, ...result, error: null };
        } catch (err) {
          cacheMisses++;
          return {
            citekey,
            recid: null,
            method: 'texkey' as ResolutionMethod,
            fromCache: false,
            error: err as Error,
          };
        }
      })
    );

    // Collect results
    for (const result of results) {
      citekeyToRecid.set(result.citekey, result.recid);
      citekeyToMethod.set(result.citekey, result.method);

      if (result.error) {
        resolverErrors.push({
          type: 'resolution',
          citekey: result.citekey,
          message: result.error.message,
          recoverable: true,
        });
      }
    }
  }

  return { citekeyToRecid, citekeyToMethod, resolverErrors, cacheHits, cacheMisses };
}
