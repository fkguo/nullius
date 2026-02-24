import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertEvalSnapshot, readEvalFixture } from './evalSnapshots.js';

vi.mock('../../src/api/rateLimiter.js', () => ({
  inspireFetch: vi.fn(),
}));

const rateLimiter = await import('../../src/api/rateLimiter.js');
const { clearAllCaches } = await import('../../src/cache/memoryCache.js');
const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/vnext/resources.js');

function makeHit(controlNumber: number) {
  return {
    metadata: {
      control_number: controlNumber,
      titles: [{ title: `T${controlNumber}` }],
      authors: [{ full_name: 'A' }],
      author_count: 1,
      collaborations: [],
      earliest_date: '2024-01-01',
      citation_count: 0,
      citation_count_without_self_citations: 0,
      publication_info: [],
      arxiv_eprints: [],
      dois: [],
      publication_type: [],
      document_type: [],
      texkeys: [],
    },
  };
}

describe('eval: dataset export stability (mocked INSPIRE)', () => {
  const inspireFetch = vi.mocked(rateLimiter.inspireFetch);
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    clearAllCaches();
    inspireFetch.mockReset();
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes deterministic meta + export artifacts', async () => {
    const fixture = readEvalFixture<{ query: string; sort: string; size: number; max_results: number }>('query_exotic_hadrons.json');

    inspireFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const page = Number(u.searchParams.get('page') ?? '1');
      const size = Number(u.searchParams.get('size') ?? '2');

      const total = 3;
      const startIdx = (page - 1) * size;
      const remaining = total - startIdx;
      const count = Math.max(0, Math.min(size, remaining));

      const hits = Array.from({ length: count }, (_, i) => makeHit(100 + startIdx + i + 1));
      const hasMore = startIdx + count < total;
      const next = hasMore ? `https://inspirehep.net/api/literature?q=${encodeURIComponent(fixture.query)}&page=${page + 1}&size=${size}` : undefined;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          hits: { total, hits },
          links: next ? { next } : {},
        }),
      } as any;
    });

    const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-dataset' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const exportRes = await handleToolCall('hep_inspire_search_export', {
      run_id: run.run_id,
      query: fixture.query,
      sort: fixture.sort,
      size: fixture.size,
      max_results: fixture.max_results,
      output_format: 'jsonl',
    });
    const payload = JSON.parse(exportRes.content[0].text) as {
      export_uri: string;
      meta_uri: string;
      summary: { total: number; exported: number; pages_fetched: number; has_more: boolean };
    };

    expect(payload.summary.total).toBe(3);
    expect(payload.summary.exported).toBe(3);
    expect(payload.summary.pages_fetched).toBe(2);
    expect(payload.summary.has_more).toBe(false);

    const metaText = (readHepResource(payload.meta_uri) as any).text as string;
    const meta = JSON.parse(metaText) as any;

    const exportText = (readHepResource(payload.export_uri) as any).text as string;
    const controlNumbers = exportText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => JSON.parse(l) as any)
      .map(p => Number(p?.recid ?? p?.control_number ?? p?.metadata?.control_number))
      .filter(n => Number.isFinite(n));

    assertEvalSnapshot('dataset_export_exotic_hadrons', {
      query: meta.query,
      sort: meta.sort ?? null,
      page_size: meta.page_size,
      max_results: meta.max_results,
      total: meta.total,
      exported: meta.exported,
      pages_fetched: meta.pages_fetched,
      has_more: meta.has_more,
      warnings: meta.warnings,
      control_numbers: controlNumbers,
      export_artifact_name: String(meta.artifacts?.export_uri ?? '').split('/artifact/')[1] ?? null,
      meta_artifact_name: String(meta.artifacts?.meta_uri ?? '').split('/artifact/')[1] ?? null,
    });
  });
});
