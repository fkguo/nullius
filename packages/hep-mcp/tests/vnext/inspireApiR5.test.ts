import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/api/client.js', () => ({
  search: vi.fn(),
  searchByUrl: vi.fn(),
  getPaper: vi.fn(),
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/vnext/resources.js');

function artifactNameFromUri(uri: string): string {
  const m = uri.match(/\/artifact\/([^/]+)$/);
  if (!m?.[1]) throw new Error(`Not an artifact uri: ${uri}`);
  return decodeURIComponent(m[1]);
}

describe('Open Roadmap R5: INSPIRE API export + mapping (Evidence-first)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('hep_inspire_search_export writes artifacts and returns URIs + summary', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R5 export project' });
    const projectPayload = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: projectPayload.project_id });
    const runPayload = JSON.parse(runRes.content[0].text) as { run_id: string };

    const papers = [
      { recid: '1', title: 'T1', authors: [] },
      { recid: '2', title: 'T2', authors: [] },
      { recid: '3', title: 'T3', authors: [] },
    ];

    vi.mocked(api.search).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(0, 2),
      has_more: true,
      next_url: 'https://inspirehep.net/api/literature?q=x&size=2&page=2',
    } as any);

    vi.mocked(api.searchByUrl).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(2),
      has_more: false,
    } as any);

    const exportRes = await handleToolCall('hep_inspire_search_export', {
      run_id: runPayload.run_id,
      query: 't:qcd',
      size: 2,
      max_results: 10,
      output_format: 'jsonl',
    });

    const payload = JSON.parse(exportRes.content[0].text) as {
      export_uri: string;
      meta_uri: string;
      summary: { total: number; exported: number; pages_fetched: number };
    };

    expect(payload.export_uri).toMatch(/^hep:\/\/runs\//);
    expect(payload.meta_uri).toMatch(/^hep:\/\/runs\//);
    expect(payload.summary.total).toBe(3);
    expect(payload.summary.exported).toBe(3);
    expect(payload.summary.pages_fetched).toBe(2);

    const exportContent = readHepResource(payload.export_uri) as any;
    const lines = (exportContent.text as string).trim().split('\n').map((l: string) => JSON.parse(l));
    expect(lines).toEqual(papers);

    const metaContent = readHepResource(payload.meta_uri) as any;
    const meta = JSON.parse(metaContent.text) as { exported: number; total: number; artifacts: { export_uri: string } };
    expect(meta.exported).toBe(3);
    expect(meta.total).toBe(3);
    expect(meta.artifacts.export_uri).toBe(payload.export_uri);

    const manifestUri = `hep://runs/${encodeURIComponent(runPayload.run_id)}/manifest`;
    const manifest = JSON.parse((readHepResource(manifestUri) as any).text) as {
      steps: Array<{ step: string; artifacts?: Array<{ name: string }> }>;
    };

    const step = manifest.steps.find(s => s.step === 'inspire_search_export');
    expect(step).toBeTruthy();
    const artifactNames = (step?.artifacts ?? []).map(a => a.name);
    expect(artifactNames).toContain(artifactNameFromUri(payload.export_uri));
    expect(artifactNames).toContain(artifactNameFromUri(payload.meta_uri));
  });

  it('hep_inspire_resolve_identifiers writes mapping jsonl and summary', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'R5 mapping project' });
    const projectPayload = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: projectPayload.project_id });
    const runPayload = JSON.parse(runRes.content[0].text) as { run_id: string };

    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '123' } as any);
    vi.mocked(api.getByDoi).mockResolvedValueOnce({ recid: '456' } as any);
    vi.mocked(api.getByArxiv).mockResolvedValueOnce({ recid: '789' } as any);

    const res = await handleToolCall('hep_inspire_resolve_identifiers', {
      run_id: runPayload.run_id,
      identifiers: ['123', '10.1000/xyz', 'arxiv:1207.7214', 'weird'],
    });

    const payload = JSON.parse(res.content[0].text) as {
      mapping_uri: string;
      meta_uri: string;
      summary: { total: number; matched: number; not_found: number; errors: number };
    };

    expect(payload.summary).toMatchObject({ total: 4, matched: 3, not_found: 1, errors: 0 });

    const mappingContent = readHepResource(payload.mapping_uri) as any;
    const lines = (mappingContent.text as string).trim().split('\n').map((l: string) => JSON.parse(l));
    expect(lines.map((l: any) => l.status)).toEqual(['matched', 'matched', 'matched', 'not_found']);
    expect(lines.map((l: any) => l.recid)).toEqual(['123', '456', '789', undefined]);

    const metaContent = readHepResource(payload.meta_uri) as any;
    const meta = JSON.parse(metaContent.text) as { matched: number; not_found: number; errors: number; total: number };
    expect(meta).toMatchObject({ total: 4, matched: 3, not_found: 1, errors: 0 });
  });
});
