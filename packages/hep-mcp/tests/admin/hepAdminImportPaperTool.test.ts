/**
 * MCP-tool-level tests for hep_admin_import_paper. Exercises the dispatched
 * path that goes through withProjectRootContract + the handler's overwrite-only
 * dual-key gate, NOT just the pure importPaper() function.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getToolSpec } from '../../src/tools/registry/shared.js';
import { HEP_ADMIN_IMPORT_PAPER } from '../../src/tool-names.js';
import { HEP_PAPERS_CACHE_DIR_ENV, existsInCache, readMetaJson } from '../../src/data/papersCache.js';

describe('hep_admin_import_paper MCP tool', () => {
  let tmpCacheDir: string;
  let tmpStaging: string;
  let originalCacheDir: string | undefined;

  beforeEach(() => {
    originalCacheDir = process.env[HEP_PAPERS_CACHE_DIR_ENV];
    tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-tool-cache-'));
    tmpStaging = fs.mkdtempSync(path.join(os.tmpdir(), 'import-tool-staging-'));
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = tmpCacheDir;
  });

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env[HEP_PAPERS_CACHE_DIR_ENV];
    else process.env[HEP_PAPERS_CACHE_DIR_ENV] = originalCacheDir;
    fs.rmSync(tmpCacheDir, { recursive: true, force: true });
    fs.rmSync(tmpStaging, { recursive: true, force: true });
  });

  function getHandler() {
    const spec = getToolSpec(HEP_ADMIN_IMPORT_PAPER);
    if (!spec) throw new Error('tool not registered');
    return spec.handler;
  }

  function makePdf(name = 'paper.pdf', body = 'fake-pdf-bytes'): string {
    const p = path.join(tmpStaging, name);
    fs.writeFileSync(p, body);
    return p;
  }

  it('is registered with riskLevel=write', () => {
    const spec = getToolSpec(HEP_ADMIN_IMPORT_PAPER);
    expect(spec).toBeDefined();
    expect(spec!.riskLevel).toBe('write');
  });

  it('rejects calls with no identifier', async () => {
    const handler = getHandler();
    await expect(handler({ pdf_path: makePdf() }, {})).rejects.toThrow();
  });

  it('rejects calls with whitespace-only identifier', async () => {
    const handler = getHandler();
    await expect(handler({ identifier: '   ', pdf_path: makePdf() }, {})).rejects.toThrow(/identifier/);
  });

  it('rejects calls with no pdf_path', async () => {
    const handler = getHandler();
    await expect(handler({ identifier: 'arxiv:2401.09012' }, {})).rejects.toThrow();
  });

  it('rejects calls with a non-absolute pdf_path at the handler layer', async () => {
    const handler = getHandler();
    await expect(
      handler({ identifier: 'arxiv:2401.09012', pdf_path: 'relative/path.pdf' }, {}),
    ).rejects.toThrow(/absolute path/);
  });

  it('fresh import does not need _confirm and writes the cache entry', async () => {
    const handler = getHandler();
    const pdf = makePdf();
    const result = (await handler({ identifier: 'doi:10.1103/X', pdf_path: pdf }, {})) as {
      status: string;
      canonical_id: string;
      schema_version: number;
      warning?: string;
    };
    expect(result.status).toBe('imported');
    expect(result.canonical_id).toBe('doi:10.1103/X');
    expect(result.schema_version).toBe(1);
    expect(result.warning).toBeUndefined();
    expect(existsInCache('doi:10.1103/X')).toBe(true);
    expect(readMetaJson('doi:10.1103/X')?.source_type).toBe('pdf');
  });

  it('second import of same identifier without overwrite returns already_cached and does not mutate', async () => {
    const handler = getHandler();
    const pdf1 = makePdf('v1.pdf', 'v1');
    await handler({ identifier: 'arxiv:2401.09012', pdf_path: pdf1 }, {});
    const pdf2 = makePdf('v2.pdf', 'v2');
    const result = (await handler({ identifier: 'arxiv:2401.09012', pdf_path: pdf2 }, {})) as {
      status: string;
      cache_entry_dir: string;
    };
    expect(result.status).toBe('already_cached');
    const cachedPdf = path.join(result.cache_entry_dir, 'content', 'pdf', 'paper.pdf');
    expect(fs.readFileSync(cachedPdf, 'utf-8')).toBe('v1');
  });

  it('overwrite=true without _confirm is downgraded to a non-overwrite import with warning', async () => {
    const handler = getHandler();
    const pdf1 = makePdf('v1.pdf', 'original');
    await handler({ identifier: 'arxiv:2401.09012', pdf_path: pdf1 }, {});

    const pdf2 = makePdf('v2.pdf', 'replacement');
    const result = (await handler(
      { identifier: 'arxiv:2401.09012', pdf_path: pdf2, overwrite: true },
      {},
    )) as { status: string; warning?: string; cache_entry_dir: string };

    expect(result.status).toBe('already_cached');
    expect(result.warning).toMatch(/overwrite=true was requested but _confirm=true was not provided/);
    // Cache must NOT be mutated.
    const cachedPdf = path.join(result.cache_entry_dir, 'content', 'pdf', 'paper.pdf');
    expect(fs.readFileSync(cachedPdf, 'utf-8')).toBe('original');
  });

  it('overwrite=true with _confirm=true replaces the cache entry (no warning)', async () => {
    const handler = getHandler();
    const pdf1 = makePdf('v1.pdf', 'original');
    await handler({ identifier: 'arxiv:2401.09012', pdf_path: pdf1 }, {});

    const pdf2 = makePdf('v2.pdf', 'replacement');
    const result = (await handler(
      { identifier: 'arxiv:2401.09012', pdf_path: pdf2, overwrite: true, _confirm: true },
      {},
    )) as { status: string; warning?: string; cache_entry_dir: string };

    expect(result.status).toBe('overwritten');
    expect(result.warning).toBeUndefined();
    const cachedPdf = path.join(result.cache_entry_dir, 'content', 'pdf', 'paper.pdf');
    expect(fs.readFileSync(cachedPdf, 'utf-8')).toBe('replacement');
  });

  it('first-time import with overwrite=true and _confirm=true succeeds (no-op replacement is fine)', async () => {
    const handler = getHandler();
    const pdf = makePdf('v.pdf', 'content');
    const result = (await handler(
      { identifier: 'arxiv:NEW.v1', pdf_path: pdf, overwrite: true, _confirm: true },
      {},
    )) as { status: string };
    // The pure function returns 'overwritten' whenever overwrite=true was the
    // effective mode, even for fresh imports. The handler does not rewrite the
    // status — callers wanting "true overwrite" disambiguation must query
    // existsInCache() first.
    expect(result.status).toBe('overwritten');
    expect(existsInCache('arxiv:NEW.v1')).toBe(true);
  });
});
