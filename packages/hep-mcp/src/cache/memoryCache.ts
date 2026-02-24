import { LRUCache } from '@autoresearch/shared';
import type { PaperSummary, Paper } from '@autoresearch/shared';
import { CACHE_TTL, CACHE_SIZE } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cache Entry Types (with timestamp for TTL)
// ─────────────────────────────────────────────────────────────────────────────

interface SearchCacheEntry {
  total: number;
  papers: PaperSummary[];
  has_more: boolean;
  next_url?: string;
  warning?: string;
  timestamp: number;
}

interface PaperCacheEntry {
  data: Paper;
  timestamp: number;
}

interface ReferencesCacheEntry {
  data: PaperSummary[];
  timestamp: number;
}

interface PaperSummaryCacheEntry {
  data: PaperSummary;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache Instances
// ─────────────────────────────────────────────────────────────────────────────

export const searchCache = new LRUCache<string, SearchCacheEntry>(CACHE_SIZE.SEARCH);
export const paperCache = new LRUCache<string, PaperCacheEntry>(CACHE_SIZE.PAPER);
export const paperSummaryCache = new LRUCache<string, PaperSummaryCacheEntry>(CACHE_SIZE.PAPER_SUMMARY);
export const referencesCache = new LRUCache<string, ReferencesCacheEntry>(CACHE_SIZE.REFERENCES);

// ─────────────────────────────────────────────────────────────────────────────
// Cache Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Check if cache entry is expired with custom TTL */
export function isExpired(timestamp: number, ttl: number = CACHE_TTL.SEARCH): boolean {
  return Date.now() - timestamp > ttl;
}

export function buildSearchCacheKey(
  query: string,
  sort?: string,
  size?: number,
  page?: number,
  arxiv_categories?: string
): string {
  return `${query}|${sort || ''}|${size || 10}|${page || 1}|${arxiv_categories || ''}`;
}

// Helper functions for paper cache with TTL
export function getPaperFromCache(recid: string): Paper | undefined {
  const entry = paperCache.get(recid);
  if (entry && !isExpired(entry.timestamp, CACHE_TTL.METADATA)) {
    return entry.data;
  }
  return undefined;
}

export function setPaperToCache(recid: string, paper: Paper): void {
  paperCache.set(recid, { data: paper, timestamp: Date.now() });
}

// Helper functions for references cache with TTL
export function getReferencesFromCache(recid: string): PaperSummary[] | undefined {
  const entry = referencesCache.get(recid);
  if (entry && !isExpired(entry.timestamp, CACHE_TTL.REFERENCES)) {
    return entry.data;
  }
  return undefined;
}

export function setReferencesToCache(recid: string, refs: PaperSummary[]): void {
  referencesCache.set(recid, { data: refs, timestamp: Date.now() });
}

// Helper functions for paper summary cache with TTL
export function getPaperSummaryFromCache(recid: string): PaperSummary | undefined {
  const entry = paperSummaryCache.get(recid);
  if (entry && !isExpired(entry.timestamp, CACHE_TTL.METADATA)) {
    return entry.data;
  }
  return undefined;
}

export function setPaperSummaryToCache(recid: string, summary: PaperSummary): void {
  paperSummaryCache.set(recid, { data: summary, timestamp: Date.now() });
}

/** Batch set paper summaries to cache */
export function batchSetPaperSummariesToCache(papers: PaperSummary[]): void {
  const now = Date.now();
  for (const paper of papers) {
    if (paper.recid) {
      paperSummaryCache.set(paper.recid, { data: paper, timestamp: now });
    }
  }
}

export function clearAllCaches(): void {
  searchCache.clear();
  paperCache.clear();
  paperSummaryCache.clear();
  referencesCache.clear();
}

export function getCacheStats() {
  return {
    search: searchCache.getStats(),
    paper: paperCache.getStats(),
    paperSummary: paperSummaryCache.getStats(),
    references: referencesCache.getStats(),
  };
}

/**
 * Get aggregated cache statistics
 */
export function getAggregatedStats() {
  const stats = getCacheStats();
  const totalHits = stats.search.hits + stats.paper.hits +
                    stats.paperSummary.hits + stats.references.hits;
  const totalMisses = stats.search.misses + stats.paper.misses +
                      stats.paperSummary.misses + stats.references.misses;
  const total = totalHits + totalMisses;
  return {
    totalHits,
    totalMisses,
    hitRate: total > 0 ? totalHits / total : 0,
    details: stats,
  };
}

/**
 * Log cache statistics (for monitoring)
 */
export function logCacheStats(): void {
  const stats = getAggregatedStats();
  const hitRatePercent = (stats.hitRate * 100).toFixed(1);

  if (stats.hitRate < 0.3 && (stats.totalHits + stats.totalMisses) > 100) {
    console.warn(`[cache] Low hit rate: ${hitRatePercent}% (${stats.totalHits}/${stats.totalHits + stats.totalMisses})`);
  } else if (process.env.DEBUG) {
    console.error(`[cache] Hit rate: ${hitRatePercent}%`);
  }
}
