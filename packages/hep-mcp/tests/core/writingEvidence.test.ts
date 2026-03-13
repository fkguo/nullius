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

  it('builds LaTeX+PDF evidence artifacts and enables semantic query when embeddings exist', async () => {
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
      latex_sources: [{ main_tex_path: mainTexPath, include_cross_refs: true }],
      pdf_source: { pdf_path: pdfPath, mode: 'text', max_pages: 2, output_prefix: 'writing_evidence_pdf' },
    });
    expect(buildRes.isError).not.toBe(true);

    const buildPayload = JSON.parse(buildRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { latex_items: number; pdf_included: boolean; embedding_model: string };
    };
    expect(buildPayload.summary.latex_items).toBeGreaterThan(0);
    expect(buildPayload.summary.pdf_included).toBe(true);
    expect(buildPayload.summary.embedding_model).toContain('hashing_fnv1a32');

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

    const status = JSON.parse(String((readHepResource(statusUri!) as any).text)) as {
      version: number;
      sources: Array<{ source_kind: string; status: string }>;
      summary: { succeeded: number; failed: number };
    };
    expect(status.version).toBe(1);
    expect(status.sources.some(s => s.source_kind === 'latex' && s.status === 'success')).toBe(true);
    expect(status.sources.some(s => s.source_kind === 'pdf' && s.status === 'success')).toBe(true);
    expect(status.summary.succeeded).toBeGreaterThanOrEqual(2);
    expect(status.summary.failed).toBe(0);

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

    // With embeddings present, semantic query should be implemented=true (hashing embeddings).
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
    const queryArtifact = JSON.parse(String((readHepResource(queryUri!) as any).text)) as {
      result: { total_hits: number; hits: Array<{ text_preview: string }> };
    };
    expect(queryArtifact.result.total_hits).toBeGreaterThan(0);
    expect(queryArtifact.result.hits.some(h => h.text_preview.includes('Content from subfile'))).toBe(true);

    // Unified entrypoint semantic mode should succeed with same run embeddings.
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
    const unifiedArtifact = JSON.parse(String((readHepResource(unifiedQueryUri!) as any).text)) as {
      query: { include_explanation: boolean };
      result: { total_hits: number; hits: Array<{ text_preview: string; matched_tokens?: string[]; token_overlap_ratio?: number }> };
    };
    expect(unifiedArtifact.query.include_explanation).toBe(true);
    expect(unifiedArtifact.result.total_hits).toBeGreaterThan(0);
    expect(unifiedArtifact.result.hits.some(h => h.text_preview.includes('Content from subfile'))).toBe(true);
    expect(unifiedArtifact.result.hits.every(h => Array.isArray(h.matched_tokens))).toBe(true);
    expect(unifiedArtifact.result.hits.every(h => typeof h.token_overlap_ratio === 'number')).toBe(true);
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

  it('accepts computation followup bridge artifacts as a bridge-only writing evidence refresh source', async () => {
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

    const bridgeArtifactName = 'writing_followup_bridge_v1.json';
    fs.writeFileSync(
      path.join(runArtifactsDir, bridgeArtifactName),
      JSON.stringify({
        schema_version: 1,
        bridge_kind: 'writing',
        run_id: run.run_id,
        objective_title: 'Bridge-only refresh',
        feedback_signal: 'success',
        decision_kind: 'capture_finding',
        summary: 'Bridge seed should refresh writing evidence metadata without faking LaTeX evidence.',
        computation_result_uri: `rep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('artifacts/computation_result_v1.json')}`,
        manifest_ref: {
          uri: `rep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('computation/manifest.json')}`,
          sha256: 'a'.repeat(64),
        },
        produced_artifact_refs: [
          {
            uri: `rep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('artifacts/task_001.json')}`,
            sha256: sha256(outputContent),
          },
        ],
        target: {
          task_kind: 'draft_update',
          title: 'Update draft from bridge seed',
          target_node_id: 'draft-seed:run',
          suggested_content_type: 'section_output',
          seed_payload: {
            computation_result_uri: `rep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('artifacts/computation_result_v1.json')}`,
            manifest_uri: `rep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('computation/manifest.json')}`,
            summary: 'Bridge seed should refresh writing evidence metadata without faking LaTeX evidence.',
            produced_artifact_uris: [`rep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('artifacts/task_001.json')}`],
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
      bridge_artifact_names: [bridgeArtifactName],
    });
    expect(buildRes.isError).not.toBe(true);

    const payload = JSON.parse(buildRes.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { bridge_sources: number; latex_items: number };
    };
    expect(payload.summary.bridge_sources).toBe(1);
    expect(payload.summary.latex_items).toBe(0);

    const statusUri = payload.artifacts.find(a => a.name === 'writing_evidence_source_status.json')?.uri;
    const metaUri = payload.artifacts.find(a => a.name === 'writing_evidence_meta_v1.json')?.uri;
    expect(statusUri).toBeTruthy();
    expect(metaUri).toBeTruthy();

    const status = JSON.parse(String((readHepResource(statusUri!) as any).text)) as {
      sources: Array<{ source_kind: string; identifier: string; status: string }>;
      summary: { succeeded: number; failed: number };
    };
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0]).toMatchObject({
      source_kind: 'bridge',
      identifier: bridgeArtifactName,
      status: 'success',
    });
    expect(status.summary.succeeded).toBe(1);
    expect(status.summary.failed).toBe(0);

    const meta = JSON.parse(String((readHepResource(metaUri!) as any).text)) as {
      bridges: Array<{ artifact_name: string; bridge_kind: string; task_kind: string; produced_artifact_count: number }>;
      sources_summary: { succeeded: number };
    };
    expect(meta.sources_summary.succeeded).toBe(1);
    expect(meta.bridges).toHaveLength(1);
    expect(meta.bridges[0]).toMatchObject({
      artifact_name: bridgeArtifactName,
      bridge_kind: 'writing',
      task_kind: 'draft_update',
      produced_artifact_count: 1,
    });
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
