/**
 * papersCache — content-addressable, user-global paper cache.
 *
 * The cache lives at `~/.autoresearch/hep-mcp/papers_cache/` (overridable via
 * HEP_PAPERS_CACHE_DIR) and is INDEPENDENT of HEP_DATA_DIR resolution.
 *
 * Per the Tier 1/2/3 storage model in docs/ARCHITECTURE.md:
 *   - Tier 3 (this module): regeneratable content, user-global, deduplicated
 *     across projects. Same identifier on any machine → same hash → same path.
 *   - Tier 2 (HEP_DATA_DIR/projects/<id>/papers/<paper_id>/source) holds a
 *     symlink into this cache.
 *
 * Layout per cache entry:
 *   papers_cache/<sha256-of-canonical-id>/
 *     ├── meta.json     { canonical_id, source_type, fetched_via, fetched_at, ... }
 *     └── content/
 *         ├── latex/extracted/...        (if source_type === 'latex')
 *         └── pdf/paper.pdf              (if source_type === 'pdf')
 *
 * Atomicity: materialization writes to a tmp sibling dir and renames into place.
 * Two concurrent fetches of the same identifier race; the loser cleans its tmp.
 *
 * This module is intentionally identifier-scheme-agnostic. The dispatcher in
 * papersCacheFetch.ts maps an input identifier to a canonical form and chooses
 * the right provider tooling.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const HEP_PAPERS_CACHE_DIR_ENV = 'HEP_PAPERS_CACHE_DIR';

export type PaperSourceType = 'latex' | 'pdf';
export type PaperFetchedVia = 'arxiv' | 'zotero' | 'manual_import' | 'inspire-resolved-arxiv';

export interface PaperCacheMeta {
  canonical_id: string; // e.g. "arxiv:2401.09012v3", "zotero:lib/key", "doi:10.x/..."
  source_type: PaperSourceType;
  fetched_via: PaperFetchedVia;
  fetched_at: string; // ISO 8601 UTC
  /**
   * Optional relative path (inside content/) to the "primary" source file:
   *   - latex sources: usually `latex/extracted/main.tex` (depends on the
   *     project's tex tree).
   *   - pdf sources: usually `pdf/paper.pdf`.
   * Consumers that need to open the paper deterministically (e.g.
   * `buildProjectEvidenceCatalog`) read this rather than scanning the tree.
   */
  main_path?: string;
  /** Other identifiers known to refer to the same paper (informational; never used as cache key). */
  cross_refs?: Record<string, string>;
}

export interface CacheEntryPaths {
  root: string;
  metaPath: string;
  contentDir: string;
}

/**
 * Resolve the papers cache root.
 *
 * Resolution order:
 *   1. HEP_PAPERS_CACHE_DIR env (must be an absolute path)
 *   2. <home>/.autoresearch/hep-mcp/papers_cache
 *
 * This is INDEPENDENT of HEP_DATA_DIR / project_root — the cache is always
 * user-global so the same paper is dedup'd across projects, worktrees, and
 * autoresearch sub-projects.
 */
export function getPapersCacheRoot(): string {
  const override = process.env[HEP_PAPERS_CACHE_DIR_ENV];
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), '.autoresearch', 'hep-mcp', 'papers_cache');
}

/**
 * Compute the cache key (filename-safe hex) for a fully-canonical identifier.
 *
 * The caller is responsible for canonicalization (e.g. version-pinning arxiv
 * ids). Two strings that differ in any byte produce different keys; this is by
 * design — `arxiv:2401.09012v3` and `arxiv:2401.09012v4` are different content.
 */
export function computeCacheKey(canonicalId: string): string {
  if (!canonicalId || typeof canonicalId !== 'string') {
    throw new Error(`computeCacheKey: canonical_id must be a non-empty string, got ${JSON.stringify(canonicalId)}`);
  }
  return crypto.createHash('sha256').update(canonicalId, 'utf-8').digest('hex');
}

export function cacheEntryPaths(key: string): CacheEntryPaths {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`cacheEntryPaths: key must be a 64-char lowercase hex sha256, got ${JSON.stringify(key)}`);
  }
  const root = path.join(getPapersCacheRoot(), key);
  return {
    root,
    metaPath: path.join(root, 'meta.json'),
    contentDir: path.join(root, 'content'),
  };
}

/** Does the cache already have a complete entry for this canonical identifier? */
export function existsInCache(canonicalId: string): boolean {
  const key = computeCacheKey(canonicalId);
  const paths = cacheEntryPaths(key);
  // A "complete" entry has BOTH meta.json AND content/. An entry with only
  // one is treated as in-progress / corrupt and should be ignored (the
  // materializer's atomic rename only commits when both exist).
  return fs.existsSync(paths.metaPath) && fs.existsSync(paths.contentDir);
}

/** Read meta.json for a cache entry, or null if missing/unreadable. */
export function readMetaJson(canonicalId: string): PaperCacheMeta | null {
  const key = computeCacheKey(canonicalId);
  const paths = cacheEntryPaths(key);
  try {
    const raw = fs.readFileSync(paths.metaPath, 'utf-8');
    return JSON.parse(raw) as PaperCacheMeta;
  } catch {
    return null;
  }
}

export interface FetcherResult {
  source_type: PaperSourceType;
  fetched_via: PaperFetchedVia;
  /** Optional relative path (inside the tmp content dir) to the primary source file. */
  main_path?: string;
  /** Optional informational cross-references (e.g. {"doi": "10.1103/...", "inspire_recid": "1234567"}). */
  cross_refs?: Record<string, string>;
}

export type Fetcher = (tmpContentDir: string) => Promise<FetcherResult>;

/**
 * Atomically materialize a cache entry by running `fetcher` against a tmp
 * directory and committing it into the final cache slot.
 *
 * Concurrency: if another process completes the same entry first, our tmp is
 * discarded and we report success (cache hit via race winner).
 *
 * The fetcher receives a fresh `tmpContentDir` and must write all content
 * under it. It returns the meta fields the cache layer doesn't infer
 * (source_type, fetched_via, cross_refs). canonical_id and fetched_at are
 * injected by the cache layer.
 */
export async function materializeCacheEntry(
  canonicalId: string,
  fetcher: Fetcher,
): Promise<{ key: string; entryRoot: string; alreadyExisted: boolean }> {
  const key = computeCacheKey(canonicalId);
  const paths = cacheEntryPaths(key);

  // Fast path: already complete.
  if (existsInCache(canonicalId)) {
    return { key, entryRoot: paths.root, alreadyExisted: true };
  }

  // Ensure parent dir exists.
  fs.mkdirSync(getPapersCacheRoot(), { recursive: true });

  // tmp slot: same parent, random suffix to avoid collisions.
  const tmpSuffix = crypto.randomBytes(6).toString('hex');
  const tmpRoot = path.join(getPapersCacheRoot(), `${key}.tmp-${tmpSuffix}`);
  const tmpContent = path.join(tmpRoot, 'content');
  fs.mkdirSync(tmpContent, { recursive: true });

  try {
    const result = await fetcher(tmpContent);

    const meta: PaperCacheMeta = {
      canonical_id: canonicalId,
      source_type: result.source_type,
      fetched_via: result.fetched_via,
      fetched_at: new Date().toISOString(),
      main_path: result.main_path,
      cross_refs: result.cross_refs,
    };
    fs.writeFileSync(path.join(tmpRoot, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf-8' });

    // Atomic commit. POSIX rename of one dir onto another fails if target
    // exists and is non-empty (ENOTEMPTY) — that means we lost the race.
    try {
      fs.renameSync(tmpRoot, paths.root);
      return { key, entryRoot: paths.root, alreadyExisted: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR') {
        // Another process won. Discard our work, report success.
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        if (existsInCache(canonicalId)) {
          return { key, entryRoot: paths.root, alreadyExisted: true };
        }
        // Pathological: rename failed but cache still incomplete. Surface as error.
        throw new Error(`materializeCacheEntry: rename failed (${code}) but cache entry is incomplete at ${paths.root}`);
      }
      throw err;
    }
  } catch (err) {
    // Roll back tmp on any fetcher / write failure.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}
