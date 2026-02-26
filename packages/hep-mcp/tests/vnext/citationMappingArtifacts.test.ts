import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/tools/research/extractBibliography.js', () => ({
  extractBibliography: vi.fn(),
}));

vi.mock('../../src/tools/research/latex/citekeyMapper.js', () => ({
  mapBibEntriesToInspire: vi.fn(),
}));

const extract = await import('../../src/tools/research/extractBibliography.js');
const mapper = await import('../../src/tools/research/latex/citekeyMapper.js');

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/vnext/resources.js';

describe('vNext M5: citation mapping artifacts', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('writes bibliography_raw_v1.json, citekey_to_inspire_v1.json, allowed_citations_v1.json and records them in manifest', async () => {
    vi.mocked(extract.extractBibliography).mockResolvedValueOnce({
      entries: [
        {
          key: 'Doe:2020ab',
          type: 'article',
          doi: '10.1000/xyz',
          title: 'Paper Title',
          authors: ['Doe, John'],
          year: '2020',
        },
      ],
      total: 1,
      with_doi: 1,
      with_arxiv: 0,
      source_file: '/tmp/main.tex',
      arxiv_id: '2001.00001',
    });

    vi.mocked(mapper.mapBibEntriesToInspire).mockResolvedValueOnce({
      'Doe:2020ab': {
        status: 'matched',
        recid: '111',
        match_method: 'doi',
        confidence: 1,
      },
    });

    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Test Project',
      description: 'M5 citation mapping',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', {
      project_id: project.project_id,
      args_snapshot: { purpose: 'm5' },
    });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const mapRes = await handleToolCall('hep_run_build_citation_mapping', {
      run_id: run.run_id,
      identifier: 'dummy',
      allowed_citations_primary: ['inspire:999'],
      include_mapped_references: true,
    });

    const payload = JSON.parse(mapRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      manifest_uri: string;
    };

    expect(payload.artifacts.map(a => a.name).sort()).toEqual([
      'allowed_citations_v1.json',
      'bibliography_raw_v1.json',
      'citekey_to_inspire_v1.json',
    ]);

    const allowedUri = payload.artifacts.find(a => a.name === 'allowed_citations_v1.json')!.uri;
    const allowed = JSON.parse((readHepResource(allowedUri) as any).text) as {
      include_mapped_references: boolean;
      allowed_citations: string[];
    };
    expect(allowed.include_mapped_references).toBe(true);
    expect(allowed.allowed_citations).toContain('inspire:999');
    expect(allowed.allowed_citations).toContain('inspire:111');

    const manifest = JSON.parse((readHepResource(payload.manifest_uri) as any).text) as {
      status: string;
      steps: Array<{ step: string; status: string; artifacts?: Array<{ name: string }> }>;
    };
    expect(manifest.status).toBe('done');
    const last = manifest.steps[manifest.steps.length - 1];
    expect(last.step).toBe('citation_mapping');
    expect(last.status).toBe('done');
    expect(last.artifacts?.map(a => a.name).sort()).toEqual([
      'allowed_citations_v1.json',
      'bibliography_raw_v1.json',
      'citekey_to_inspire_v1.json',
    ]);
  });
});
