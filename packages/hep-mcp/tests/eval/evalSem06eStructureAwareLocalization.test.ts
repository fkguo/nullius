import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { EvidenceType } from '@autoresearch/shared';

import { createProject } from '../../src/core/projects.js';
import { createRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { queryProjectEvidence } from '../../src/core/evidence.js';
import { queryProjectEvidenceSemantic } from '../../src/core/evidenceSemantic.js';
import { mapEvidenceTypeToLocalizationUnit } from '../../src/core/evidence-localization/localize.js';
import { buildRunWritingEvidence } from '../../src/core/writing/evidence.js';
import { compareWithBaseline, loadBaseline, runEvalSet, saveBaseline, type EvalResult } from '../../src/eval/index.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  augmentRunWithPdfSurface,
  buildSem06eLatex,
  extractActual,
  previewHasMarker,
  type Sem06eActual,
  type Sem06eExpected,
  type Sem06eInput,
} from './sem06eEvalSupport.js';

type Fixture = { projectId: string; runId: string; tmpDir: string };
type BaselineActual = { topUnit: string | null; topPreviewHasMarker: boolean };

function extractBaselineActual(payload: Record<string, unknown>, expected: Sem06eExpected): BaselineActual {
  const hits = Array.isArray(payload.hits) ? (payload.hits as Array<Record<string, unknown>>) : [];
  const top = hits[0] ?? null;
  const type = typeof top?.type === 'string' ? top.type : null;
  const preview = typeof top?.text_preview === 'string' ? top.text_preview : '';
  return {
    topUnit: type ? mapEvidenceTypeToLocalizationUnit(type as EvidenceType) : null,
    topPreviewHasMarker: previewHasMarker(preview, expected.marker),
  };
}

function aggregateImproved(results: Array<EvalResult<Sem06eActual>>): Record<string, number> {
  const actuals = results.filter(result => result.actual !== null) as Array<EvalResult<Sem06eActual>>;
  const tagged = (tag: string) => actuals.filter(result => result.tags.includes(tag));
  const exact = actuals.filter(result => result.actual!.topUnit === (result.expected as Sem06eExpected).top_unit && result.actual!.topPreviewHasMarker).length;
  const availability = actuals.filter(result => result.actual!.availability === (result.expected as Sem06eExpected).expected_status).length;
  const page = tagged('page').filter(result => result.actual!.topUnit === 'page' && result.actual!.topPreviewHasMarker).length;
  const structured = tagged('structured').filter(result => result.actual!.topUnit === (result.expected as Sem06eExpected).top_unit && result.actual!.topPreviewHasMarker).length;
  const easy = tagged('easy');
  const avgScans = actuals.reduce((sum, result) => sum + result.actual!.structureScans, 0) / Math.max(actuals.length, 1);
  return {
    exact_unit_hit_rate: exact / Math.max(actuals.length, 1),
    availability_match_rate: availability / Math.max(actuals.length, 1),
    page_hit_rate: page / Math.max(tagged('page').length, 1),
    structured_hit_rate: structured / Math.max(tagged('structured').length, 1),
    easy_pass_rate: easy.filter(result => result.passed).length / Math.max(easy.length, 1),
    avg_structure_scans: avgScans,
  };
}

function aggregateBaseline(results: Array<EvalResult<BaselineActual>>): Record<string, number> {
  const actuals = results.filter(result => result.actual !== null) as Array<EvalResult<BaselineActual>>;
  const page = actuals.filter(result => result.tags.includes('page') && result.actual!.topUnit === 'page' && result.actual!.topPreviewHasMarker).length;
  return { page_hit_rate: page / Math.max(actuals.filter(result => result.tags.includes('page')).length, 1) };
}

async function setupSemanticFixture(): Promise<Fixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-sem06e-tex-'));
  const texPath = path.join(tmp, 'main.tex');
  fs.writeFileSync(texPath, buildSem06eLatex(), 'utf-8');

  const project = createProject({ name: 'SEM06e Eval Project', description: 'eval-sem06e' });
  const { manifest } = createRun({ project_id: project.project_id });
  await buildRunWritingEvidence({
    run_id: manifest.run_id,
    continue_on_error: false,
    latex_sources: [{ identifier: 'paper_sem06e', main_tex_path: texPath, include_inline_math: true }],
    latex_types: ['paragraph', 'equation', 'figure', 'table', 'citation_context'],
    pdf_types: ['pdf_page', 'pdf_region'],
    max_evidence_items: 400,
    embedding_dim: 256,
    latex_catalog_artifact_name: 'latex_evidence_catalog.jsonl',
    latex_embeddings_artifact_name: 'latex_evidence_embeddings.jsonl',
    latex_enrichment_artifact_name: 'latex_evidence_enrichment.jsonl',
    pdf_embeddings_artifact_name: 'pdf_evidence_embeddings.jsonl',
    pdf_enrichment_artifact_name: 'pdf_evidence_enrichment.jsonl',
  });
  augmentRunWithPdfSurface(manifest.run_id);
  return { projectId: project.project_id, runId: manifest.run_id, tmpDir: tmp };
}

function readSemanticArtifact(runId: string, artifactName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getRunArtifactPath(runId, artifactName), 'utf-8')) as Record<string, unknown>;
}

describe('eval: SEM-06e structure-aware localization', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-sem06e-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('adds page localization and keeps exact structured units auditable', async () => {
    const evalSet = readEvalSetFixture('sem06e_structure_aware_localization_eval.json');
    const fixture = await setupSemanticFixture();
    try {
      const baseline = await runEvalSet<Sem06eInput, BaselineActual>(evalSet, {
        run: async (input, evalCase) => extractBaselineActual(
          await queryProjectEvidence({ project_id: fixture.projectId, query: input.query, limit: 10 }) as Record<string, unknown>,
          evalCase.expected as Sem06eExpected,
        ),
        judge: (expected, actual) => ({
          passed: actual.topUnit === (expected as Sem06eExpected).top_unit && actual.topPreviewHasMarker,
          metrics: { baseline_page_hit: actual.topUnit === 'page' && actual.topPreviewHasMarker ? 1 : 0 },
        }),
        aggregate: aggregateBaseline,
      });

      const improved = await runEvalSet<Sem06eInput, Sem06eActual>(evalSet, {
        run: async (input, evalCase) => {
          const res = await queryProjectEvidenceSemantic({
            run_id: fixture.runId,
            project_id: fixture.projectId,
            query: input.query,
            limit: 10,
            include_explanation: true,
          });
          const artifactName = res.artifacts[0]?.name;
          if (!artifactName) return { topUnit: null, topStatus: null, topPreviewHasMarker: false, availability: null, structureScans: 0 };
          return extractActual(readSemanticArtifact(fixture.runId, artifactName), evalCase.expected as Sem06eExpected);
        },
        judge: (expected, actual) => {
          const exp = expected as Sem06eExpected;
          const passed = actual.topUnit === exp.top_unit && actual.topStatus === exp.expected_status && actual.availability === exp.expected_status && actual.topPreviewHasMarker;
          return {
            passed,
            metrics: {
              exact_unit_hit: actual.topUnit === exp.top_unit && actual.topPreviewHasMarker ? 1 : 0,
              availability_match: actual.availability === exp.expected_status ? 1 : 0,
              structure_scans: actual.structureScans,
            },
          };
        },
        aggregate: aggregateImproved,
      });

      expect(improved.aggregateMetrics.page_hit_rate ?? 0).toBeGreaterThan(baseline.aggregateMetrics.page_hit_rate ?? 0);
      expect(improved.aggregateMetrics.exact_unit_hit_rate ?? 0).toBeGreaterThanOrEqual(0.95);
      expect(improved.aggregateMetrics.structured_hit_rate ?? 0).toBeGreaterThanOrEqual(1);
      expect(improved.aggregateMetrics.availability_match_rate ?? 0).toBeGreaterThanOrEqual(0.95);
      expect(improved.aggregateMetrics.easy_pass_rate ?? 0).toBeGreaterThanOrEqual(1);
      expect(improved.aggregateMetrics.avg_structure_scans ?? 0).toBeGreaterThanOrEqual(0);

      if (process.env.EVAL_UPDATE_BASELINES === '1') saveBaseline(improved, BASELINES_DIR);
      const saved = loadBaseline(evalSet.name, BASELINES_DIR);
      const comparison = compareWithBaseline(improved, saved);
      expect(comparison.isFirstRun).toBe(false);
    } finally {
      if (fs.existsSync(fixture.tmpDir)) fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt('holdout phrasing keeps page/table/citation localization stable', async () => {
    const evalSet = readEvalSetFixture('sem06e_structure_aware_localization_holdout.json');
    const fixture = await setupSemanticFixture();
    try {
      const report = await runEvalSet<Sem06eInput, Sem06eActual>(evalSet, {
        run: async (input, evalCase) => {
          const res = await queryProjectEvidenceSemantic({ run_id: fixture.runId, project_id: fixture.projectId, query: input.query, limit: 10 });
          const artifactName = res.artifacts[0]?.name;
          if (!artifactName) return { topUnit: null, topStatus: null, topPreviewHasMarker: false, availability: null, structureScans: 0 };
          return extractActual(readSemanticArtifact(fixture.runId, artifactName), evalCase.expected as Sem06eExpected);
        },
        judge: (expected, actual) => {
          const exp = expected as Sem06eExpected;
          const passed = actual.topUnit === exp.top_unit && actual.availability === exp.expected_status && actual.topPreviewHasMarker;
          return { passed, metrics: { passed: passed ? 1 : 0 } };
        },
        aggregate: aggregateImproved,
      });

      expect(report.summary.passRate).toBeGreaterThanOrEqual(0.95);
      expect(report.aggregateMetrics.page_hit_rate ?? 0).toBeGreaterThanOrEqual(1);
      expect(report.aggregateMetrics.exact_unit_hit_rate ?? 0).toBeGreaterThanOrEqual(0.95);
    } finally {
      if (fs.existsSync(fixture.tmpDir)) fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});
