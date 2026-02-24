/**
 * Resolver Cache
 *
 * LRU cache for citekey → recid resolution results.
 * Implements R3 requirements: true LRU, TTL, negative caching.
 */

import type { BibEntryIdentifiers, ResolutionMethod } from './types.js';
import { normalizeJournal } from './resolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_SUCCESS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_TTL_FAILURE = 1 * 24 * 60 * 60 * 1000; // 1 day (negative cache)
const CACHE_MAX_SIZE = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolverCacheEntry {
  recid: string | null;
  resolutionMethod: ResolutionMethod;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True LRU cache for resolver results
 * Uses Map's insertion order for LRU eviction
 */
class ResolverCache {
  private cache = new Map<string, ResolverCacheEntry>();

  /**
   * Get cached entry (with LRU bump)
   * R2 P0-1: delete+set on hit to refresh order
   */
  get(key: string): ResolverCacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL
    const ttl = entry.recid ? CACHE_TTL_SUCCESS : CACHE_TTL_FAILURE;
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return null;
    }

    // LRU bump: delete + set to move to end
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  /**
   * Set cache entry
   */
  set(key: string, recid: string | null, method: ResolutionMethod): void {
    // Remove existing entry if present
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= CACHE_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, {
      recid,
      resolutionMethod: method,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if key exists (without LRU bump)
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    const ttl = entry.recid ? CACHE_TTL_SUCCESS : CACHE_TTL_FAILURE;
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache Key Normalization (R3 P0-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize cache key from bib entry identifiers
 * Priority: recid > DOI > arXiv > Journal+Volume+Page > citekey
 */
export function normalizeCacheKey(ids: BibEntryIdentifiers): string {
  // 1. INSPIRE recid (if already known)
  if (ids.inspire) {
    const recid = ids.inspire.replace(/\D/g, '');
    return `recid:${recid}`;
  }

  // 2. DOI (normalized: lowercase, remove prefix)
  if (ids.doi) {
    let doi = ids.doi.trim().toLowerCase();
    doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
    return `doi:${doi}`;
  }

  // 3. arXiv ID (normalized: remove prefix)
  const arxiv = ids.arxiv || ids.eprint;
  if (arxiv) {
    let normalized = arxiv.trim().toLowerCase();
    normalized = normalized.replace(/^arxiv:/i, '');
    normalized = normalized.replace(/v\d+$/, ''); // Remove version
    return `arxiv:${normalized}`;
  }

  // 4. Journal + Volume + Page (for old papers)
  if (ids.journal && ids.volume && ids.page) {
    const normJournal = normalizeJournal(ids.journal);
    const normVolume = ids.volume.replace(/\D/g, '');
    const normPage = ids.page.replace(/\D/g, '').split('-')[0];
    return `journal:${normJournal}.${normVolume}.${normPage}`;
  }

  // 5. Citekey fallback
  return `citekey:${ids.citekey}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────────────────────

export const resolverCache = new ResolverCache();
