import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runEvalSet } from '../../src/eval/index.js';
import { assertEvalSnapshot } from './evalSnapshots.js';
import { readEvalSetFixture } from './evalSnapshots.js';

vi.mock('../../src/api/rateLimiter.js', () => ({
  inspireFetch: vi.fn(),
}));

const rateLimiter = await import('../../src/api/rateLimiter.js');
const { clearAllCaches } = await import('../../src/cache/memoryCache.js');
const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

type DatasetInput = { query: string; sort: string; size: number; max_results: number };
type DatasetExpected = { total: number; exported: number; pages_fetched: number; has_more: boolean };

type DatasetExportPayload = {
  export_uri: string;
  meta_uri: string;
  summary: { total: number; exported: number; pages_fetched: number; has_more: boolean };
};

type DatasetMeta = {
  query: string;
  sort?: string;
  page_size: number;
  max_results: number;
  total: number;
  exported: number;
  pages_fetched: number;
  has_more: boolean;
  warnings: unknown[];
  artifacts?: {
    export_uri?: string;
    meta_uri?: string;
  };
};

type DatasetActual = {
  payload: DatasetExportPayload;
  meta: DatasetMeta;
  controlNumbers: number[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readResourceText(uri: string): string {
  const resource = readHepResource(uri);
  if (!('text' in resource)) {
    throw new Error(`Expected text resource: ${uri}`);
  }
  return resource.text;
}

function readControlNumber(record: unknown): number | null {
  if (!isRecord(record)) return null;
  const recid = record.recid;
  if (typeof recid === 'number' && Number.isFinite(recid)) return recid;
  const controlNumber = record.control_number;
  if (typeof controlNumber === 'number' && Number.isFinite(controlNumber)) return controlNumber;
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  const nested = metadata?.control_number;
  if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  return null;
}

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
    const evalSet = readEvalSetFixture('query_exotic_hadrons.json');
    const fixtureInput = evalSet.cases[0]?.input as DatasetInput;

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
      const next = hasMore
        ? `https://inspirehep.net/api/literature?q=${encodeURIComponent(fixtureInput.query)}&page=${page + 1}&size=${size}`
        : undefined;

      return new Response(
        JSON.stringify({
          hits: { total, hits },
          links: next ? { next } : {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-dataset' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const report = await runEvalSet<DatasetInput, DatasetActual>(evalSet, {
      run: async (input: DatasetInput) => {
        const exportRes = await handleToolCall('hep_inspire_search_export', {
          run_id: run.run_id,
          query: input.query,
          sort: input.sort,
          size: input.size,
          max_results: input.max_results,
          output_format: 'jsonl',
        });
        const payload = JSON.parse(exportRes.content[0].text) as DatasetExportPayload;
        const metaText = readResourceText(payload.meta_uri);
        const meta = JSON.parse(metaText) as DatasetMeta;
        const exportText = readResourceText(payload.export_uri);
        const controlNumbers = exportText
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => readControlNumber(JSON.parse(line) as unknown))
          .filter((value): value is number => value !== null);
        return { payload, meta, controlNumbers };
      },
      judge: (expected, actual) => {
        const exp = expected as DatasetExpected;
        expect(actual.payload.summary.total).toBe(exp.total);
        expect(actual.payload.summary.exported).toBe(exp.exported);
        expect(actual.payload.summary.pages_fetched).toBe(exp.pages_fetched);
        expect(actual.payload.summary.has_more).toBe(exp.has_more);

        assertEvalSnapshot('dataset_export_exotic_hadrons', {
          query: actual.meta.query,
          sort: actual.meta.sort ?? null,
          page_size: actual.meta.page_size,
          max_results: actual.meta.max_results,
          total: actual.meta.total,
          exported: actual.meta.exported,
          pages_fetched: actual.meta.pages_fetched,
          has_more: actual.meta.has_more,
          warnings: actual.meta.warnings,
          control_numbers: actual.controlNumbers,
          export_artifact_name: String(actual.meta.artifacts?.export_uri ?? '').split('/artifact/')[1] ?? null,
          meta_artifact_name: String(actual.meta.artifacts?.meta_uri ?? '').split('/artifact/')[1] ?? null,
        });
        return {
          passed: true,
          metrics: {
            total: actual.payload.summary.total,
            exported: actual.payload.summary.exported,
          },
        };
      },
    });

    expect(report.summary.total).toBe(1);
    if (report.summary.failed > 0) {
      const failedCase = report.caseResults.find(result => result.passed === false);
      throw new Error(`Dataset eval failed: ${failedCase?.error ?? 'unknown runtime error'}`);
    }
  });
});
