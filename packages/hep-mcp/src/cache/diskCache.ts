/**
 * Persistent Disk Cache
 * File-based cache with TTL, LRU eviction, and gzip compression
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { getCacheDir } from '../data/dataDir.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface CacheIndex {
  entries: Record<string, { timestamp: number; ttl: number; size: number }>;
  totalSize: number;
  lastCleanup: number;
}

export interface DiskCacheOptions {
  cacheDir?: string;
  maxSizeBytes?: number;
  defaultTtlMs?: number;
  cleanupIntervalMs?: number;
}

export interface DiskCacheStats {
  entries: number;
  totalSizeBytes: number;
  hits: number;
  misses: number;
  hitRate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultCacheDir(): string {
  return getCacheDir();
}
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100 MB
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const INDEX_FILE = '_index.json';

// ─────────────────────────────────────────────────────────────────────────────
// DiskCache Class
// ─────────────────────────────────────────────────────────────────────────────

export class DiskCache {
  private cacheDir: string;
  private maxSizeBytes: number;
  private defaultTtlMs: number;
  private cleanupIntervalMs: number;
  private index: CacheIndex;
  private hits = 0;
  private misses = 0;

  constructor(options: DiskCacheOptions = {}) {
    this.cacheDir = options.cacheDir || getDefaultCacheDir();
    this.maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE;
    this.defaultTtlMs = options.defaultTtlMs || DEFAULT_TTL;
    this.cleanupIntervalMs = options.cleanupIntervalMs || CLEANUP_INTERVAL;
    this.index = this.loadIndex();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    const indexEntry = this.index.entries[key];
    if (!indexEntry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (this.isExpired(indexEntry.timestamp, indexEntry.ttl)) {
      this.misses++;
      await this.delete(key);
      return null;
    }

    try {
      const filePath = this.getFilePath(key);
      const compressed = await fs.promises.readFile(filePath);
      const decompressed = await gunzip(compressed);
      const entry = JSON.parse(decompressed.toString()) as CacheEntry<T>;

      this.hits++;
      return entry.data;
    } catch {
      // Corrupted/missing cache entry - delete and return null
      this.misses++;
      await this.delete(key);
      return null;
    }
  }

  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    const ttlMs = ttl || this.defaultTtlMs;
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    };

    try {
      await this.ensureCacheDir();

      const json = JSON.stringify(entry);
      const compressed = await gzip(json);
      const filePath = this.getFilePath(key);

      await fs.promises.writeFile(filePath, compressed);

      // Update index
      const size = compressed.length;
      if (this.index.entries[key]) {
        this.index.totalSize -= this.index.entries[key].size;
      }
      this.index.entries[key] = { timestamp: Date.now(), ttl: ttlMs, size };
      this.index.totalSize += size;

      await this.saveIndex();

      // Cleanup if needed
      await this.maybeCleanup();
    } catch (err) {
      // Silently fail - cache is optional
      console.error('DiskCache set error:', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }

      if (this.index.entries[key]) {
        this.index.totalSize -= this.index.entries[key].size;
        delete this.index.entries[key];
        await this.saveIndex();
      }
    } catch {
      // Ignore errors
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.cacheDir);
      await Promise.all(
        files.map(file => fs.promises.unlink(path.join(this.cacheDir, file)))
      );
      this.index = { entries: {}, totalSize: 0, lastCleanup: Date.now() };
      this.hits = 0;
      this.misses = 0;
    } catch {
      // Ignore errors
    }
  }

  getStats(): DiskCacheStats {
    const total = this.hits + this.misses;
    return {
      entries: Object.keys(this.index.entries).length,
      totalSizeBytes: this.index.totalSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private getFilePath(key: string): string {
    // Hash key to create safe filename
    const hash = this.hashKey(key);
    return path.join(this.cacheDir, `${hash}.gz`);
  }

  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  private isExpired(timestamp: number, ttl: number): boolean {
    return Date.now() - timestamp > ttl;
  }

  private async ensureCacheDir(): Promise<void> {
    if (!fs.existsSync(this.cacheDir)) {
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
    }
  }

  private loadIndex(): CacheIndex {
    try {
      const indexPath = path.join(this.cacheDir, INDEX_FILE);
      if (fs.existsSync(indexPath)) {
        const data = fs.readFileSync(indexPath, 'utf-8');
        return JSON.parse(data);
      }
    } catch {
      // Ignore errors
    }
    return { entries: {}, totalSize: 0, lastCleanup: Date.now() };
  }

  private async saveIndex(): Promise<void> {
    try {
      await this.ensureCacheDir();
      const indexPath = path.join(this.cacheDir, INDEX_FILE);
      await fs.promises.writeFile(indexPath, JSON.stringify(this.index));
    } catch {
      // Ignore errors
    }
  }

  private async maybeCleanup(): Promise<void> {
    const now = Date.now();

    // Check if cleanup is needed
    if (now - this.index.lastCleanup < this.cleanupIntervalMs &&
        this.index.totalSize < this.maxSizeBytes) {
      return;
    }

    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Remove expired entries (parallel deletion)
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of Object.entries(this.index.entries)) {
      if (this.isExpired(entry.timestamp, entry.ttl)) {
        expiredKeys.push(key);
      }
    }

    // Delete expired keys in parallel
    if (expiredKeys.length > 0) {
      await Promise.all(expiredKeys.map(key => this.delete(key)));
    }

    // LRU eviction if still over size limit
    if (this.index.totalSize > this.maxSizeBytes) {
      const entries = Object.entries(this.index.entries)
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      while (this.index.totalSize > this.maxSizeBytes * 0.8 && entries.length > 0) {
        const [key] = entries.shift()!;
        await this.delete(key);
      }
    }

    this.index.lastCleanup = now;
    await this.saveIndex();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

let diskCacheInstance: DiskCache | null = null;

export function getDiskCache(options?: DiskCacheOptions): DiskCache {
  if (!diskCacheInstance) {
    diskCacheInstance = new DiskCache(options);
  }
  return diskCacheInstance;
}

export function resetDiskCache(): void {
  diskCacheInstance = null;
}
