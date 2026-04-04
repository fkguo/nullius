import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createProject } from '../../src/core/projects.js';
import { createRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { queryProjectEvidenceSemantic } from '../../src/core/evidenceSemantic.js';
import { buildRunWritingEvidence } from '../../src/core/writing/evidence.js';
import type { EvalResult } from '../../src/eval/index.js';
import {
  augmentRunWithSem06fPdfSurface,
  buildSem06fLatex,
  extractSem06fActual,
  type Sem06fActual,
  type Sem06fExpected,
  type Sem06fInput,
  type Sem06fScenario,
} from './sem06fEvalSupport.js';

export type FixtureBundle = {
  projectId: string;
  tmpDir: string;
  runs: Record<Sem06fScenario, string>;
};

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function setMultimodalEnv(disabled: boolean): () => void {
  const previous = process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL;
  if (disabled) process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL = '0';
  else delete process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL;
  return () => {
    if (previous !== undefined) process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL = previous;
    else delete process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL;
  };
}

export async function setupSem06fFixtures(): Promise<FixtureBundle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-sem06f-tex-'));
  const texPath = path.join(tmp, 'main.tex');
  fs.writeFileSync(texPath, buildSem06fLatex(), 'utf-8');

  const project = createProject({ name: 'SEM06f Eval Project', description: 'eval-sem06f' });
  const scenarios: Sem06fScenario[] = ['visual_enabled', 'visual_unavailable', 'visual_ambiguous'];
  const runs = {} as Record<Sem06fScenario, string>;

  for (const scenario of scenarios) {
    const { manifest } = createRun({ project_id: project.project_id });
    await buildRunWritingEvidence({
      run_id: manifest.run_id,
      continue_on_error: false,
      latex_sources: [{ identifier: `paper_sem06f_${scenario}`, main_tex_path: texPath, include_inline_math: true }],
      latex_types: ['paragraph', 'equation', 'figure', 'table', 'citation_context'],
      max_evidence_items: 400,
      embedding_dim: 256,
      latex_catalog_artifact_name: 'latex_evidence_catalog.jsonl',
      latex_embeddings_artifact_name: 'latex_evidence_embeddings.jsonl',
      latex_enrichment_artifact_name: 'latex_evidence_enrichment.jsonl',
    });
    augmentRunWithSem06fPdfSurface(manifest.run_id, scenario);
    runs[scenario] = manifest.run_id;
  }

  return { projectId: project.project_id, tmpDir: tmp, runs };
}

function readArtifact(runId: string, artifactName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getRunArtifactPath(runId, artifactName), 'utf-8')) as Record<string, unknown>;
}

export async function runSem06fCase(fixtures: FixtureBundle, input: Sem06fInput, expected: Sem06fExpected, disableAll: boolean): Promise<Sem06fActual> {
  const scenario = input.scenario ?? 'visual_enabled';
  const runId = fixtures.runs[scenario];
  const restore = setMultimodalEnv(disableAll || Boolean(input.disable_multimodal));
  try {
    const result = await queryProjectEvidenceSemantic({
      run_id: runId,
      project_id: fixtures.projectId,
      query: input.query,
      limit: 10,
      include_explanation: true,
    });
    const artifactName = result.artifacts[0]?.name;
    if (!artifactName) {
      return {
        topUnit: null,
        topStatus: null,
        topPreviewMatches: false,
        availability: null,
        multimodalStatus: null,
        visualCandidatesScanned: 0,
        supplementedCandidates: 0,
        boostedHits: 0,
      };
    }
    return extractSem06fActual(readArtifact(runId, artifactName), expected);
  } finally {
    restore();
  }
}

export function aggregateSem06fBaseline(results: Array<EvalResult<Sem06fActual>>): Record<string, number> {
  const actuals = results.filter(result => result.actual !== null) as Array<EvalResult<Sem06fActual>>;
  const pageNative = actuals.filter(result => result.tags.includes('page_native'));
  const text = actuals.filter(result => result.tags.includes('text'));
  return {
    page_native_hit_rate: pageNative.filter(result => result.actual!.topUnit === (result.expected as Sem06fExpected).top_unit && result.actual!.topPreviewMatches).length / Math.max(pageNative.length, 1),
    text_non_regression_rate: text.filter(result => result.actual!.topUnit === 'chunk' && result.actual!.topPreviewMatches).length / Math.max(text.length, 1),
  };
}

export function aggregateSem06fImproved(results: Array<EvalResult<Sem06fActual>>): Record<string, number> {
  const actuals = results.filter(result => result.actual !== null) as Array<EvalResult<Sem06fActual>>;
  const pageNative = actuals.filter(result => result.tags.includes('page_native'));
  const failures = actuals.filter(result => result.tags.includes('failure'));
  const text = actuals.filter(result => result.tags.includes('text'));
  return {
    page_native_hit_rate: pageNative.filter(result => result.passed).length / Math.max(pageNative.length, 1),
    failure_path_rate: failures.filter(result => result.passed).length / Math.max(failures.length, 1),
    text_non_regression_rate: text.filter(result => result.passed).length / Math.max(text.length, 1),
    applied_rate: pageNative.filter(result => result.actual!.multimodalStatus === 'applied').length / Math.max(pageNative.length, 1),
    avg_visual_candidates_scanned: average(actuals.map(result => result.actual!.visualCandidatesScanned)),
    avg_boosted_hits: average(actuals.map(result => result.actual!.boostedHits)),
    avg_supplemented_candidates: average(actuals.map(result => result.actual!.supplementedCandidates)),
  };
}
