/**
 * Disk Cache Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DiskCache, resetDiskCache } from '../../src/cache/diskCache.js';

describe('DiskCache', () => {
  let cache: DiskCache;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `hep-research-mcp-test-${Date.now()}`);
    cache = new DiskCache({ cacheDir: testDir, defaultTtlMs: 60000 });
  });

  afterEach(async () => {
    await cache.clear();
    resetDiskCache();
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('basic operations', () => {
    it('should set and get values', async () => {
      await cache.set('key1', { foo: 'bar' });
      const result = await cache.get<{ foo: string }>('key1');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('should return null for missing keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should delete values', async () => {
      await cache.set('key1', 'value1');
      await cache.delete('key1');
      const result = await cache.get('key1');
      expect(result).toBeNull();
    });

    it('should clear all values', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.clear();

      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
    });
  });

  describe('TTL', () => {
    it('should expire entries after TTL', async () => {
      vi.useFakeTimers();
      try {
        const shortTtlCache = new DiskCache({
          cacheDir: testDir,
          defaultTtlMs: 50, // 50ms TTL
        });

        await shortTtlCache.set('expiring', 'value');

        // Should exist immediately
        expect(await shortTtlCache.get('expiring')).toBe('value');

        // Wait for expiration
        await vi.advanceTimersByTimeAsync(100);

        // Should be expired
        expect(await shortTtlCache.get('expiring')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('stats', () => {
    it('should track hits and misses', async () => {
      await cache.set('key1', 'value1');

      await cache.get('key1'); // hit
      await cache.get('key1'); // hit
      await cache.get('missing'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.667, 2);
    });

    it('should track entry count', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');

      const stats = cache.getStats();
      expect(stats.entries).toBe(2);
    });
  });

  describe('compression', () => {
    it('should compress large data', async () => {
      const largeData = { content: 'x'.repeat(10000) };
      await cache.set('large', largeData);

      const result = await cache.get<typeof largeData>('large');
      expect(result).toEqual(largeData);
    });
  });
});
