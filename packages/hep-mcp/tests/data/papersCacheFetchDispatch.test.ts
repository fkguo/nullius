/**
 * Integration-style tests for ensureInCache's scheme dispatch. We mock the
 * arxivCompat / resolveArxivId / inspireLookupByDOI / getPaperContent surface
 * so the tests exercise the dispatcher logic without hitting the network.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/arxivCompat.js', () => ({
  getPaperContent: vi.fn(),
}));
vi.mock('../../src/utils/resolveArxivId.js', () => ({
  resolveArxivId: vi.fn(),
}));
vi.mock('../../src/tools/research/stance/resolver.js', () => ({
  inspireLookupByDOI: vi.fn(),
}));

import { getPaperContent } from '../../src/utils/arxivCompat.js';
import { resolveArxivId } from '../../src/utils/resolveArxivId.js';
import { inspireLookupByDOI } from '../../src/tools/research/stance/resolver.js';
import {
  CacheMissError,
  ensureInCache,
} from '../../src/data/papersCacheFetch.js';
import {
  HEP_PAPERS_CACHE_DIR_ENV,
  computeCacheKey,
  readMetaJson,
} from '../../src/data/papersCache.js';

const mockGetPaperContent = vi.mocked(getPaperContent);
const mockResolveArxivId = vi.mocked(resolveArxivId);
const mockInspireLookupByDOI = vi.mocked(inspireLookupByDOI);

function buildArxivStaging(stagingDir: string, arxivId: string): string {
  // Mimic arxiv-mcp: writes to <staging>/arxiv-<id-with-slash-replaced>/
  // and returns the ABSOLUTE path of main.tex (matches arxiv-mcp's contract:
  // packages/arxiv-mcp/src/source/paperContent.ts always returns absolute
  // main_tex via path.join(destDir, mainTex)).
  const subdirName = `arxiv-${arxivId.replace('/', '-')}`;
  const subdir = path.join(stagingDir, subdirName);
  fs.mkdirSync(subdir, { recursive: true });
  const mainTexAbs = path.join(subdir, 'main.tex');
  fs.writeFileSync(mainTexAbs, '\\documentclass{article}\n');
  fs.writeFileSync(path.join(subdir, 'paper.bib'), '@article{x, title="t"}\n');
  return mainTexAbs;
}

describe('ensureInCache scheme dispatch', () => {
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'papers-cache-dispatch-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpRoot;
    mockGetPaperContent.mockReset();
    mockResolveArxivId.mockReset();
    mockInspireLookupByDOI.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalEnv;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('arxiv scheme', () => {
    it('fetches and caches a fresh arxiv paper', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        // params.output_dir is the staging dir we passed
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return {
          success: true,
          source_type: 'latex',
          file_path: path.join(params.output_dir!, 'arxiv-2401.09012'),
          main_tex: mainAbs,
          arxiv_id: '2401.09012',
        };
      });

      const result = await ensureInCache('arxiv:2401.09012v3');
      expect(result.cache_hit).toBe(false);
      expect(result.source_type).toBe('latex');
      expect(result.canonical_id).toBe('arxiv:2401.09012v3');
      expect(fs.existsSync(path.join(result.content_dir, 'latex', 'extracted', 'main.tex'))).toBe(true);
      expect(mockGetPaperContent).toHaveBeenCalledOnce();

      const meta = readMetaJson('arxiv:2401.09012v3');
      expect(meta?.fetched_via).toBe('arxiv');
      expect(meta?.cross_refs?.arxiv).toBe('2401.09012');
    });

    it('returns cache hit on second call (no network)', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });
      const first = await ensureInCache('arxiv:2401.09012v3');
      expect(first.cache_hit).toBe(false);
      const second = await ensureInCache('arxiv:2401.09012v3');
      expect(second.cache_hit).toBe(true);
      expect(second.key).toBe(first.key);
      expect(mockGetPaperContent).toHaveBeenCalledOnce(); // only on first
    });

    it('handles legacy hep-ph/9501234 style id with slash-to-dash staging dir name', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, 'hep-ph/9501234'); // produces arxiv-hep-ph-9501234/
        return {
          success: true,
          source_type: 'latex',
          file_path: '',
          main_tex: mainAbs,
          arxiv_id: 'hep-ph/9501234',
        };
      });
      const result = await ensureInCache('arxiv:hep-ph/9501234v2');
      expect(result.cache_hit).toBe(false);
      // The cache key is over the FULL canonical with version.
      expect(result.key).toBe(computeCacheKey('arxiv:hep-ph/9501234v2'));
      expect(fs.existsSync(path.join(result.content_dir, 'latex', 'extracted', 'main.tex'))).toBe(true);
    });

    it('supports sub-archive cond-mat.stat-mech/9501234 form', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, 'cond-mat.stat-mech/9501234');
        return {
          success: true,
          source_type: 'latex',
          file_path: '',
          main_tex: mainAbs,
          arxiv_id: 'cond-mat.stat-mech/9501234',
        };
      });
      const result = await ensureInCache('arxiv:cond-mat.stat-mech/9501234v1');
      expect(result.cache_hit).toBe(false);
      expect(fs.existsSync(path.join(result.content_dir, 'latex', 'extracted', 'main.tex'))).toBe(true);
    });

    it('throws when arxiv-mcp returns unsuccessful result', async () => {
      mockGetPaperContent.mockResolvedValue({
        success: false,
        source_type: 'latex',
        file_path: '',
        arxiv_id: '',
        error: 'Could not resolve arXiv ID for: foo',
      });
      await expect(ensureInCache('arxiv:9999.99999v1')).rejects.toThrow(/arxiv fetch failed/);
    });
  });

  describe('inspire:recid scheme — eagerly resolves to arxiv', () => {
    it('resolves recid → arxiv id and dedupes to the same cache slot as arxiv:* call', async () => {
      mockResolveArxivId.mockImplementation(async (id) => {
        if (id === 'inspire:1234567') return '2401.09012';
        return null;
      });
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });

      const r1 = await ensureInCache('inspire:recid:1234567');
      expect(r1.canonical_id).toBe('arxiv:2401.09012'); // not "inspire:recid:1234567"
      expect(mockResolveArxivId).toHaveBeenCalledWith('inspire:1234567');

      // Second call with the equivalent arxiv id → cache hit, no resolveArxivId, no getPaperContent
      const r2 = await ensureInCache('arxiv:2401.09012');
      expect(r2.cache_hit).toBe(true);
      expect(r2.key).toBe(r1.key);
      expect(mockGetPaperContent).toHaveBeenCalledOnce();
    });

    it('records inspire_recid in cross_refs', async () => {
      mockResolveArxivId.mockResolvedValue('2401.09012');
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });
      const r = await ensureInCache('inspire:recid:1234567');
      const meta = readMetaJson(r.canonical_id);
      expect(meta?.fetched_via).toBe('inspire-resolved-arxiv');
      expect(meta?.cross_refs?.inspire_recid).toBe('1234567');
    });

    it('throws CacheMissError when INSPIRE record has no arxiv preprint', async () => {
      mockResolveArxivId.mockResolvedValue(null);
      await expect(ensureInCache('inspire:recid:9999999')).rejects.toBeInstanceOf(CacheMissError);
    });
  });

  describe('doi scheme', () => {
    it('resolves via INSPIRE-by-DOI then through inspire→arxiv', async () => {
      mockInspireLookupByDOI.mockResolvedValue('1234567');
      mockResolveArxivId.mockResolvedValue('2401.09012');
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });
      const r = await ensureInCache('doi:10.1103/PhysRevD.108.052006');
      expect(r.canonical_id).toBe('arxiv:2401.09012');
      const meta = readMetaJson(r.canonical_id);
      expect(meta?.cross_refs?.doi).toBe('10.1103/PhysRevD.108.052006');
      expect(meta?.cross_refs?.inspire_recid).toBe('1234567');
    });

    it('throws CacheMissError with manual-import suggestion when DOI not in INSPIRE', async () => {
      mockInspireLookupByDOI.mockResolvedValue(null);
      await expect(ensureInCache('doi:10.1234/not-in-inspire'))
        .rejects.toThrow(/cache miss for doi:10\.1234\/not-in-inspire.*hep_admin_import_paper/);
      // Sci-hub red line: error message must not mention any specific external skill.
      try {
        await ensureInCache('doi:10.1234/not-in-inspire');
      } catch (e) {
        const msg = (e as Error).message.toLowerCase();
        expect(msg).not.toContain('sci-hub');
        expect(msg).not.toContain('scihub');
        expect(msg).not.toContain('crossref');
      }
    });

    it('throws CacheMissError when INSPIRE has the DOI but no arxiv preprint', async () => {
      mockInspireLookupByDOI.mockResolvedValue('1234567');
      mockResolveArxivId.mockResolvedValue(null);
      await expect(ensureInCache('doi:10.1103/journal-only-paper'))
        .rejects.toBeInstanceOf(CacheMissError);
    });
  });

  describe('zotero scheme — Step 2 stub', () => {
    it('throws CacheMissError pointing at hep_admin_import_paper', async () => {
      await expect(ensureInCache('zotero:9999/ABCDEFGH'))
        .rejects.toThrow(/cache miss for zotero:.*hep_admin_import_paper/);
    });
  });
});
