import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prunePaperCache } from '../../src/admin/prunePaperCache.js';
import {
  HEP_PAPERS_CACHE_DIR_ENV,
  computeCacheKey,
  materializeCacheEntry,
} from '../../src/data/papersCache.js';

function writePaperJson(paperDir: string, identifier: string): void {
  fs.mkdirSync(paperDir, { recursive: true });
  fs.writeFileSync(
    path.join(paperDir, 'paper.json'),
    JSON.stringify({ version: 1, source: { kind: 'latex', identifier, main_tex: 'main.tex' } }),
  );
}

async function plantCacheEntry(canonicalId: string, marker = 'X'): Promise<string> {
  const { key } = await materializeCacheEntry(canonicalId, async (tmpContent) => {
    fs.mkdirSync(path.join(tmpContent, 'latex', 'extracted'), { recursive: true });
    fs.writeFileSync(path.join(tmpContent, 'latex', 'extracted', 'main.tex'), marker);
    return { source_type: 'latex', fetched_via: 'manual_import', main_path: 'latex/extracted/main.tex' };
  });
  return key;
}

describe('prunePaperCache', () => {
  let tmpProjectA: string;
  let tmpProjectB: string;
  let tmpCacheDir: string;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpProjectA = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-proj-a-'));
    tmpProjectB = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-proj-b-'));
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-cache-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpProjectA, { recursive: true, force: true });
    fs.rmSync(tmpProjectB, { recursive: true, force: true });
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  function makePaperDir(projectRoot: string, projectId: string, paperId: string): string {
    return path.join(projectRoot, 'artifacts', 'hep-mcp', 'projects', projectId, 'papers', paperId);
  }

  it('rejects empty project_roots list (would orphan everything)', async () => {
    await expect(prunePaperCache({ project_roots: [] })).rejects.toThrow(/at least one absolute path/);
  });

  it('returns empty plan when cache root is empty', async () => {
    const r = await prunePaperCache({ project_roots: [tmpProjectA] });
    expect(r.plans).toEqual([]);
    expect(r.summary.total_cache_entries).toBe(0);
    expect(r.dry_run).toBe(true);
    expect(r.schema_version).toBe(1);
  });

  it('classifies a cache entry as keep_referenced when its canonical_id appears in paper.json', async () => {
    await plantCacheEntry('arxiv:2401.09012v3');
    writePaperJson(makePaperDir(tmpProjectA, 'p1', 'arxiv-X'), 'arxiv:2401.09012v3');

    const r = await prunePaperCache({ project_roots: [tmpProjectA] });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]!.action).toBe('keep_referenced');
    expect(r.plans[0]!.canonical_id).toBe('arxiv:2401.09012v3');
    expect(r.plans[0]!.referenced_by).toEqual([path.resolve(tmpProjectA)]);
    expect(r.summary.total_referenced).toBe(1);
  });

  it('classifies a cache entry as delete_orphan when no project_root references it', async () => {
    await plantCacheEntry('arxiv:9999.99999v1');
    writePaperJson(makePaperDir(tmpProjectA, 'p1', 'arxiv-other'), 'arxiv:2401.09012v3');

    const r = await prunePaperCache({ project_roots: [tmpProjectA] });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]!.action).toBe('delete_orphan');
    expect(r.plans[0]!.canonical_id).toBe('arxiv:9999.99999v1');
    expect(r.summary.total_orphans).toBe(1);
    expect(r.summary.total_to_free_bytes).toBeGreaterThan(0);
  });

  it('apply=true actually deletes orphan entries and preserves referenced ones', async () => {
    await plantCacheEntry('arxiv:KEEP.v1', 'KEEP');
    await plantCacheEntry('arxiv:DROP.v1', 'DROP');
    writePaperJson(makePaperDir(tmpProjectA, 'p1', 'arxiv-KEEP'), 'arxiv:KEEP.v1');

    const keyKeep = computeCacheKey('arxiv:KEEP.v1');
    const keyDrop = computeCacheKey('arxiv:DROP.v1');

    const r = await prunePaperCache({ project_roots: [tmpProjectA], apply: true });
    expect(r.dry_run).toBe(false);
    expect(fs.existsSync(path.join(tmpCacheDir, keyKeep))).toBe(true);
    expect(fs.existsSync(path.join(tmpCacheDir, keyDrop))).toBe(false);

    const dropPlan = r.plans.find(p => p.cache_key === keyDrop);
    expect(dropPlan?.action).toBe('delete_orphan');
    expect(dropPlan?.applied).toBe(true);
  });

  it('union references across multiple project_roots', async () => {
    await plantCacheEntry('arxiv:SHARED.v1');
    await plantCacheEntry('arxiv:A_ONLY.v1');
    await plantCacheEntry('arxiv:B_ONLY.v1');
    writePaperJson(makePaperDir(tmpProjectA, 'p1', 'arxiv-shared'), 'arxiv:SHARED.v1');
    writePaperJson(makePaperDir(tmpProjectA, 'p1', 'arxiv-a-only'), 'arxiv:A_ONLY.v1');
    writePaperJson(makePaperDir(tmpProjectB, 'p2', 'arxiv-shared'), 'arxiv:SHARED.v1');
    writePaperJson(makePaperDir(tmpProjectB, 'p2', 'arxiv-b-only'), 'arxiv:B_ONLY.v1');

    const r = await prunePaperCache({ project_roots: [tmpProjectA, tmpProjectB] });
    const byAction = r.plans.reduce<Record<string, number>>((acc, p) => {
      acc[p.action] = (acc[p.action] ?? 0) + 1;
      return acc;
    }, {});
    expect(byAction.keep_referenced).toBe(3);
    expect(byAction.delete_orphan ?? 0).toBe(0);

    const shared = r.plans.find(p => p.canonical_id === 'arxiv:SHARED.v1');
    expect(shared?.referenced_by).toHaveLength(2);
  });

  it('cleans up leftover tmp staging dirs as delete_tmp_staging', async () => {
    // Simulate an interrupted materialization: directory matching the
    // <key>.tmp-<suffix> pattern.
    const tmpStaging = path.join(tmpCacheDir, 'abc123.tmp-abcdef');
    fs.mkdirSync(path.join(tmpStaging, 'content'), { recursive: true });
    fs.writeFileSync(path.join(tmpStaging, 'content', 'foo'), 'leftover');

    const r = await prunePaperCache({ project_roots: [tmpProjectA], apply: true });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]!.action).toBe('delete_tmp_staging');
    expect(r.plans[0]!.applied).toBe(true);
    expect(fs.existsSync(tmpStaging)).toBe(false);
  });

  it('preserves cache entries without readable meta.json as keep_unrecognized', async () => {
    // Manually plant an entry without meta.json.
    const fakeKey = '0'.repeat(64);
    const fakeDir = path.join(tmpCacheDir, fakeKey);
    fs.mkdirSync(path.join(fakeDir, 'content'), { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'content', 'mystery.txt'), 'no meta\n');

    const r = await prunePaperCache({ project_roots: [tmpProjectA], apply: true });
    expect(r.plans[0]!.action).toBe('keep_unrecognized');
    expect(fs.existsSync(fakeDir)).toBe(true); // not deleted
    expect(r.summary.total_unrecognized).toBe(1);
  });

  it('preserves cache entries whose meta.canonical_id does not hash to the directory name (corruption)', async () => {
    // Plant a corrupted cache entry: dir name says one thing, meta says another.
    const fakeKey = '0'.repeat(64);
    const fakeDir = path.join(tmpCacheDir, fakeKey);
    fs.mkdirSync(path.join(fakeDir, 'content'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeDir, 'meta.json'),
      JSON.stringify({ canonical_id: 'arxiv:NOTHASHING.v1', source_type: 'latex', fetched_via: 'manual_import', fetched_at: '2026-01-01T00:00:00Z' }),
    );

    const r = await prunePaperCache({ project_roots: [tmpProjectA] });
    expect(r.plans[0]!.action).toBe('keep_unrecognized');
    expect(r.plans[0]!.reason).toContain('does not hash');
  });

  it('skips cache entries with non-hex directory names as keep_unrecognized', async () => {
    const fakeDir = path.join(tmpCacheDir, 'not-a-hash');
    fs.mkdirSync(fakeDir, { recursive: true });

    const r = await prunePaperCache({ project_roots: [tmpProjectA] });
    expect(r.plans[0]!.action).toBe('keep_unrecognized');
    expect(r.plans[0]!.reason).toContain('64-char lowercase hex');
  });

  it('refuses to delete paths outside the cache root (containment guard)', async () => {
    // This is largely an internal invariant — externally we just verify the
    // applyPlan path doesn't escape. We simulate by patching a plan's
    // cache_entry_dir AFTER planning. The applyPlan function isn't exported,
    // so this is a smoke test through the public API: with a non-malicious
    // input, the report's cache_entry_dir for every plan resides under the
    // cache root.
    await plantCacheEntry('arxiv:GUARD.v1');
    const r = await prunePaperCache({ project_roots: [tmpProjectA] });
    for (const plan of r.plans) {
      expect(path.resolve(plan.cache_entry_dir).startsWith(path.resolve(tmpCacheDir))).toBe(true);
    }
  });
});
