import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/vnext/resources.js';

describe('vNext M6: Evidence Catalog v1 (LaTeX)', () => {
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

  it('builds catalog.jsonl, can query paragraphs, and supports locator playback', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Evidence Catalog Project',
      description: 'M6 evidence catalog test',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const buildRes = await handleToolCall('hep_project_build_evidence', {
      project_id: project.project_id,
      main_tex_path: mainTexPath,
      include_cross_refs: true,
    });

    const buildPayload = JSON.parse(buildRes.content[0].text) as {
      paper_id: string;
      catalog_uri: string;
      summary: { by_type: Record<string, number> };
    };

    expect(buildPayload.paper_id).toMatch(/^(recid|arxiv|paper|local)_/);
    expect(buildPayload.catalog_uri).toContain('/evidence/catalog');
    expect(buildPayload.summary.by_type).toBeTruthy();

    const catalog = readHepResource(buildPayload.catalog_uri) as any;
    const lines = String(catalog.text)
      .trim()
      .split('\n')
      .filter(Boolean);
    const items = lines.map(l => JSON.parse(l)) as Array<{
      evidence_id: string;
      type: string;
      text: string;
      locator: { file: string };
      meta?: { label?: string };
    }>;

    expect(items.some(i => i.type === 'equation')).toBe(true);
    expect(items.some(i => i.type === 'section')).toBe(true);
    expect(items.some(i => i.type === 'paragraph')).toBe(true);

    const subfileParagraph = items.find(i => i.type === 'paragraph' && i.text.includes('Content from subfile'));
    expect(subfileParagraph).toBeTruthy();
    expect(subfileParagraph!.locator.file).toContain('sections/subfile_section.tex');

    const einsteinEq = items.find(i => i.type === 'equation' && i.meta?.label === 'eq:einstein');
    expect(einsteinEq).toBeTruthy();

    const playbackRes = await handleToolCall('hep_project_playback_evidence', {
      project_id: project.project_id,
      paper_id: buildPayload.paper_id,
      evidence_id: einsteinEq!.evidence_id,
    });

    const playbackPayload = JSON.parse(playbackRes.content[0].text) as {
      playback: { snippet: string };
    };
    expect(playbackPayload.playback.snippet).toContain('\\label{eq:einstein}');

    const queryRes = await handleToolCall('hep_project_query_evidence', {
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 5,
      types: ['paragraph'],
    });

    const queryPayload = JSON.parse(queryRes.content[0].text) as {
      total_hits: number;
      hits: Array<{ text_preview: string }>;
    };
    expect(queryPayload.total_hits).toBeGreaterThan(0);
    expect(queryPayload.hits.some(h => h.text_preview.includes('Content from subfile'))).toBe(true);

    // Semantic query is fail-fast: requires embeddings built in the run.
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const semanticRes = await handleToolCall('hep_project_query_evidence_semantic', {
      run_id: run.run_id,
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 3,
      types: ['paragraph'],
    });
    expect(semanticRes.isError).toBe(true);
    const semanticErr = JSON.parse(semanticRes.content[0].text) as {
      error: { code: string; message: string; data?: any };
    };
    expect(semanticErr.error.code).toBe('INVALID_PARAMS');
    expect(semanticErr.error.message).toContain('Semantic query requires embeddings.');
    expect(semanticErr.error.message).toContain('hep_project_query_evidence (lexical)');
  });

  it('regression: hep_project_query_evidence lexical mode matches default lexical path', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Evidence Catalog Unified Lexical',
      description: 'phase4 lexical regression',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    await handleToolCall('hep_project_build_evidence', {
      project_id: project.project_id,
      main_tex_path: mainTexPath,
      include_cross_refs: true,
    });

    const baseArgs = {
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 5,
      types: ['paragraph'],
    };

    const defaultRes = await handleToolCall('hep_project_query_evidence', baseArgs);
    expect(defaultRes.isError).not.toBe(true);
    const defaultPayload = JSON.parse(defaultRes.content[0].text) as {
      total_hits: number;
      hits: Array<{ evidence_id: string; text_preview: string }>;
    };

    const lexicalRes = await handleToolCall('hep_project_query_evidence', {
      ...baseArgs,
      mode: 'lexical',
      include_explanation: true,
    });
    expect(lexicalRes.isError).not.toBe(true);
    const lexicalPayload = JSON.parse(lexicalRes.content[0].text) as {
      total_hits: number;
      hits: Array<{ evidence_id: string; text_preview: string }>;
    };

    expect(defaultPayload.total_hits).toBeGreaterThan(0);
    expect(lexicalPayload.total_hits).toBe(defaultPayload.total_hits);
    expect(lexicalPayload.hits.map(h => h.evidence_id)).toEqual(defaultPayload.hits.map(h => h.evidence_id));
    expect(lexicalPayload.hits.some(h => h.text_preview.includes('Content from subfile'))).toBe(true);
  });

  it('hep_project_query_evidence semantic mode fails fast without embeddings (compatible with legacy semantic tool)', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Evidence Catalog Unified Semantic FailFast',
      description: 'phase4 semantic fail-fast',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    await handleToolCall('hep_project_build_evidence', {
      project_id: project.project_id,
      main_tex_path: mainTexPath,
      include_cross_refs: true,
    });

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const queryArgs = {
      run_id: run.run_id,
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 3,
      types: ['paragraph'],
      include_explanation: true,
    };

    const unifiedRes = await handleToolCall('hep_project_query_evidence', {
      ...queryArgs,
      mode: 'semantic',
    });
    expect(unifiedRes.isError).toBe(true);

    const unifiedErr = JSON.parse(unifiedRes.content[0].text) as {
      error: { code: string; message: string; data?: { next_actions?: Array<{ tool: string }> } };
    };
    expect(unifiedErr.error.code).toBe('INVALID_PARAMS');
    expect(unifiedErr.error.message).toContain('hep_run_build_writing_evidence');
    expect(unifiedErr.error.message).toContain('hep_project_query_evidence (lexical)');
    const nextTools = (unifiedErr.error.data?.next_actions ?? []).map(a => a.tool);
    expect(nextTools).toContain('hep_run_build_writing_evidence');

    const legacyRes = await handleToolCall('hep_project_query_evidence_semantic', queryArgs);
    expect(legacyRes.isError).toBe(true);
    const legacyErr = JSON.parse(legacyRes.content[0].text) as {
      error: { code: string; message: string };
    };
    expect(legacyErr.error.code).toBe('INVALID_PARAMS');
    expect(legacyErr.error.message).toBe(unifiedErr.error.message);
  });

  it('mode=semantic without run_id returns actionable error and next_actions', async () => {
    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Evidence Catalog Semantic Missing Run',
      description: 'phase4 run_id guidance',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const res = await handleToolCall('hep_project_query_evidence', {
      project_id: project.project_id,
      mode: 'semantic',
      query: 'Content from subfile',
      limit: 3,
      types: ['paragraph'],
    });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      error: {
        code: string;
        message: string;
        data?: {
          next_actions?: Array<{ tool: string; args?: Record<string, unknown> }>;
        };
      };
    };

    expect(payload.error.code).toBe('INVALID_PARAMS');
    expect(payload.error.message).toBe('run_id is required. Create one with hep_run_create first.');

    const nextActions = payload.error.data?.next_actions ?? [];
    const tools = nextActions.map(a => a.tool);
    expect(tools).toContain('hep_run_create');
    expect(tools).toContain('hep_project_query_evidence');

    const retry = nextActions.find(a => a.tool === 'hep_project_query_evidence');
    expect(retry?.args?.mode).toBe('semantic');
    expect(String(retry?.args?.run_id ?? '')).toContain('hep_run_create');
  });

  it('R9: query tool supports concurrency + deterministic ordering and writes diagnostics', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Evidence Catalog Concurrency',
      description: 'R9 concurrency test',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    await handleToolCall('hep_project_build_evidence', {
      project_id: project.project_id,
      paper_id: 'paper_a',
      main_tex_path: mainTexPath,
      include_cross_refs: true,
    });
    await handleToolCall('hep_project_build_evidence', {
      project_id: project.project_id,
      paper_id: 'paper_b',
      main_tex_path: mainTexPath,
      include_cross_refs: true,
    });

    const args = {
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 5,
      types: ['paragraph'],
      concurrency: 2,
    };

    const r1 = await handleToolCall('hep_project_query_evidence', args);
    expect(r1.isError).not.toBe(true);
    const p1 = JSON.parse(r1.content[0].text) as {
      hits: Array<{ evidence_id: string }>;
      diagnostics_uri?: string;
    };
    expect(p1.hits.length).toBeGreaterThan(0);
    expect(p1.diagnostics_uri).toBeTruthy();

    const r2 = await handleToolCall('hep_project_query_evidence', args);
    expect(r2.isError).not.toBe(true);
    const p2 = JSON.parse(r2.content[0].text) as {
      hits: Array<{ evidence_id: string }>;
    };

    expect(p1.hits.map(h => h.evidence_id)).toEqual(p2.hits.map(h => h.evidence_id));

    const diag = JSON.parse(String((readHepResource(p1.diagnostics_uri!) as any).text)) as {
      project_id: string;
      operation: string;
      budgets: Array<{ key: string; source?: { kind?: string } }>;
      warnings: Array<{ code: string; data?: { concurrency?: number } }>;
    };
    expect(diag.project_id).toBe(project.project_id);
    expect(diag.operation).toBe('project_query_evidence');
    expect(diag.budgets.find(b => b.key === 'budget.concurrency')?.source?.kind).toBe('tool_args');
    expect(diag.warnings.some(w => w.code === 'concurrency' && w.data?.concurrency === 2)).toBe(true);
  });

  it('records a project diagnostics artifact when max_paragraph_length truncates paragraphs', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Evidence Catalog Budget',
      description: 'M6 truncation diagnostics test',
    });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const buildRes = await handleToolCall('hep_project_build_evidence', {
      project_id: project.project_id,
      main_tex_path: mainTexPath,
      include_cross_refs: true,
      max_paragraph_length: 20,
    });
    expect(buildRes.isError).not.toBe(true);

    const buildPayload = JSON.parse(buildRes.content[0].text) as {
      diagnostics_uri: string;
    };
    expect(buildPayload.diagnostics_uri).toBeTruthy();

    const diag = JSON.parse(String((readHepResource(buildPayload.diagnostics_uri) as any).text)) as {
      project_id: string;
      operation: string;
      budgets: Array<{ key: string; source?: { kind?: string } }>;
      hits: Array<{ key: string; action: string }>;
      warnings: Array<{ code: string; data?: { key?: string } }>;
    };
    expect(diag.project_id).toBe(project.project_id);
    expect(diag.operation).toBe('project_build_evidence');
    expect(diag.budgets.find(b => b.key === 'evidence.max_paragraph_length')?.source?.kind).toBe('tool_args');
    expect(diag.hits.some(h => h.key === 'evidence.max_paragraph_length' && h.action === 'truncate')).toBe(true);
    expect(diag.warnings.some(w => w.code === 'budget_hit' && w.data?.key === 'evidence.max_paragraph_length')).toBe(true);
  });
});
