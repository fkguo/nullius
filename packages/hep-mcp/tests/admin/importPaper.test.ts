import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaper, formatImportReport } from '../../src/admin/importPaper.js';
import {
  HEP_PAPERS_CACHE_DIR_ENV,
  cacheEntryPaths,
  computeCacheKey,
  existsInCache,
  readMetaJson,
} from '../../src/data/papersCache.js';

function writeFakePdf(filePath: string, body = 'fake-pdf'): string {
  fs.writeFileSync(filePath, body);
  return crypto.createHash('sha256').update(body).digest('hex');
}

describe('importPaper', () => {
  let tmpCacheDir: string;
  let tmpStaging: string;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-cache-'));
    tmpStaging = fs.mkdtempSync(path.join(os.tmpdir(), 'import-staging-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
    fs.rmSync(tmpStaging, { recursive: true, force: true });
  });

  describe('canonicalization', () => {
    it('passes through URI-prefixed canonical ids for supported schemes', async () => {
      const pdf = path.join(tmpStaging, 'a.pdf');
      writeFakePdf(pdf);
      for (const id of [
        'arxiv:2401.09012v3',
        'doi:10.1103/PhysRevD.110.012345',
        'inspire:recid:1234567',
        'zotero:groups/123/items/ABCD1234',
      ]) {
        // fresh cache for each iteration
        fs.rmSync(tmpCacheDir, { recursive: true, force: true });
        fs.mkdirSync(tmpCacheDir, { recursive: true });
        const r = await importPaper({ identifier: id, pdf_path: pdf });
        expect(r.canonical_id).toBe(id);
        expect(r.status).toBe('imported');
      }
    });

    it('auto-prefixes bare arxiv ids, bare DOIs, and bare INSPIRE recids', async () => {
      const pdf = path.join(tmpStaging, 'a.pdf');
      writeFakePdf(pdf);

      const cases: Array<[string, string]> = [
        ['2401.09012', 'arxiv:2401.09012'],
        ['hep-ph/9501234', 'arxiv:hep-ph/9501234'],
        ['10.1103/PhysRevD.110.012345', 'doi:10.1103/PhysRevD.110.012345'],
        ['1234567', 'inspire:recid:1234567'],
      ];
      for (const [bare, expected] of cases) {
        fs.rmSync(tmpCacheDir, { recursive: true, force: true });
        fs.mkdirSync(tmpCacheDir, { recursive: true });
        const r = await importPaper({ identifier: bare, pdf_path: pdf });
        expect(r.canonical_id).toBe(expected);
      }
    });

    it('rejects unparseable identifiers (no scheme, no bare-form match)', async () => {
      const pdf = path.join(tmpStaging, 'a.pdf');
      writeFakePdf(pdf);
      await expect(importPaper({ identifier: 'just-some-string', pdf_path: pdf })).rejects.toThrow(
        /cannot canonicalize identifier/,
      );
    });

    it('rejects unsupported URI schemes (e.g. manual:)', async () => {
      const pdf = path.join(tmpStaging, 'a.pdf');
      writeFakePdf(pdf);
      await expect(importPaper({ identifier: 'manual:my-paper-2024', pdf_path: pdf })).rejects.toThrow(
        /cannot canonicalize identifier/,
      );
    });

    it('rejects empty / whitespace-only identifiers', async () => {
      const pdf = path.join(tmpStaging, 'a.pdf');
      writeFakePdf(pdf);
      await expect(importPaper({ identifier: '', pdf_path: pdf })).rejects.toThrow();
      await expect(importPaper({ identifier: '   ', pdf_path: pdf })).rejects.toThrow();
    });
  });

  describe('pdf_path validation', () => {
    it('rejects relative paths', async () => {
      await expect(importPaper({ identifier: 'arxiv:2401.09012', pdf_path: 'relative/file.pdf' })).rejects.toThrow(
        /absolute path/,
      );
    });

    it('rejects nonexistent files', async () => {
      const missing = path.join(tmpStaging, 'does-not-exist.pdf');
      await expect(importPaper({ identifier: 'arxiv:2401.09012', pdf_path: missing })).rejects.toThrow(
        /not accessible/,
      );
    });

    it('rejects directories', async () => {
      const dir = path.join(tmpStaging, 'dir');
      fs.mkdirSync(dir);
      await expect(importPaper({ identifier: 'arxiv:2401.09012', pdf_path: dir })).rejects.toThrow(
        /not a regular file/,
      );
    });

    it('absolute pdf_path with `..` segments resolves through fs.statSync as written (no special handling)', async () => {
      // The cache is user-owned and `imported_from` is informational, so we do
      // not refuse paths containing `..` — we just let the OS resolve them. As
      // long as the resolved target exists and is a regular file, the import
      // proceeds. This test pins the documented behavior; if a future change
      // adds path normalization, it should be a deliberate breaking change.
      const realPdf = path.join(tmpStaging, 'real.pdf');
      writeFakePdf(realPdf, 'real-content');
      // /<tmpStaging>/sub/../real.pdf — absolute and well-formed; the .. cancels
      // the sub/ segment, yielding the actual file. statSync follows the path
      // and succeeds.
      const sub = path.join(tmpStaging, 'sub');
      fs.mkdirSync(sub);
      const indirectPath = path.join(sub, '..', 'real.pdf');
      const r = await importPaper({ identifier: 'arxiv:TRAVERSE.v1', pdf_path: indirectPath });
      expect(r.status).toBe('imported');
      // imported_from records exactly what the caller passed (NOT realpath).
      const meta = readMetaJson('arxiv:TRAVERSE.v1');
      expect(meta?.cross_refs?.imported_from).toBe(indirectPath);
    });
  });

  describe('fresh import', () => {
    it('copies the PDF into Tier 3 cache and records source_type=pdf in meta', async () => {
      const pdf = path.join(tmpStaging, 'paper.pdf');
      const sha = writeFakePdf(pdf, 'real-pdf-bytes');

      const r = await importPaper({ identifier: 'doi:10.1103/X', pdf_path: pdf });

      expect(r.status).toBe('imported');
      expect(r.canonical_id).toBe('doi:10.1103/X');
      expect(r.cache_key).toBe(computeCacheKey('doi:10.1103/X'));
      expect(r.pdf_sha256).toBe(sha);
      expect(r.size_bytes).toBe(fs.statSync(pdf).size);
      expect(r.schema_version).toBe(1);

      // Cache entry materialized with content/pdf/paper.pdf.
      const paths = cacheEntryPaths(r.cache_key);
      expect(fs.existsSync(path.join(paths.contentDir, 'pdf', 'paper.pdf'))).toBe(true);
      expect(existsInCache('doi:10.1103/X')).toBe(true);

      const meta = readMetaJson('doi:10.1103/X');
      expect(meta?.source_type).toBe('pdf');
      expect(meta?.fetched_via).toBe('manual_import');
      expect(meta?.main_path).toBe('pdf/paper.pdf');
      expect(meta?.canonical_id).toBe('doi:10.1103/X');
      expect(meta?.cross_refs?.imported_from).toBe(pdf);
      expect(meta?.cross_refs?.content_sha256).toBe(sha);
    });

    it('imported PDF bytes match the source exactly', async () => {
      const pdf = path.join(tmpStaging, 'paper.pdf');
      const body = 'pdf-bytes-with-binary\x00\x01\x02 weirdness';
      writeFakePdf(pdf, body);

      const r = await importPaper({ identifier: 'arxiv:2401.09012', pdf_path: pdf });

      const cachedPdf = path.join(r.cache_entry_dir, 'content', 'pdf', 'paper.pdf');
      expect(fs.readFileSync(cachedPdf, 'utf-8')).toBe(body);
    });
  });

  describe('conflict policy', () => {
    it('returns status=already_cached when entry exists and overwrite is omitted', async () => {
      const pdf = path.join(tmpStaging, 'paper.pdf');
      writeFakePdf(pdf, 'v1');
      const first = await importPaper({ identifier: 'arxiv:2401.09012', pdf_path: pdf });
      expect(first.status).toBe('imported');

      // Second import attempt for same id, different content.
      const pdf2 = path.join(tmpStaging, 'paper-v2.pdf');
      writeFakePdf(pdf2, 'v2');
      const second = await importPaper({ identifier: 'arxiv:2401.09012', pdf_path: pdf2 });

      expect(second.status).toBe('already_cached');
      expect(second.reason).toMatch(/already has an entry/);
      expect(second.reason).toMatch(/overwrite=true/);

      // The original cached PDF must be untouched.
      const cachedPdf = path.join(second.cache_entry_dir, 'content', 'pdf', 'paper.pdf');
      expect(fs.readFileSync(cachedPdf, 'utf-8')).toBe('v1');
    });

    it('overwrite=true replaces the existing entry with the new PDF', async () => {
      const pdf1 = path.join(tmpStaging, 'paper.pdf');
      writeFakePdf(pdf1, 'old-content');
      await importPaper({ identifier: 'arxiv:2401.09012', pdf_path: pdf1 });

      const pdf2 = path.join(tmpStaging, 'paper-new.pdf');
      const newSha = writeFakePdf(pdf2, 'new-content');
      const r = await importPaper({ identifier: 'arxiv:2401.09012', pdf_path: pdf2, overwrite: true });

      expect(r.status).toBe('overwritten');
      expect(r.pdf_sha256).toBe(newSha);

      const cachedPdf = path.join(r.cache_entry_dir, 'content', 'pdf', 'paper.pdf');
      expect(fs.readFileSync(cachedPdf, 'utf-8')).toBe('new-content');

      // meta.json content_sha256 must reflect the replacement.
      const meta = readMetaJson('arxiv:2401.09012');
      expect(meta?.cross_refs?.content_sha256).toBe(newSha);
    });

    it('overwrite=true on a fresh (no existing entry) call still produces overwritten status', async () => {
      // The pure function does not distinguish "overwrite of nothing" from
      // "overwrite of something" at the report-status level — overwrite=true
      // always yields status='overwritten'. This is documented contract; if
      // callers want first-vs-replacement disambiguation they should query
      // existsInCache() before calling.
      const pdf = path.join(tmpStaging, 'paper.pdf');
      writeFakePdf(pdf, 'content');
      const r = await importPaper({ identifier: 'arxiv:NEW.v1', pdf_path: pdf, overwrite: true });
      expect(r.status).toBe('overwritten');
      expect(existsInCache('arxiv:NEW.v1')).toBe(true);
    });
  });

  describe('formatImportReport', () => {
    it('renders all key fields on separate lines', async () => {
      const pdf = path.join(tmpStaging, 'paper.pdf');
      writeFakePdf(pdf);
      const r = await importPaper({ identifier: 'doi:10.1103/X', pdf_path: pdf });
      const out = formatImportReport(r);
      expect(out).toContain('schema_version=1');
      expect(out).toContain('identifier   : doi:10.1103/X');
      expect(out).toContain('canonical_id : doi:10.1103/X');
      expect(out).toContain('status       : imported');
      expect(out).toContain('pdf_sha256   :');
      expect(out).toContain('reason       :');
    });
  });
});
