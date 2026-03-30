import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';

async function makeTinyPdfBytes(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage([320, 420]);
  page.drawText('Writing evidence PDF fixture', { x: 24, y: 380, size: 14, font });
  return await pdfDoc.save();
}

function writeTempPdf(bytes: Uint8Array): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-writing-evidence-'));
  const p = path.join(dir, 'fixture.pdf');
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function runArtifactUri(runId: string, artifactName: string): string {
  return `rep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function readJsonResource<T>(uri: string): T {
  return JSON.parse(String((readHepResource(uri) as any).text)) as T;
}

function makeVerificationArtifactRef(runId: string, artifactName: string, content: string) {
  return {
    uri: runArtifactUri(runId, `artifacts/${artifactName}`),
    sha256: sha256(content),
  };
}

describe('Open Roadmap writing evidence: hep_run_build_writing_evidence + semantic query', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;
  const tempDirs: string[] = [];

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
    for (const d of tempDirs) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('builds LaTeX evidence artifacts, skips same-paper PDF before build, and enables semantic query when embeddings exist', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const pdfPath = writeTempPdf(await makeTinyPdfBytes());
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      latex_sources: [{ main_tex_path: mainTexPath, include_cross_refs: true, paper_id: 'paper_shared' }],
      pdf_source: { pdf_path: pdfPath, mode: 'text', max_pages: 2, output_prefix: 'writing_evidence_pdf' },
    });
    expect(buildRes.isError).not.toBe(true);

    const buildPayload = JSON.parse(buildRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { latex_items: number; pdf_included: boolean; embedding_model: string };
    };
    expect(buildPayload.summary.latex_items).toBeGreaterThan(0);
    expect(buildPayload.summary.pdf_included).toBe(false);
    expect(buildPayload.summary.embedding_model).toContain('hashing_fnv1a32');
    expect(buildPayload.artifacts.some(a => a.name === 'writing_evidence_pdf_evidence_catalog.jsonl')).toBe(false);
    expect(buildPayload.artifacts.some(a => a.name === 'pdf_evidence_embeddings.jsonl')).toBe(false);
    expect(buildPayload.artifacts.some(a => a.name === 'pdf_evidence_enrichment.jsonl')).toBe(false);

    const latexCatalogUri = buildPayload.artifacts.find(a => a.name === 'latex_evidence_catalog.jsonl')?.uri;
    const latexEmbeddingsUri = buildPayload.artifacts.find(a => a.name === 'latex_evidence_embeddings.jsonl')?.uri;
    const latexEnrichmentUri = buildPayload.artifacts.find(a => a.name === 'latex_evidence_enrichment.jsonl')?.uri;
    const metaUri = buildPayload.artifacts.find(a => a.name === 'writing_evidence_meta_v1.json')?.uri;
    const statusUri = buildPayload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;

    expect(latexCatalogUri).toBeTruthy();
    expect(latexEmbeddingsUri).toBeTruthy();
    expect(latexEnrichmentUri).toBeTruthy();
    expect(metaUri).toBeTruthy();
    expect(statusUri).toBeTruthy();

    const status = readJsonResource<{
      version: number;
      sources: Array<{ source_kind: string; status: string; paper_id?: string; error_code?: string }>;
      summary: { succeeded: number; failed: number; skipped: number };
    }>(statusUri!);
    expect(status.version).toBe(1);
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_kind: 'latex', status: 'success', paper_id: 'paper_shared' }),
      expect.objectContaining({
        source_kind: 'pdf',
        status: 'skipped',
        paper_id: 'paper_shared',
        error_code: 'PDF_SKIPPED_LATEX_AUTHORITY',
      }),
    ]));
    expect(status.summary.succeeded).toBe(1);
    expect(status.summary.failed).toBe(0);
    expect(status.summary.skipped).toBe(1);

    const meta = readJsonResource<{ pdf: unknown | null }>(metaUri!);
    expect(meta.pdf).toBeNull();

    const embeddingsText = String((readHepResource(latexEmbeddingsUri!) as any).text);
    const embLines = embeddingsText.split('\n').filter(Boolean);
    const emb0 = JSON.parse(embLines[0]!) as { evidence_id: string; vector: { dim: number; indices: number[]; values: number[] } };
    expect(typeof emb0.evidence_id).toBe('string');
    expect(emb0.vector.dim).toBeGreaterThan(0);
    expect(Array.isArray(emb0.vector.indices)).toBe(true);
    expect(Array.isArray(emb0.vector.values)).toBe(true);

    const enrichText = String((readHepResource(latexEnrichmentUri!) as any).text);
    const enrichLines = enrichText.split('\n').filter(Boolean);
    const enrich0 = JSON.parse(enrichLines[0]!) as { evidence_id: string; importance_score: number };
    expect(typeof enrich0.evidence_id).toBe('string');
    expect(enrich0.importance_score).toBeGreaterThanOrEqual(0);
    expect(enrich0.importance_score).toBeLessThanOrEqual(1);

    const semanticRes = await handleToolCall('hep_project_query_evidence_semantic', {
      run_id: run.run_id,
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 3,
      types: ['paragraph'],
    });
    expect(semanticRes.isError).not.toBe(true);

    const semanticPayload = JSON.parse(semanticRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { semantic: { implemented: boolean; model?: string } };
    };
    expect(semanticPayload.summary.semantic.implemented).toBe(true);
    expect(semanticPayload.summary.semantic.model).toContain('hashing_fnv1a32');

    const queryUri = semanticPayload.artifacts[0]?.uri;
    expect(queryUri).toBeTruthy();
    const queryArtifact = readJsonResource<{
      result: { total_hits: number; hits: Array<{ text_preview: string; paper_id: string }> };
    }>(queryUri!);
    expect(queryArtifact.result.total_hits).toBeGreaterThan(0);
    expect(queryArtifact.result.hits.some(h => h.text_preview.includes('Content from subfile'))).toBe(true);
    expect(queryArtifact.result.hits.every(h => h.paper_id === 'paper_shared')).toBe(true);
    expect(queryArtifact.result.hits.some(h => h.paper_id === 'run_pdf')).toBe(false);

    const unifiedSemanticRes = await handleToolCall('hep_project_query_evidence', {
      mode: 'semantic',
      run_id: run.run_id,
      project_id: project.project_id,
      query: 'Content from subfile',
      limit: 3,
      types: ['paragraph'],
      include_explanation: true,
    });
    expect(unifiedSemanticRes.isError).not.toBe(true);

    const unifiedSemanticPayload = JSON.parse(unifiedSemanticRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { semantic: { implemented: boolean; model?: string }; explanation_included: boolean };
    };
    expect(unifiedSemanticPayload.summary.semantic.implemented).toBe(true);
    expect(unifiedSemanticPayload.summary.semantic.model).toContain('hashing_fnv1a32');
    expect(unifiedSemanticPayload.summary.explanation_included).toBe(true);

    const unifiedQueryUri = unifiedSemanticPayload.artifacts[0]?.uri;
    expect(unifiedQueryUri).toBeTruthy();
    const unifiedArtifact = readJsonResource<{
      query: { include_explanation: boolean };
      result: {
        total_hits: number;
        hits: Array<{ text_preview: string; matched_tokens?: string[]; token_overlap_ratio?: number; paper_id: string }>;
      };
    }>(unifiedQueryUri!);
    expect(unifiedArtifact.query.include_explanation).toBe(true);
    expect(unifiedArtifact.result.total_hits).toBeGreaterThan(0);
    expect(unifiedArtifact.result.hits.some(h => h.text_preview.includes('Content from subfile'))).toBe(true);
    expect(unifiedArtifact.result.hits.every(h => Array.isArray(h.matched_tokens))).toBe(true);
    expect(unifiedArtifact.result.hits.every(h => typeof h.token_overlap_ratio === 'number')).toBe(true);
    expect(unifiedArtifact.result.hits.every(h => h.paper_id === 'paper_shared')).toBe(true);
    expect(unifiedArtifact.result.hits.some(h => h.paper_id === 'run_pdf')).toBe(false);
  });

  it('uses explicit pdf_source.paper_id for a different paper and never emits run_pdf in semantic hits', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const pdfPath = writeTempPdf(await makeTinyPdfBytes());
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence explicit pdf', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      latex_sources: [{ main_tex_path: mainTexPath, include_cross_refs: true, paper_id: 'paper_latex' }],
      pdf_source: {
        paper_id: 'paper_pdf',
        pdf_path: pdfPath,
        mode: 'text',
        max_pages: 2,
        output_prefix: 'writing_evidence_pdf',
      },
    });
    expect(buildRes.isError).not.toBe(true);

    const buildPayload = JSON.parse(buildRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { pdf_included: boolean };
    };
    expect(buildPayload.summary.pdf_included).toBe(true);
    expect(buildPayload.artifacts.some(a => a.name === 'writing_evidence_pdf_evidence_catalog.jsonl')).toBe(true);

    const statusUri = buildPayload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;
    const metaUri = buildPayload.artifacts.find(a => a.name === 'writing_evidence_meta_v1.json')?.uri;
    expect(statusUri).toBeTruthy();
    expect(metaUri).toBeTruthy();

    const status = readJsonResource<{
      sources: Array<{ source_kind: string; status: string; paper_id?: string }>;
      summary: { succeeded: number; failed: number; skipped: number };
    }>(statusUri!);
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_kind: 'latex', status: 'success', paper_id: 'paper_latex' }),
      expect.objectContaining({ source_kind: 'pdf', status: 'success', paper_id: 'paper_pdf' }),
    ]));
    expect(status.summary.succeeded).toBe(2);
    expect(status.summary.failed).toBe(0);
    expect(status.summary.skipped).toBe(0);

    const meta = readJsonResource<{ pdf: { paper_id?: string | null } | null }>(metaUri!);
    expect(meta.pdf?.paper_id).toBe('paper_pdf');

    const semanticRes = await handleToolCall('hep_project_query_evidence_semantic', {
      run_id: run.run_id,
      project_id: project.project_id,
      paper_id: 'paper_pdf',
      query: 'Writing evidence PDF fixture',
      limit: 3,
      types: ['pdf_page'],
    });
    expect(semanticRes.isError).not.toBe(true);

    const semanticPayload = JSON.parse(semanticRes.content[0].text) as {
      artifacts: Array<{ uri: string }>;
      summary: { semantic: { implemented: boolean } };
    };
    expect(semanticPayload.summary.semantic.implemented).toBe(true);

    const queryArtifact = readJsonResource<{
      result: { total_hits: number; hits: Array<{ paper_id: string; text_preview: string }> };
    }>(semanticPayload.artifacts[0]!.uri);
    expect(queryArtifact.result.total_hits).toBeGreaterThan(0);
    expect(queryArtifact.result.hits.some(h => h.text_preview.includes('Writing evidence PDF fixture'))).toBe(true);
    expect(queryArtifact.result.hits.every(h => h.paper_id === 'paper_pdf')).toBe(true);
    expect(queryArtifact.result.hits.some(h => h.paper_id === 'run_pdf')).toBe(false);

    const unifiedSemanticRes = await handleToolCall('hep_project_query_evidence', {
      run_id: run.run_id,
      project_id: project.project_id,
      paper_id: 'paper_pdf',
      query: 'Writing evidence PDF fixture',
      limit: 3,
      types: ['pdf_page'],
    });
    expect(unifiedSemanticRes.isError).not.toBe(true);

    const unifiedSemanticPayload = JSON.parse(unifiedSemanticRes.content[0].text) as {
      summary: { semantic: { implemented: boolean } };
      artifacts: Array<{ uri: string }>;
    };
    expect(unifiedSemanticPayload.summary.semantic.implemented).toBe(true);

    const unifiedQueryArtifact = readJsonResource<{
      result: { hits: Array<{ paper_id: string }> };
    }>(unifiedSemanticPayload.artifacts[0]!.uri);
    expect(unifiedQueryArtifact.result.hits.length).toBeGreaterThan(0);
    expect(unifiedQueryArtifact.result.hits.every(h => h.paper_id === 'paper_pdf')).toBe(true);
  });

  it('fails closed when pdf_source.paper_id is missing and no successful LaTeX paper exists', async () => {
    const pdfPath = writeTempPdf(await makeTinyPdfBytes());
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence pdf missing id', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      pdf_source: { pdf_path: pdfPath, mode: 'text', max_pages: 2, output_prefix: 'writing_evidence_pdf' },
    });
    expect(buildRes.isError).toBe(true);

    const err = JSON.parse(buildRes.content[0].text) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_PARAMS');
    expect(err.error.message).toContain('pdf_source.paper_id is required');

    const statusUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_evidence_source_status.json')}`;
    const status = readJsonResource<{
      sources: Array<{ source_kind: string; status: string; error_code?: string }>;
      summary: { succeeded: number; failed: number; skipped: number };
    }>(statusUri);
    expect(status.sources).toEqual([
      expect.objectContaining({
        source_kind: 'pdf',
        status: 'failed',
        error_code: 'PDF_PAPER_ID_REQUIRED',
      }),
    ]);
    expect(status.summary.succeeded).toBe(0);
    expect(status.summary.failed).toBe(1);
    expect(status.summary.skipped).toBe(0);
  });

  it('fails closed when pdf_source.paper_id is missing and multiple successful LaTeX papers exist', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));
    const pdfPath = writeTempPdf(await makeTinyPdfBytes());
    tempDirs.push(path.dirname(pdfPath));

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence pdf ambiguous id', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      latex_sources: [
        { main_tex_path: mainTexPath, include_cross_refs: true, paper_id: 'paper_a' },
        { main_tex_path: mainTexPath, include_cross_refs: true, paper_id: 'paper_b' },
      ],
      pdf_source: { pdf_path: pdfPath, mode: 'text', max_pages: 2, output_prefix: 'writing_evidence_pdf' },
    });
    expect(buildRes.isError).toBe(true);

    const err = JSON.parse(buildRes.content[0].text) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('INVALID_PARAMS');
    expect(err.error.message).toContain('multiple successful LaTeX papers exist');

    const statusUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_evidence_source_status.json')}`;
    const status = readJsonResource<{
      sources: Array<{ source_kind: string; status: string; paper_id?: string; error_code?: string }>;
      summary: { succeeded: number; failed: number; skipped: number };
    }>(statusUri);
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_kind: 'latex', status: 'success', paper_id: 'paper_a' }),
      expect.objectContaining({ source_kind: 'latex', status: 'success', paper_id: 'paper_b' }),
      expect.objectContaining({
        source_kind: 'pdf',
        status: 'failed',
        error_code: 'PDF_PAPER_ID_AMBIGUOUS',
      }),
    ]));
    expect(status.summary.succeeded).toBe(2);
    expect(status.summary.failed).toBe(1);
    expect(status.summary.skipped).toBe(0);
  });

  it('records diagnostics when max_evidence_items truncates writing evidence selection', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence budgets', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      latex_sources: [{ main_tex_path: mainTexPath, include_cross_refs: true }],
      max_evidence_items: 1,
    });
    expect(buildRes.isError).not.toBe(true);

    const payload = JSON.parse(buildRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
    };

    const diagRef = payload.artifacts.find(a =>
      a.uri.startsWith('hep://runs/')
      && a.name.includes('_writing_evidence_enrichment_diagnostics.json')
    );
    const diagUri = diagRef?.uri;
    expect(diagUri).toBeTruthy();

    const diag = JSON.parse(String((readHepResource(diagUri!) as any).text)) as {
      run_id: string;
      step: string;
      budgets: Array<{ key: string; source?: { kind?: string } }>;
      hits: Array<{ key: string; action: string }>;
      warnings: Array<{ code: string; data?: { key?: string } }>;
      artifacts: { project_diagnostics_uri: string };
    };
    expect(diag.run_id).toBe(run.run_id);
    expect(diag.step).toBe('writing_evidence_enrichment');
    expect(diag.hits.some(h => h.key === 'writing.max_evidence_items' && h.action === 'truncate')).toBe(true);
    expect(diag.warnings.some(w => w.code === 'budget_hit' && w.data?.key === 'writing.max_evidence_items')).toBe(true);
    expect(diag.budgets.find(b => b.key === 'writing.max_evidence_items')?.source?.kind).toBe('tool_args');

    const metaUri = payload.artifacts.find(a => a.name === 'writing_evidence_meta_v1.json')?.uri;
    expect(metaUri).toBeTruthy();
    const meta = JSON.parse(String((readHepResource(metaUri!) as any).text)) as { warnings?: string[] };
    expect(meta.warnings?.some(w => w.includes('max_evidence_items'))).toBe(true);

    const projectDiag = JSON.parse(String((readHepResource(diag.artifacts.project_diagnostics_uri) as any).text)) as {
      run_id: string;
      step: string;
    };
    expect(projectDiag.run_id).toBe(run.run_id);
    expect(projectDiag.step).toBe('writing_evidence_enrichment');

    const manifest = JSON.parse(String((readHepResource(`hep://runs/${encodeURIComponent(run.run_id)}/manifest`) as any).text)) as {
      steps?: Array<{ step: string; artifacts?: Array<{ name: string }> }>;
    };
    const writingStep = manifest.steps?.find(s => s.step === 'writing_evidence_enrichment');
    expect(writingStep?.artifacts?.some(a => a.name === diagRef?.name)).toBe(true);
  });

  it('continue_on_error=true records failures but still succeeds when at least one source works', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));
    const missingTexPath = path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}.tex`);

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence tolerance', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      continue_on_error: true,
      latex_sources: [{ main_tex_path: mainTexPath, include_cross_refs: true }, { main_tex_path: missingTexPath }],
    });
    expect(buildRes.isError).not.toBe(true);

    const payload = JSON.parse(buildRes.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
    const statusUri = payload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;
    expect(statusUri).toBeTruthy();

    const status = JSON.parse(String((readHepResource(statusUri!) as any).text)) as {
      sources: Array<{ source_kind: string; status: string }>;
      summary: { succeeded: number; failed: number; skipped: number };
    };
    expect(status.sources.filter(s => s.source_kind === 'latex').length).toBe(2);
    expect(status.summary.succeeded).toBe(1);
    expect(status.summary.failed).toBe(1);
    expect(status.summary.skipped).toBe(0);
  });

  it('accepts computation followup bridge artifacts as the typed verification metadata authority', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence bridge', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const runArtifactsDir = path.join(dataDir, 'runs', run.run_id, 'artifacts');
    fs.mkdirSync(runArtifactsDir, { recursive: true });
    const resultPath = path.join(runArtifactsDir, 'computation_result_v1.json');
    const outputPath = path.join(runArtifactsDir, 'task_001.json');
    const resultContent = JSON.stringify({ status: 'completed' }, null, 2) + '\n';
    const outputContent = JSON.stringify({ amplitude: 1.23 }, null, 2) + '\n';
    fs.writeFileSync(resultPath, resultContent, 'utf-8');
    fs.writeFileSync(outputPath, outputContent, 'utf-8');

    const subjectArtifactName = 'verification_subject_computation_result_v1.json';
    const verdictArtifactName = 'verification_subject_verdict_computation_result_v1.json';
    const coverageArtifactName = 'verification_coverage_v1.json';
    const subjectContent = JSON.stringify({
      schema_version: 1,
      subject_id: `result:${run.run_id}:computation_result`,
      subject_kind: 'result',
      run_id: run.run_id,
      title: 'Bridge-only refresh',
      description: 'Verification subject for bridge-only writing evidence metadata.',
      source_refs: [{
        uri: runArtifactUri(run.run_id, 'artifacts/task_001.json'),
        sha256: sha256(outputContent),
      }],
      linked_identifiers: [{
        id_kind: 'computation_result_uri',
        id_value: runArtifactUri(run.run_id, 'artifacts/computation_result_v1.json'),
      }],
    }, null, 2) + '\n';
    const subjectRef = makeVerificationArtifactRef(run.run_id, subjectArtifactName, subjectContent);
    const verdictContent = JSON.stringify({
      schema_version: 1,
      verdict_id: `verdict:${run.run_id}:computation_result`,
      run_id: run.run_id,
      subject_id: `result:${run.run_id}:computation_result`,
      subject_ref: subjectRef,
      status: 'not_attempted',
      summary: 'Decisive verification has not been attempted yet.',
      check_run_refs: [],
      missing_decisive_checks: [{
        check_kind: 'decisive_verification_pending',
        reason: 'Decisive verification has not been attempted yet.',
        priority: 'high',
      }],
    }, null, 2) + '\n';
    const verdictRef = makeVerificationArtifactRef(run.run_id, verdictArtifactName, verdictContent);
    const coverageContent = JSON.stringify({
      schema_version: 1,
      coverage_id: `coverage:${run.run_id}:computation_result`,
      run_id: run.run_id,
      generated_at: '2026-03-26T00:00:00.000Z',
      subject_refs: [subjectRef],
      subject_verdict_refs: [verdictRef],
      summary: {
        subjects_total: 1,
        subjects_verified: 0,
        subjects_partial: 0,
        subjects_failed: 0,
        subjects_blocked: 0,
        subjects_not_attempted: 1,
      },
      missing_decisive_checks: [{
        subject_id: `result:${run.run_id}:computation_result`,
        subject_ref: subjectRef,
        check_kind: 'decisive_verification_pending',
        reason: 'Decisive verification has not been attempted yet.',
        priority: 'high',
      }],
    }, null, 2) + '\n';
    const coverageRef = makeVerificationArtifactRef(run.run_id, coverageArtifactName, coverageContent);
    fs.writeFileSync(path.join(runArtifactsDir, subjectArtifactName), subjectContent, 'utf-8');
    fs.writeFileSync(path.join(runArtifactsDir, verdictArtifactName), verdictContent, 'utf-8');
    fs.writeFileSync(path.join(runArtifactsDir, coverageArtifactName), coverageContent, 'utf-8');

    const writingBridgeArtifactName = 'writing_followup_bridge_v1.json';
    const reviewBridgeArtifactName = 'review_followup_bridge_v1.json';
    const bridgePayloadBase = {
      schema_version: 1,
      run_id: run.run_id,
      objective_title: 'Bridge-only refresh',
      feedback_signal: 'success',
      decision_kind: 'capture_finding',
      summary: 'Bridge seed should refresh writing evidence metadata without faking LaTeX evidence.',
      computation_result_uri: runArtifactUri(run.run_id, 'artifacts/computation_result_v1.json'),
      manifest_ref: {
        uri: runArtifactUri(run.run_id, 'computation/manifest.json'),
        sha256: 'a'.repeat(64),
      },
      produced_artifact_refs: [
        {
          uri: runArtifactUri(run.run_id, 'artifacts/task_001.json'),
          sha256: sha256(outputContent),
        },
      ],
      verification_refs: {
        subject_refs: [subjectRef],
        subject_verdict_refs: [verdictRef],
        coverage_refs: [coverageRef],
      },
    };
    fs.writeFileSync(
      path.join(runArtifactsDir, writingBridgeArtifactName),
      JSON.stringify({
        ...bridgePayloadBase,
        schema_version: 1,
        bridge_kind: 'writing',
        target: {
          task_kind: 'draft_update',
          title: 'Update draft from bridge seed',
          target_node_id: 'draft-seed:run',
          suggested_content_type: 'section_output',
          seed_payload: {
            computation_result_uri: runArtifactUri(run.run_id, 'artifacts/computation_result_v1.json'),
            manifest_uri: runArtifactUri(run.run_id, 'computation/manifest.json'),
            summary: 'Bridge seed should refresh writing evidence metadata without faking LaTeX evidence.',
            produced_artifact_uris: [runArtifactUri(run.run_id, 'artifacts/task_001.json')],
            finding_node_ids: ['finding:test'],
            draft_node_id: 'draft-seed:run',
          },
        },
        context: {
          draft_context_mode: 'seeded_draft',
        },
      }, null, 2) + '\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(runArtifactsDir, reviewBridgeArtifactName),
      JSON.stringify({
        ...bridgePayloadBase,
        bridge_kind: 'review',
        target: {
          task_kind: 'review',
          title: 'Review draft from bridge seed',
          target_node_id: 'review:run',
          suggested_content_type: 'reviewer_report',
          seed_payload: {
            computation_result_uri: runArtifactUri(run.run_id, 'artifacts/computation_result_v1.json'),
            manifest_uri: runArtifactUri(run.run_id, 'computation/manifest.json'),
            summary: 'Bridge seed should refresh writing evidence metadata without faking LaTeX evidence.',
            produced_artifact_uris: [runArtifactUri(run.run_id, 'artifacts/task_001.json')],
            issue_node_id: 'review:run',
            target_draft_node_id: 'draft-seed:run',
            source_artifact_name: 'staged_reviewer_report_fixture.json',
            source_content_type: 'reviewer_report',
          },
        },
        handoff: {
          handoff_kind: 'review',
          target_node_id: 'review:run',
          payload: {
            issue_node_id: 'review:run',
            target_draft_node_id: 'draft-seed:run',
          },
        },
        context: {
          draft_context_mode: 'existing_draft',
          draft_source_artifact_name: 'staged_section_output_fixture.json',
          draft_source_content_type: 'section_output',
          review_source_artifact_name: 'staged_reviewer_report_fixture.json',
          review_source_content_type: 'reviewer_report',
        },
      }, null, 2) + '\n',
      'utf-8',
    );

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      bridge_artifact_names: [writingBridgeArtifactName, reviewBridgeArtifactName],
    });
    expect(buildRes.isError).not.toBe(true);

    const payload = JSON.parse(buildRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { bridge_sources: number; latex_items: number };
    };
    expect(payload.summary.bridge_sources).toBe(2);
    expect(payload.summary.latex_items).toBe(0);

    const statusUri = payload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;
    const metaUri = payload.artifacts.find(a => a.name === 'writing_evidence_meta_v1.json')?.uri;
    expect(statusUri).toBeTruthy();
    expect(metaUri).toBeTruthy();

    const status = JSON.parse(String((readHepResource(statusUri!) as any).text)) as {
      sources: Array<{ source_kind: string; identifier: string; status: string }>;
      summary: { succeeded: number; failed: number };
    };
    expect(status.sources).toHaveLength(2);
    expect(status.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_kind: 'bridge',
        identifier: reviewBridgeArtifactName,
        status: 'success',
      }),
      expect.objectContaining({
        source_kind: 'bridge',
        identifier: writingBridgeArtifactName,
        status: 'success',
      }),
    ]));
    expect(status.summary.succeeded).toBe(2);
    expect(status.summary.failed).toBe(0);

    const meta = JSON.parse(String((readHepResource(metaUri!) as any).text)) as {
      bridges: Array<{ artifact_name: string; bridge_kind: string; task_kind: string; produced_artifact_count: number }>;
      verification: {
        subject_refs: Array<{ uri: string }>;
        check_run_refs: Array<{ uri: string }>;
        subject_verdict_refs: Array<{ uri: string }>;
        coverage_refs: Array<{ uri: string }>;
        subject_verdicts: Array<{ uri: string; subject_id: string; status: string; missing_decisive_checks: Array<{ check_kind: string; reason: string; priority: string }> }>;
        coverage: Array<{ uri: string; summary: { subjects_not_attempted: number }; missing_decisive_checks: Array<{ subject_id: string; check_kind: string; reason: string; priority: string }> }>;
      };
      sources_summary: { succeeded: number };
    };
    expect(meta.sources_summary.succeeded).toBe(2);
    expect(meta.bridges).toHaveLength(2);
    expect(meta.bridges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifact_name: writingBridgeArtifactName,
        bridge_kind: 'writing',
        task_kind: 'draft_update',
        produced_artifact_count: 1,
      }),
      expect.objectContaining({
        artifact_name: reviewBridgeArtifactName,
        bridge_kind: 'review',
        task_kind: 'review',
        produced_artifact_count: 1,
      }),
    ]));
    expect(meta.verification.subject_refs).toEqual([subjectRef]);
    expect(meta.verification.check_run_refs).toEqual([]);
    expect(meta.verification.subject_verdict_refs).toEqual([verdictRef]);
    expect(meta.verification.coverage_refs).toEqual([coverageRef]);
    expect(meta.verification.subject_verdicts).toEqual([{
      uri: verdictRef.uri,
      subject_id: `result:${run.run_id}:computation_result`,
      status: 'not_attempted',
      missing_decisive_checks: [{
        check_kind: 'decisive_verification_pending',
        reason: 'Decisive verification has not been attempted yet.',
        priority: 'high',
      }],
    }]);
    expect(meta.verification.coverage).toEqual([{
      uri: coverageRef.uri,
      summary: {
        subjects_total: 1,
        subjects_verified: 0,
        subjects_partial: 0,
        subjects_failed: 0,
        subjects_blocked: 0,
        subjects_not_attempted: 1,
      },
      missing_decisive_checks: [{
        subject_id: `result:${run.run_id}:computation_result`,
        check_kind: 'decisive_verification_pending',
        reason: 'Decisive verification has not been attempted yet.',
        priority: 'high',
      }],
    }]);
  });

  it('does not re-export the deleted heuristic verification surface from the research barrel', async () => {
    const researchTools = await import('../../src/tools/research/index.js');

    expect(researchTools).not.toHaveProperty('validatePhysics');
    expect(researchTools).not.toHaveProperty('PHYSICS_AXIOMS');
    expect(researchTools).not.toHaveProperty('PhysicsValidationStatus');
  });

  it('treats missing bridge verification artifacts as a bridge-source failure and writes source status before failing', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence bridge fail-fast', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const runArtifactsDir = path.join(dataDir, 'runs', run.run_id, 'artifacts');
    fs.mkdirSync(runArtifactsDir, { recursive: true });
    const outputContent = JSON.stringify({ amplitude: 2.34 }, null, 2) + '\n';
    fs.writeFileSync(path.join(runArtifactsDir, 'task_001.json'), outputContent, 'utf-8');

    const missingVerdictRef = {
      uri: runArtifactUri(run.run_id, 'artifacts/verification_subject_verdict_computation_result_v1.json'),
      sha256: 'b'.repeat(64),
    };
    fs.writeFileSync(
      path.join(runArtifactsDir, 'writing_followup_bridge_v1.json'),
      JSON.stringify({
        schema_version: 1,
        bridge_kind: 'writing',
        run_id: run.run_id,
        objective_title: 'Broken bridge verification',
        feedback_signal: 'success',
        decision_kind: 'capture_finding',
        summary: 'Broken verification refs should fail closed.',
        computation_result_uri: runArtifactUri(run.run_id, 'artifacts/computation_result_v1.json'),
        manifest_ref: {
          uri: runArtifactUri(run.run_id, 'computation/manifest.json'),
          sha256: 'c'.repeat(64),
        },
        produced_artifact_refs: [{
          uri: runArtifactUri(run.run_id, 'artifacts/task_001.json'),
          sha256: sha256(outputContent),
        }],
        verification_refs: {
          subject_verdict_refs: [missingVerdictRef],
        },
        target: {
          task_kind: 'draft_update',
          title: 'Broken bridge',
          target_node_id: 'draft-seed:run',
          suggested_content_type: 'section_output',
          seed_payload: {
            computation_result_uri: runArtifactUri(run.run_id, 'artifacts/computation_result_v1.json'),
            manifest_uri: runArtifactUri(run.run_id, 'computation/manifest.json'),
            summary: 'Broken verification refs should fail closed.',
            produced_artifact_uris: [runArtifactUri(run.run_id, 'artifacts/task_001.json')],
            finding_node_ids: ['finding:test'],
            draft_node_id: 'draft-seed:run',
          },
        },
        context: {
          draft_context_mode: 'seeded_draft',
        },
      }, null, 2) + '\n',
      'utf-8',
    );

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      bridge_artifact_names: ['writing_followup_bridge_v1.json'],
    });
    expect(buildRes.isError).toBe(true);

    const statusUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_evidence_source_status.json')}`;
    const status = JSON.parse(String((readHepResource(statusUri) as any).text)) as {
      sources: Array<{ source_kind: string; identifier: string; status: string; error_code?: string }>;
      summary: { succeeded: number; failed: number };
    };
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0]).toMatchObject({
      source_kind: 'bridge',
      identifier: 'writing_followup_bridge_v1.json',
      status: 'failed',
      error_code: 'BRIDGE_PARSE_ERROR',
    });
    expect(status.summary.succeeded).toBe(0);
    expect(status.summary.failed).toBe(1);
  });

  it('continue_on_error=false writes status artifact before failing fast', async () => {
    const fixtureDir = new URL('../fixtures/latex/multifile/', import.meta.url);
    const mainTexPath = fileURLToPath(new URL('main.tex', fixtureDir));
    const missingTexPath = path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}.tex`);

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence fail-fast', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      latex_sources: [{ main_tex_path: mainTexPath }, { main_tex_path: missingTexPath }],
    });
    expect(buildRes.isError).toBe(true);

    const statusUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_evidence_source_status.json')}`;
    const status = JSON.parse(String((readHepResource(statusUri) as any).text)) as {
      sources: Array<{ source_kind: string; status: string }>;
      summary: { succeeded: number; failed: number };
    };
    expect(status.sources.filter(s => s.source_kind === 'latex').length).toBe(2);
    expect(status.summary.succeeded).toBe(1);
    expect(status.summary.failed).toBe(1);

    const manifest = JSON.parse(String((readHepResource(`hep://runs/${encodeURIComponent(run.run_id)}/manifest`) as any).text)) as {
      steps?: Array<{ step: string; artifacts?: Array<{ name: string }> }>;
    };
    const writingStep = manifest.steps?.find(s => s.step === 'writing_evidence_enrichment');
    expect(writingStep?.artifacts?.some(a => a.name === 'writing_evidence_source_status.json')).toBe(true);
  });

  it('continue_on_error=true still fails when all sources fail, but writes status artifact for diagnosis', async () => {
    const missingTexPath = path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}.tex`);

    const projectRes = await handleToolCall('hep_project_create', { name: 'writing evidence all-fail', description: 'semantic-query' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const buildRes = await handleToolCall('hep_run_build_writing_evidence', {
      run_id: run.run_id,
      continue_on_error: true,
      latex_sources: [{ main_tex_path: missingTexPath }],
    });
    expect(buildRes.isError).toBe(true);

    const statusUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_evidence_source_status.json')}`;
    const status = JSON.parse(String((readHepResource(statusUri) as any).text)) as {
      summary: { succeeded: number; failed: number; skipped: number };
    };
    expect(status.summary.succeeded).toBe(0);
    expect(status.summary.failed).toBe(1);
    expect(status.summary.skipped).toBe(0);

    const manifest = JSON.parse(String((readHepResource(`hep://runs/${encodeURIComponent(run.run_id)}/manifest`) as any).text)) as {
      steps?: Array<{ step: string; artifacts?: Array<{ name: string }> }>;
    };
    const writingStep = manifest.steps?.find(s => s.step === 'writing_evidence_enrichment');
    expect(writingStep?.artifacts?.some(a => a.name === 'writing_evidence_source_status.json')).toBe(true);
  });
});
