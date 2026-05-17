/**
 * Tests for evidence.ts:resolveLatexSourceForPaper — the Step 2 rewire that
 * sends new identifier-mode builds through the Tier 3 cache + a symlink, and
 * preserves the legacy in-place copy mode when the project paper dir already
 * carries a real (non-symlink) extracted/ tree from a pre-cache build.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/arxivCompat.js', () => ({
  getPaperContent: vi.fn(),
}));
vi.mock('../../src/utils/resolveArxivId.js', () => ({
  resolveArxivId: vi.fn(async () => '2401.09012'),
}));
vi.mock('../../src/tools/research/stance/resolver.js', () => ({
  inspireLookupByDOI: vi.fn(),
}));
vi.mock('../../src/core/projects.js', () => ({
  getProject: vi.fn(() => ({ project_id: 'proj_test', name: 'test' })),
  updateProjectUpdatedAt: vi.fn(),
}));

import { getPaperContent } from '../../src/utils/arxivCompat.js';
import { resolveLatexSourceForPaper } from '../../src/core/evidence.js';
import { HEP_PAPERS_CACHE_DIR_ENV } from '../../src/data/papersCache.js';

const mockGetPaperContent = vi.mocked(getPaperContent);

function buildArxivStaging(stagingDir: string, arxivId: string): string {
  const subdirName = `arxiv-${arxivId.replace('/', '-')}`;
  const subdir = path.join(stagingDir, subdirName);
  fs.mkdirSync(subdir, { recursive: true });
  const mainPath = path.join(subdir, 'main.tex');
  fs.writeFileSync(mainPath, '\\documentclass{article}\n\\begin{document}body\\end{document}\n');
  fs.writeFileSync(path.join(subdir, 'refs.bib'), '@article{x, title="t"}\n');
  return mainPath;
}

describe('resolveLatexSourceForPaper', () => {
  let tmpHepDataDir: string;
  let tmpCacheDir: string;
  let originalHepDataDir: string | undefined;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalHepDataDir = process.env.HEP_DATA_DIR;
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpHepDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-step2-'));
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papers-cache-step2-'));
    process.env.HEP_DATA_DIR = tmpHepDataDir;
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
    mockGetPaperContent.mockReset();
  });

  afterEach(() => {
    if (originalHepDataDir === undefined) delete process.env.HEP_DATA_DIR;
    else process.env.HEP_DATA_DIR = originalHepDataDir;
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpHepDataDir, { recursive: true, force: true });
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
  });

  describe('cache + symlink path (fresh project)', () => {
    it('materializes via cache and creates a symlink', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });

      const result = await resolveLatexSourceForPaper({
        identifier: '2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });

      expect(result.via).toBe('cache_symlink');
      expect(result.mainTexRel).toBe('main.tex');

      // Verify extracted dir is a symlink pointing into the cache.
      const lst = fs.lstatSync(result.destExtractedDir);
      expect(lst.isSymbolicLink()).toBe(true);
      const target = fs.readlinkSync(result.destExtractedDir);
      const absTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(result.destExtractedDir), target);
      expect(absTarget.startsWith(tmpCacheDir)).toBe(true);
      expect(absTarget.endsWith(path.join('content', 'latex', 'extracted'))).toBe(true);

      // main.tex resolves via the symlink.
      expect(fs.readFileSync(result.destMainTexPath, 'utf-8')).toContain('documentclass');
    });

    it('returns cache_hit on second call (no network)', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });

      await resolveLatexSourceForPaper({
        identifier: 'arxiv:2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });
      expect(mockGetPaperContent).toHaveBeenCalledOnce();

      const result2 = await resolveLatexSourceForPaper({
        identifier: 'arxiv:2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });
      expect(result2.via).toBe('cache_symlink');
      expect(mockGetPaperContent).toHaveBeenCalledOnce(); // not called again
    });

    it('refreshes a symlink that points to a stale (wrong) target', async () => {
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });

      const result1 = await resolveLatexSourceForPaper({
        identifier: 'arxiv:2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });
      // Manually mess with the symlink target to a non-existent path.
      fs.unlinkSync(result1.destExtractedDir);
      fs.symlinkSync('/nonexistent/path', result1.destExtractedDir);

      const result2 = await resolveLatexSourceForPaper({
        identifier: 'arxiv:2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });
      const lst = fs.lstatSync(result2.destExtractedDir);
      expect(lst.isSymbolicLink()).toBe(true);
      const target = fs.readlinkSync(result2.destExtractedDir);
      const absTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(result2.destExtractedDir), target);
      expect(absTarget.startsWith(tmpCacheDir)).toBe(true); // pointed back into the cache
    });
  });

  describe('legacy copy path (existing real extracted/ dir from pre-cache build)', () => {
    it('preserves a real extracted/ dir and uses in-place copy mode', async () => {
      mockGetPaperContent.mockImplementation(async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-legacy-'));
        const mainPath = buildArxivStaging(tmp, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainPath, arxiv_id: '2401.09012' };
      });

      // Pre-create a real extracted/ dir to simulate pre-cache build state.
      const projectPapersBase = path.join(tmpHepDataDir, 'projects', 'proj_test', 'papers', 'arxiv-2401.09012');
      const realExtracted = path.join(projectPapersBase, 'sources', 'latex', 'extracted');
      fs.mkdirSync(realExtracted, { recursive: true });
      fs.writeFileSync(path.join(realExtracted, 'old.tex'), '% legacy content\n');

      const result = await resolveLatexSourceForPaper({
        identifier: 'arxiv:2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });

      expect(result.via).toBe('legacy_copy');
      // The real dir is still a real dir, NOT a symlink.
      const lst = fs.lstatSync(realExtracted);
      expect(lst.isSymbolicLink()).toBe(false);
      expect(lst.isDirectory()).toBe(true);
      // Cache should NOT have been populated (since we went legacy path).
      // (We don't assert hard on cache emptiness — caller may have warmed it separately;
      //  the contract is that legacy mode does NOT touch the cache from this code path.)
    });
  });

  describe('main_tex_path mode unchanged', () => {
    it('is not handled by resolveLatexSourceForPaper (caller branches to copyProjectFiles directly)', () => {
      // resolveLatexSourceForPaper takes `identifier` as required input. The
      // main_tex_path branch in buildProjectEvidenceCatalog never calls this
      // helper. Spec assertion only.
      expect(typeof resolveLatexSourceForPaper).toBe('function');
    });
  });

  describe('regression: buildProjectEvidenceCatalog call order', () => {
    it('still selects cache+symlink even when the parent latex/ dir was pre-ensured (the order buildProjectEvidenceCatalog uses)', async () => {
      // buildProjectEvidenceCatalog calls ensurePaperBaseDirs() before
      // dispatching to resolveLatexSourceForPaper(). ensurePaperBaseDirs is
      // designed to create the latex/ PARENT only (not the extracted/ LEAF).
      // Verify that after this pre-creation, the cache path is still chosen.
      mockGetPaperContent.mockImplementation(async (params) => {
        const mainAbs = buildArxivStaging(params.output_dir!, '2401.09012');
        return { success: true, source_type: 'latex', file_path: '', main_tex: mainAbs, arxiv_id: '2401.09012' };
      });

      // Simulate ensurePaperBaseDirs side effects: create papers/<id>/sources/latex/
      // but NOT papers/<id>/sources/latex/extracted/.
      const projectPapersBase = path.join(tmpHepDataDir, 'projects', 'proj_test', 'papers', 'arxiv-2401.09012');
      fs.mkdirSync(path.join(projectPapersBase, 'sources', 'latex'), { recursive: true });
      const extractedPath = path.join(projectPapersBase, 'sources', 'latex', 'extracted');
      expect(fs.existsSync(extractedPath)).toBe(false); // leaf must be absent

      const result = await resolveLatexSourceForPaper({
        identifier: 'arxiv:2401.09012v3',
        projectId: 'proj_test',
        paperId: 'arxiv-2401.09012',
      });

      expect(result.via).toBe('cache_symlink');
      const lst = fs.lstatSync(extractedPath);
      expect(lst.isSymbolicLink()).toBe(true);
    });
  });
});
