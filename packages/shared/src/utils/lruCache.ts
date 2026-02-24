// ─────────────────────────────────────────────────────────────────────────────
// Cache Statistics Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache statistics for monitoring cache efficiency.
 */
export interface CacheStats {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
  /** Current cache size */
  size: number;
  /** Maximum cache size */
  maxSize: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LRU (Least Recently Used) Cache implementation.
 * Extends Map with automatic eviction of least recently used entries when full.
 *
 * Features:
 * - O(1) get and set operations
 * - Automatic eviction when exceeding maxSize
 * - get() moves entry to "most recently used" position
 * - Built-in hit/miss statistics tracking
 */
export class LRUCache<K, V> extends Map<K, V> {
  private readonly maxSize: number;
  private _hits = 0;
  private _misses = 0;

  constructor(maxSize: number) {
    super();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      this._hits++;
      super.delete(key);
      super.set(key, value);
    } else {
      this._misses++;
    }
    return value;
  }

  set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    } else if (this.size >= this.maxSize) {
      const oldestKey = this.keys().next().value;
      if (oldestKey !== undefined) {
        super.delete(oldestKey);
      }
    }
    return super.set(key, value);
  }

  has(key: K): boolean {
    return super.has(key);
  }

  peek(key: K): V | undefined {
    return super.get(key);
  }

  getStats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
      size: this.size,
      maxSize: this.maxSize,
    };
  }

  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
  }

  getMaxSize(): number {
    return this.maxSize;
  }
}
