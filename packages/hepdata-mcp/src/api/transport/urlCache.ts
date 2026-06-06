/**
 * Bounded in-process LRU cache of successful HEPData GET responses, keyed by
 * full URL.
 *
 * Why: the browser-backed challenge solver (PlaywrightSolver) is expensive
 * (launches headless Chromium, solves a JS challenge). Once a URL has been
 * fetched successfully — whether via plain fetch or the browser fallback — its
 * body is cached so subsequent identical GETs are served from memory and the
 * browser path stays rare.
 *
 * Safety of caching: HEPData record/table/download URLs are content-addressed
 * and immutable. `/search/` URLs are not strictly immutable but are acceptable
 * to cache for a process lifetime (results change slowly; the cache is bounded
 * and never persisted). Only successful (2xx) GET responses are stored.
 */

/** A cached response payload: enough to reconstruct an equivalent `Response`. */
export interface CachedResponse {
  status: number;
  /** Plain header map (lower-cased keys not required; `Headers` is rebuilt from this). */
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_MAX_ENTRIES = 256;

/**
 * Minimal LRU built on `Map` insertion-order semantics: on `get` we delete and
 * re-insert the key to mark it most-recently-used; on `set` past capacity we
 * evict the oldest (first) key.
 */
export class UrlCache {
  private readonly store = new Map<string, CachedResponse>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error(`UrlCache maxEntries must be a positive integer, got ${maxEntries}`);
    }
  }

  /** Returns the cached payload and marks it most-recently-used, or undefined. */
  get(url: string): CachedResponse | undefined {
    const hit = this.store.get(url);
    if (hit === undefined) return undefined;
    // Re-insert to move to the most-recently-used end.
    this.store.delete(url);
    this.store.set(url, hit);
    return hit;
  }

  /** Stores a payload, evicting the least-recently-used entry past capacity. */
  set(url: string, value: CachedResponse): void {
    if (this.store.has(url)) {
      this.store.delete(url);
    } else if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(url, value);
  }

  has(url: string): boolean {
    return this.store.has(url);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Process-wide default cache instance used by the rate limiter. Tests can build
 * their own `UrlCache` and inject it via the transport's setter, or call
 * `clear()` between cases.
 */
export const defaultUrlCache = new UrlCache();
