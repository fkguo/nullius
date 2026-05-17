import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HEP_PAPERS_CACHE_DIR_ENV,
  cacheEntryPaths,
  computeCacheKey,
  existsInCache,
  getPapersCacheRoot,
  materializeCacheEntry,
  readMetaJson,
} from '../../src/data/papersCache.js';

describe('papersCache pure helpers', () => {
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papers-cache-test-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpRoot;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalEnv;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves cache root from HEP_PAPERS_CACHE_DIR env', () => {
    expect(getPapersCacheRoot()).toBe(tmpRoot);
  });

  it('computes deterministic SHA-256 hex for the same canonical id', () => {
    const a = computeCacheKey('arxiv:2401.09012v3');
    const b = computeCacheKey('arxiv:2401.09012v3');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys for inputs that differ in any byte', () => {
    expect(computeCacheKey('arxiv:2401.09012')).not.toBe(computeCacheKey('arxiv:2401.09012v3'));
    expect(computeCacheKey('arxiv:X')).not.toBe(computeCacheKey('doi:X'));
  });

  it('rejects empty / non-string canonical ids', () => {
    expect(() => computeCacheKey('')).toThrow();
    expect(() => computeCacheKey(undefined as unknown as string)).toThrow();
  });

  it('cacheEntryPaths rejects keys that are not 64-char lowercase hex', () => {
    expect(() => cacheEntryPaths('ABC')).toThrow();
    expect(() => cacheEntryPaths('Z'.repeat(64))).toThrow();
    const key = computeCacheKey('arxiv:1234.5678v1');
    const paths = cacheEntryPaths(key);
    expect(paths.root.startsWith(tmpRoot)).toBe(true);
    expect(paths.metaPath).toBe(path.join(paths.root, 'meta.json'));
    expect(paths.contentDir).toBe(path.join(paths.root, 'content'));
  });

  it('existsInCache returns false for missing entries', () => {
    expect(existsInCache('arxiv:0000.0000v1')).toBe(false);
  });

  it('readMetaJson returns null for missing entries', () => {
    expect(readMetaJson('arxiv:0000.0000v1')).toBeNull();
  });

  it('materializeCacheEntry writes meta.json + content/ atomically on success', async () => {
    const canonical = 'arxiv:0001.0001v1';
    expect(existsInCache(canonical)).toBe(false);
    const { key, entryRoot, alreadyExisted } = await materializeCacheEntry(canonical, async (tmpContentDir) => {
      // Simulate fetcher writing content.
      fs.mkdirSync(path.join(tmpContentDir, 'latex', 'extracted'), { recursive: true });
      fs.writeFileSync(path.join(tmpContentDir, 'latex', 'extracted', 'main.tex'), '\\documentclass{article}\n');
      return { source_type: 'latex', fetched_via: 'arxiv', cross_refs: { arxiv: '0001.0001' } };
    });
    expect(alreadyExisted).toBe(false);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(existsInCache(canonical)).toBe(true);
    expect(fs.existsSync(path.join(entryRoot, 'content', 'latex', 'extracted', 'main.tex'))).toBe(true);
    const meta = readMetaJson(canonical);
    expect(meta?.canonical_id).toBe(canonical);
    expect(meta?.source_type).toBe('latex');
    expect(meta?.fetched_via).toBe('arxiv');
    expect(meta?.cross_refs?.arxiv).toBe('0001.0001');
    expect(meta?.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('materializeCacheEntry rolls back tmp dir if fetcher throws', async () => {
    const canonical = 'arxiv:0002.0002v1';
    await expect(
      materializeCacheEntry(canonical, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsInCache(canonical)).toBe(false);
    // Verify no stale tmp dir left behind.
    const remaining = fs.readdirSync(tmpRoot).filter(n => n.includes('.tmp-'));
    expect(remaining).toEqual([]);
  });

  it('materializeCacheEntry is a no-op fast path when entry already exists', async () => {
    const canonical = 'arxiv:0003.0003v1';
    let fetcherCalls = 0;
    const fetcher = async (tmpContentDir: string) => {
      fetcherCalls += 1;
      fs.writeFileSync(path.join(tmpContentDir, 'marker'), 'x');
      return { source_type: 'pdf' as const, fetched_via: 'manual_import' as const };
    };
    await materializeCacheEntry(canonical, fetcher);
    expect(fetcherCalls).toBe(1);
    const second = await materializeCacheEntry(canonical, fetcher);
    expect(second.alreadyExisted).toBe(true);
    expect(fetcherCalls).toBe(1); // not called again
  });

  it('cache lookup is project-independent: same canonical id → same key', () => {
    // Two different "project_root" envs would not change cache location, because
    // getPapersCacheRoot only consults HEP_PAPERS_CACHE_DIR / home dir.
    const before = process.env.HEP_DATA_DIR;
    process.env.HEP_DATA_DIR = '/tmp/project-A';
    const keyA = computeCacheKey('arxiv:X');
    const rootA = getPapersCacheRoot();
    process.env.HEP_DATA_DIR = '/tmp/project-B';
    const keyB = computeCacheKey('arxiv:X');
    const rootB = getPapersCacheRoot();
    if (before === undefined) delete process.env.HEP_DATA_DIR;
    else process.env.HEP_DATA_DIR = before;
    expect(keyA).toBe(keyB);
    expect(rootA).toBe(rootB);
  });
});
