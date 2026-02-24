import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/vnext/resources.js';

function readFixtureJson<T>(fileName: string): T {
  const fixtureDir = new URL('../fixtures/vnext/m7/', import.meta.url);
  const p = new URL(fileName, fixtureDir);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

describe('vNext M7: hep_render_latex (JSON→LaTeX + verifier enforcement)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
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

  it('fails on unauthorized citations (verifier SSOT)', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M7 unauthorized', description: 'm7' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: ['inspire:999'],
      cite_mapping: citeMapping,
    });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      error?: { code?: string; message?: string; data?: { issues?: Array<{ type?: string; message?: string }> } };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.message).toContain("Citation '");
    expect(payload.error?.message).toContain('not in allowlist');
    expect(payload.error?.message).toContain('hep_run_build_citation_mapping');
    expect(payload.error?.data?.issues?.some(i => i.type === 'unauthorized_citation')).toBe(true);
    expect(payload.error?.data?.issues?.some(i => String(i.message ?? '').includes('not in allowlist'))).toBe(true);
  });


  it('fails with actionable guidance when allowlist artifact is missing', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M7 missing allowlist', description: 'm7' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
    });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      error?: {
        code?: string;
        message?: string;
        data?: { next_actions?: Array<{ tool?: string }> };
      };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.message).toContain('Citation allowlist not found');
    expect(payload.error?.message).toContain('hep_run_build_citation_mapping');
    const nextTools = (payload.error?.data?.next_actions ?? []).map(a => a.tool);
    expect(nextTools).toContain('hep_run_build_citation_mapping');
  });

  it('fails on missing citations for grounded factual sentences (verifier SSOT)', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const draftMissing = JSON.parse(JSON.stringify(draft)) as any;
    draftMissing.paragraphs[0].sentences[0].recids = [];
    draftMissing.paragraphs[0].sentences[0].type = 'fact';
    draftMissing.paragraphs[0].sentences[0].is_grounded = true;

    const projectRes = await handleToolCall('hep_project_create', { name: 'M7 missing', description: 'm7' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft: draftMissing,
      allowed_citations: [],
      cite_mapping: citeMapping,
    });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      error?: { code?: string; data?: { issues?: Array<{ type?: string }> } };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues?.some(i => i.type === 'missing_citation')).toBe(true);
  });

  it('renders LaTeX with \\cite{} and writes artifacts on success', async () => {
    const draft = readFixtureJson<any>('section_draft.min.json');
    const allowed = readFixtureJson<string[]>('allowed_citations.min.json');
    const citeMapping = readFixtureJson<any>('cite_mapping.min.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'M7 success', description: 'm7' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: allowed,
      cite_mapping: citeMapping,
    });

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { verifier_pass: boolean };
    };
    expect(payload.summary.verifier_pass).toBe(true);

    const latexUri = payload.artifacts.find(a => a.name === 'rendered_latex.tex')?.uri;
    expect(latexUri).toBeTruthy();
    const latex = String((readHepResource(latexUri!) as any).text);
    expect(latex).toContain('\\cite{Doe:2020ab}');
  });
});
