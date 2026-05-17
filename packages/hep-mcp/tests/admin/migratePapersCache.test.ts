import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migratePapersCache } from '../../src/admin/migratePapersCache.js';
import {
  HEP_PAPERS_CACHE_DIR_ENV,
  computeCacheKey,
  existsInCache,
  readMetaJson,
} from '../../src/data/papersCache.js';

function writePaperJson(paperDir: string, identifier: string, mainTex = 'main.tex'): void {
  fs.mkdirSync(paperDir, { recursive: true });
  const payload = {
    version: 1,
    project_id: 'proj_test',
    paper_id: path.basename(paperDir),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    source: { kind: 'latex', identifier, main_tex: mainTex },
  };
  fs.writeFileSync(path.join(paperDir, 'paper.json'), JSON.stringify(payload, null, 2));
}

function writeExtractedDir(paperDir: string, files: Record<string, string>): string {
  const extracted = path.join(paperDir, 'sources', 'latex', 'extracted');
  fs.mkdirSync(extracted, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(extracted, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return extracted;
}

describe('migratePapersCache', () => {
  let tmpProjectRoot: string;
  let tmpCacheDir: string;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-project-'));
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-cache-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpProjectRoot, { recursive: true, force: true });
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  function makePaperDir(projectId: string, paperId: string): string {
    return path.join(tmpProjectRoot, 'artifacts', 'hep-mcp', 'projects', projectId, 'papers', paperId);
  }

  it('returns empty plan when projects/ does not exist', async () => {
    const r = await migratePapersCache({ project_root: tmpProjectRoot });
    expect(r.plans).toEqual([]);
    expect(r.summary.total_papers_scanned).toBe(0);
    expect(r.dry_run).toBe(true);
  });

  it('plans move_to_cache for fresh real-dir extracted/ (dry-run does not modify)', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv-2401.09012');
    writePaperJson(paperDir, 'arxiv:2401.09012v3');
    const extracted = writeExtractedDir(paperDir, {
      'main.tex': '\\documentclass{article}\n',
      'refs.bib': '@article{x}\n',
    });

    const r = await migratePapersCache({ project_root: tmpProjectRoot });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]!.action).toBe('move_to_cache');
    expect(r.plans[0]!.canonical_id).toBe('arxiv:2401.09012v3');
    expect(r.plans[0]!.size_bytes).toBeGreaterThan(0);
    expect(r.summary.total_eligible).toBe(1);
    expect(r.summary.total_relocated_bytes).toBeGreaterThan(0);

    // Dry-run: real dir untouched, cache untouched
    expect(fs.lstatSync(extracted).isDirectory()).toBe(true);
    expect(existsInCache('arxiv:2401.09012v3')).toBe(false);
  });

  it('applies move_to_cache: real dir → cache, swaps in symlink', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv-2401.09012');
    writePaperJson(paperDir, 'arxiv:2401.09012v3');
    const extracted = writeExtractedDir(paperDir, {
      'main.tex': '\\documentclass{article}\nMOVED-TO-CACHE-MARKER\n',
    });

    const r = await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    expect(r.plans[0]!.applied).toBe(true);
    expect(r.plans[0]!.error).toBeUndefined();

    // After apply: extracted/ is a symlink into the cache
    const lst = fs.lstatSync(extracted);
    expect(lst.isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(extracted);
    expect(path.resolve(target).startsWith(tmpCacheDir)).toBe(true);

    // Cache content is reachable through the symlink
    const contentMain = fs.readFileSync(path.join(extracted, 'main.tex'), 'utf-8');
    expect(contentMain).toContain('MOVED-TO-CACHE-MARKER');

    // Meta.json recorded canonical id + main_path
    expect(existsInCache('arxiv:2401.09012v3')).toBe(true);
    const meta = readMetaJson('arxiv:2401.09012v3');
    expect(meta?.canonical_id).toBe('arxiv:2401.09012v3');
    expect(meta?.main_path).toBe('latex/extracted/main.tex');
    expect(meta?.fetched_via).toBe('manual_import');
  });

  it('plans replace_with_symlink when the cache already has the entry', async () => {
    // First project: migrate to populate cache
    const paperA = makePaperDir('proj_a', 'arxiv-2401.09012');
    writePaperJson(paperA, 'arxiv:2401.09012v3');
    writeExtractedDir(paperA, { 'main.tex': 'A\n' });
    await migratePapersCache({ project_root: tmpProjectRoot, apply: true });

    // Second project (different proj_id, SAME identifier): cache should hit
    const paperB = makePaperDir('proj_b', 'arxiv-2401.09012');
    writePaperJson(paperB, 'arxiv:2401.09012v3');
    const extractedB = writeExtractedDir(paperB, { 'main.tex': 'B-different-bytes\n' });

    const r = await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    const planB = r.plans.find(p => p.project_id === 'proj_b');
    expect(planB?.action).toBe('replace_with_symlink');
    expect(planB?.applied).toBe(true);

    // proj_b's extracted is now a symlink to the SAME cache as proj_a → content is A's bytes, not B's
    expect(fs.lstatSync(extractedB).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(extractedB, 'main.tex'), 'utf-8')).toBe('A\n');
    expect(r.summary.total_freed_bytes).toBeGreaterThan(0);
  });

  it('skips already-symlinked extracted/ (idempotent rerun)', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv-2401.09012');
    writePaperJson(paperDir, 'arxiv:2401.09012v3');
    writeExtractedDir(paperDir, { 'main.tex': 'X\n' });

    // First apply
    await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    // Second run on the same tree
    const r = await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    expect(r.plans[0]!.action).toBe('skip_symlink');
    expect(r.summary.total_skipped).toBe(1);
    expect(r.summary.total_eligible).toBe(0);
  });

  it('reports error_no_identifier when paper.json lacks source.identifier and paper_id is not arxiv-shaped', async () => {
    const paperDir = makePaperDir('proj_a', 'manual-paper-foo');
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(
      path.join(paperDir, 'paper.json'),
      JSON.stringify({ version: 1, source: { kind: 'latex', main_tex: 'main.tex' } }),
    );
    writeExtractedDir(paperDir, { 'main.tex': 'x\n' });

    const r = await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    expect(r.plans[0]!.action).toBe('error_no_identifier');
    expect(r.summary.total_errors).toBe(1);
    expect(fs.lstatSync(path.join(paperDir, 'sources', 'latex', 'extracted')).isDirectory()).toBe(true);
  });

  it('reports error_no_identifier when paper.json lacks identifier (no fallback to paperId)', async () => {
    // Production paperIds use `arxiv_2401_09012v3` (underscores per
    // core/evidence.ts:makePaperId), not `arxiv-` — so deriving an identifier
    // from the directory name would be ambiguous for legacy slash-form ids
    // (cond-mat.stat-mech/9501234 → arxiv_cond-mat_stat-mech_9501234, can't
    // reliably un-flatten). The migration tool requires paper.json to carry
    // the identifier explicitly; the fallback was removed deliberately.
    const paperDir = makePaperDir('proj_a', 'arxiv_2401_09012v3');
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(
      path.join(paperDir, 'paper.json'),
      JSON.stringify({ version: 1, source: { kind: 'latex', main_tex: 'main.tex' } }),
    );
    writeExtractedDir(paperDir, { 'main.tex': 'x\n' });

    const r = await migratePapersCache({ project_root: tmpProjectRoot });
    expect(r.plans[0]!.action).toBe('error_no_identifier');
  });

  it('trims and normalizes whitespace inside paper.json identifier (defense against hand edits)', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv_2401_09012v3');
    writePaperJson(paperDir, '  arxiv: 2401.09012v3  ');
    writeExtractedDir(paperDir, { 'main.tex': 'x\n' });

    const r = await migratePapersCache({ project_root: tmpProjectRoot });
    expect(r.plans[0]!.canonical_id).toBe('arxiv:2401.09012v3');
  });

  it('rejects absolute / .. main_tex paths in paper.json (path injection defense)', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv_2401_09012v3');
    writePaperJson(paperDir, 'arxiv:2401.09012v3', '/etc/passwd');
    writeExtractedDir(paperDir, { 'main.tex': 'x\n' });

    const r = await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    expect(r.plans[0]!.applied).toBe(true);
    // meta.json should reflect the probed fallback main.tex (not /etc/passwd).
    expect(existsInCache('arxiv:2401.09012v3')).toBe(true);
    const meta = readMetaJson('arxiv:2401.09012v3');
    expect(meta?.main_path).toBe('latex/extracted/main.tex');
  });

  it('reports error_pdf_source when source.kind is pdf (not yet handled)', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv-2401.09012');
    fs.mkdirSync(paperDir, { recursive: true });
    fs.writeFileSync(
      path.join(paperDir, 'paper.json'),
      JSON.stringify({ version: 1, source: { kind: 'pdf', identifier: 'doi:10.1/X' } }),
    );
    writeExtractedDir(paperDir, { 'main.tex': 'x\n' });

    const r = await migratePapersCache({ project_root: tmpProjectRoot });
    expect(r.plans[0]!.action).toBe('error_pdf_source');
  });

  it('skips absent extracted/ and unrelated dirs cleanly', async () => {
    const paperDir = makePaperDir('proj_a', 'arxiv-2401.09012');
    writePaperJson(paperDir, 'arxiv:2401.09012v3');
    // No extracted/ created.

    const r = await migratePapersCache({ project_root: tmpProjectRoot });
    expect(r.plans[0]!.action).toBe('skip_absent');
  });

  it('handles multiple papers across multiple projects in one run', async () => {
    const cases = [
      ['proj_a', 'arxiv-2401.09012', 'arxiv:2401.09012v3'],
      ['proj_a', 'arxiv-1407.3669', 'arxiv:1407.3669'],
      ['proj_b', 'arxiv-2401.09012', 'arxiv:2401.09012v3'], // dup with proj_a
    ];
    for (const [proj, paper, ident] of cases) {
      const pd = makePaperDir(proj, paper);
      writePaperJson(pd, ident);
      writeExtractedDir(pd, { 'main.tex': `${proj}-${paper}\n` });
    }

    const r = await migratePapersCache({ project_root: tmpProjectRoot, apply: true });
    expect(r.plans).toHaveLength(3);
    expect(r.summary.total_eligible).toBe(3);
    expect(r.summary.total_errors).toBe(0);

    // 2 unique cache entries (arxiv:2401.09012v3 dedup'd, arxiv:1407.3669 alone)
    const keysSeen = new Set(r.plans.map(p => p.cache_key));
    expect(keysSeen.size).toBe(2);
  });
});
