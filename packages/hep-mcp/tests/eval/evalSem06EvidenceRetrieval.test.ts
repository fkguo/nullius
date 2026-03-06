import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { EvalResult } from '../../src/eval/index.js';
import {
  absoluteDelta,
  compareWithBaseline,
  fallbackRate,
  loadBaseline,
  mrrAtK,
  percentile,
  precisionAtK,
  recallAtK,
  relativeGain,
  runEvalSet,
  saveBaseline,
} from '../../src/eval/index.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

type Sem06Input = { query: string };
type Sem06Expected = { relevant_phrases: string[] };

type Sem06Actual = {
  rank: number | null;
  usedFallback: boolean;
  hasGoldMarkerAt10: boolean;
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

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractHits(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  const directHits = value.hits;
  if (Array.isArray(directHits)) return directHits.filter(isRecord);
  const result = value.result;
  if (!isRecord(result)) return [];
  const nestedHits = result.hits;
  if (!Array.isArray(nestedHits)) return [];
  return nestedHits.filter(isRecord);
}

function hitTextPreview(hit: Record<string, unknown>): string {
  return toString(hit.text_preview).replace(/\\_/g, '_');
}

function firstRankByPhrases(phrases: string[], hits: Array<Record<string, unknown>>): number | null {
  if (phrases.length === 0) return null;
  for (let i = 0; i < hits.length; i += 1) {
    const preview = hitTextPreview(hits[i]!);
    if (!preview) continue;
    if (phrases.some(p => preview.includes(p))) return i + 1;
  }
  return null;
}

function hasGoldMarkerAt10(hits: Array<Record<string, unknown>>): boolean {
  for (const hit of hits.slice(0, 10)) {
    const preview = hitTextPreview(hit);
    if (preview.includes('GOLD')) return true;
  }
  return false;
}

function isPositiveCase(result: EvalResult<Sem06Actual>): boolean {
  const exp = result.expected as Sem06Expected;
  return Array.isArray(exp.relevant_phrases) && exp.relevant_phrases.length > 0;
}

function computeMetrics(
  results: Array<EvalResult<Sem06Actual>>,
  filter: (r: EvalResult<Sem06Actual>) => boolean,
): {
  precision_at_5: number;
  precision_at_10: number;
  recall_at_5: number;
  recall_at_10: number;
  mrr_at_10: number;
  fallback_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  noise_gold_hit_rate_at_10: number;
} {
  const scoped = results.filter(filter);
  const evaluable = scoped.filter(r => r.actual !== null) as Array<EvalResult<Sem06Actual>>;

  const positives = evaluable.filter(isPositiveCase);
  const ranks = positives.map(r => {
    const rank = r.actual!.rank;
    return typeof rank === 'number' && rank >= 1 ? rank : null;
  });

  const negatives = evaluable.filter(r => !isPositiveCase(r));
  const noiseGoldHitRate =
    negatives.length === 0 ? 0 : negatives.filter(r => r.actual!.hasGoldMarkerAt10).length / negatives.length;

  const latency = evaluable.map(r => r.durationMs);
  const usedFallback = evaluable.map(r => ({ usedFallback: r.actual!.usedFallback }));

  return {
    precision_at_5: precisionAtK(ranks, 5),
    precision_at_10: precisionAtK(ranks, 10),
    recall_at_5: recallAtK(ranks, 5),
    recall_at_10: recallAtK(ranks, 10),
    mrr_at_10: mrrAtK(ranks, 10),
    fallback_rate: fallbackRate(usedFallback),
    latency_p50_ms: percentile(latency, 0.5),
    latency_p95_ms: percentile(latency, 0.95),
    noise_gold_hit_rate_at_10: noiseGoldHitRate,
  };
}

function buildSem06Latex(): string {
  const lines: string[] = [];
  lines.push('\\documentclass{article}');
  lines.push('\\title{Synthetic SEM-06 Evidence Retrieval Fixture}');
  lines.push('\\begin{document}');
  lines.push('\\maketitle');
  lines.push('');

  // Negative/OOD noise decoys: match queries exactly but do NOT contain GOLD markers.
  for (let i = 1; i <= 12; i += 1) {
    const id = pad3(i);
    for (let d = 1; d <= 12; d += 1) {
      lines.push(`Noise decoy ${d} for noise\\_${id}: noise\\_${id} effective coupling. Irrelevant evidence chunk.`);
      lines.push('');
    }
  }

  // Topics include many lexical-only decoys (substring matches) placed before the gold paragraph.
  for (let i = 1; i <= 56; i += 1) {
    const id = pad3(i);
    lines.push(`\\section{Topic ${id}}`);
    lines.push('');
    for (let d = 1; d <= 12; d += 1) {
      lines.push(
        `DECOY ${d} for topic\\_${id}: topic\\_${id}x ineffective coupling (substring trap for lexical scoring).`,
      );
      lines.push('');
    }
    lines.push(`GOLD\\_${id} topic\\_${id} effective coupling. This is the relevant evidence for topic\\_${id}.`);
    lines.push('');
  }

  lines.push('\\end{document}');
  lines.push('');
  return lines.join('\n');
}

describe('eval: SEM-06 evidence retrieval upgrade (local-only)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('improves P/R/MRR vs lexical baseline with semantic-first + rerank', async () => {
    const evalSet = readEvalSetFixture('sem06_evidence_retrieval_eval.json');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-tex-'));
    try {
      const texPath = path.join(tmp, 'main.tex');
      fs.writeFileSync(texPath, buildSem06Latex(), 'utf-8');

      const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-sem06' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

      await handleToolCall('hep_project_build_evidence', {
        project_id: project.project_id,
        identifier: 'paper_sem06',
        main_tex_path: texPath,
        include_inline_math: true,
        max_paragraph_length: 0,
      });

      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      await handleToolCall('hep_run_build_writing_evidence', {
        run_id: run.run_id,
        continue_on_error: false,
        latex_sources: [{ identifier: 'paper_sem06', main_tex_path: texPath }],
        max_evidence_items: 2000,
        embedding_dim: 256,
      });

      const baseline = await runEvalSet<Sem06Input, Sem06Actual>(evalSet, {
        run: async (input, evalCase) => {
          const res = await handleToolCall('hep_project_query_evidence', {
            project_id: project.project_id,
            query: input.query,
            limit: 10,
          });
          const payload = JSON.parse(res.content[0].text) as unknown;
          const hits = extractHits(payload);
          const phrases = (evalCase.expected as Sem06Expected)?.relevant_phrases ?? [];
          return {
            rank: firstRankByPhrases(phrases, hits),
            usedFallback: false,
            hasGoldMarkerAt10: hasGoldMarkerAt10(hits),
          };
        },
        judge: (expected, actual) => {
          const exp = expected as Sem06Expected;
          const positive = Array.isArray(exp.relevant_phrases) && exp.relevant_phrases.length > 0;
          const ok = positive ? actual.rank !== null && actual.rank <= 10 : !actual.hasGoldMarkerAt10;
          return { passed: ok, metrics: { passed: ok ? 1 : 0 } };
        },
        aggregate: results => {
          const overall = computeMetrics(results, () => true);
          const longTail = computeMetrics(results, r => r.tags.includes('long_tail'));
          const ood = computeMetrics(results, r => r.tags.includes('ood'));
          return {
            precision_at_5_overall: overall.precision_at_5,
            precision_at_10_overall: overall.precision_at_10,
            recall_at_5_overall: overall.recall_at_5,
            recall_at_10_overall: overall.recall_at_10,
            mrr_at_10_overall: overall.mrr_at_10,
            fallback_rate_overall: overall.fallback_rate,
            latency_p50_ms_overall: overall.latency_p50_ms,
            latency_p95_ms_overall: overall.latency_p95_ms,
            noise_gold_hit_rate_at_10_overall: overall.noise_gold_hit_rate_at_10,
            recall_at_10_long_tail: longTail.recall_at_10,
            mrr_at_10_long_tail: longTail.mrr_at_10,
            recall_at_10_ood: ood.recall_at_10,
            mrr_at_10_ood: ood.mrr_at_10,
          };
        },
      });

      const improved = await runEvalSet<Sem06Input, Sem06Actual>(evalSet, {
        run: async (input, evalCase) => {
          const res = await handleToolCall('hep_project_query_evidence', {
            project_id: project.project_id,
            query: input.query,
            mode: 'semantic',
            run_id: run.run_id,
            limit: 10,
            include_explanation: false,
          });
          const payload = JSON.parse(res.content[0].text) as { artifacts?: Array<{ uri?: string }> };
          const artifactUri = payload.artifacts?.[0]?.uri;
          if (!artifactUri) {
            return { rank: null, usedFallback: true, hasGoldMarkerAt10: false };
          }
          const artifactText = readResourceText(artifactUri);
          const artifact = JSON.parse(artifactText) as unknown;
          const hits = extractHits(artifact);
          const exp = (evalCase.expected as Sem06Expected)?.relevant_phrases ?? [];
          const usedFallback = isRecord(artifact) && isRecord(artifact.fallback) && artifact.fallback.used === true;
          return {
            rank: firstRankByPhrases(exp, hits),
            usedFallback,
            hasGoldMarkerAt10: hasGoldMarkerAt10(hits),
          };
        },
        judge: (expected, actual) => {
          const exp = expected as Sem06Expected;
          const positive = Array.isArray(exp.relevant_phrases) && exp.relevant_phrases.length > 0;
          const ok = positive ? actual.rank !== null && actual.rank <= 10 : !actual.hasGoldMarkerAt10;
          return { passed: ok, metrics: { passed: ok ? 1 : 0 } };
        },
        aggregate: results => {
          const overall = computeMetrics(results, () => true);
          const longTail = computeMetrics(results, r => r.tags.includes('long_tail'));
          const ood = computeMetrics(results, r => r.tags.includes('ood'));
          return {
            precision_at_5_overall: overall.precision_at_5,
            precision_at_10_overall: overall.precision_at_10,
            recall_at_5_overall: overall.recall_at_5,
            recall_at_10_overall: overall.recall_at_10,
            mrr_at_10_overall: overall.mrr_at_10,
            fallback_rate_overall: overall.fallback_rate,
            latency_p50_ms_overall: overall.latency_p50_ms,
            latency_p95_ms_overall: overall.latency_p95_ms,
            noise_gold_hit_rate_at_10_overall: overall.noise_gold_hit_rate_at_10,
            recall_at_10_long_tail: longTail.recall_at_10,
            mrr_at_10_long_tail: longTail.mrr_at_10,
            recall_at_10_ood: ood.recall_at_10,
            mrr_at_10_ood: ood.mrr_at_10,
          };
        },
      });

      // Targets (SEM-06): absolute thresholds + relative improvement.
      const baselineRecall10 = baseline.aggregateMetrics.recall_at_10_overall ?? 0;
      const baselineMrr10 = baseline.aggregateMetrics.mrr_at_10_overall ?? 0;
      const improvedRecall10 = improved.aggregateMetrics.recall_at_10_overall ?? 0;
      const improvedMrr10 = improved.aggregateMetrics.mrr_at_10_overall ?? 0;

      expect(improvedRecall10).toBeGreaterThanOrEqual(0.85);
      expect(improvedMrr10).toBeGreaterThanOrEqual(0.6);

      expect(improved.aggregateMetrics.fallback_rate_overall ?? 1).toBeLessThanOrEqual(0.2);
      expect(improved.aggregateMetrics.latency_p95_ms_overall ?? 1e9).toBeLessThanOrEqual(500);
      expect(improved.aggregateMetrics.noise_gold_hit_rate_at_10_overall ?? 1).toBeLessThanOrEqual(0.1);

      const recallImprovement = absoluteDelta(improvedRecall10, baselineRecall10);
      const mrrImprovement = absoluteDelta(improvedMrr10, baselineMrr10);
      expect(recallImprovement).toBeGreaterThanOrEqual(Math.max(0.3, Math.abs(baselineRecall10) * 0.3));
      expect(mrrImprovement).toBeGreaterThanOrEqual(Math.max(0.2, Math.abs(baselineMrr10) * 0.3));
      expect(relativeGain(improvedRecall10, baselineRecall10)).toBeGreaterThanOrEqual(0.3);
      expect(relativeGain(improvedMrr10, baselineMrr10)).toBeGreaterThanOrEqual(0.3);

      if (process.env.EVAL_UPDATE_BASELINES === '1') {
        saveBaseline(improved, BASELINES_DIR);
      }
      const saved = loadBaseline(evalSet.name, BASELINES_DIR);
      const comparison = compareWithBaseline(improved, saved);
      expect(comparison.isFirstRun).toBe(false);
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;

  holdoutIt('holdout set (run only at final gate)', async () => {
    const evalSet = readEvalSetFixture('sem06_evidence_retrieval_holdout.json');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-tex-'));
    try {
      const texPath = path.join(tmp, 'main.tex');
      fs.writeFileSync(texPath, buildSem06Latex(), 'utf-8');

      const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-sem06-holdout' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

      await handleToolCall('hep_project_build_evidence', {
        project_id: project.project_id,
        identifier: 'paper_sem06',
        main_tex_path: texPath,
        include_inline_math: true,
        max_paragraph_length: 0,
      });

      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      await handleToolCall('hep_run_build_writing_evidence', {
        run_id: run.run_id,
        continue_on_error: false,
        latex_sources: [{ identifier: 'paper_sem06', main_tex_path: texPath }],
        max_evidence_items: 2000,
        embedding_dim: 256,
      });

      const report = await runEvalSet<Sem06Input, Sem06Actual>(evalSet, {
        run: async (input, evalCase) => {
          const res = await handleToolCall('hep_project_query_evidence', {
            project_id: project.project_id,
            query: input.query,
            mode: 'semantic',
            run_id: run.run_id,
            limit: 10,
          });
          const payload = JSON.parse(res.content[0].text) as { artifacts?: Array<{ uri?: string }> };
          const artifactUri = payload.artifacts?.[0]?.uri;
          if (!artifactUri) return { rank: null, usedFallback: true, hasGoldMarkerAt10: false };
          const artifactText = readResourceText(artifactUri);
          const artifact = JSON.parse(artifactText) as unknown;
          const hits = extractHits(artifact);
          const exp = (evalCase.expected as Sem06Expected)?.relevant_phrases ?? [];
          const usedFallback = isRecord(artifact) && isRecord(artifact.fallback) && artifact.fallback.used === true;
          return {
            rank: firstRankByPhrases(exp, hits),
            usedFallback,
            hasGoldMarkerAt10: hasGoldMarkerAt10(hits),
          };
        },
        judge: (expected, actual) => {
          const exp = expected as Sem06Expected;
          const positive = Array.isArray(exp.relevant_phrases) && exp.relevant_phrases.length > 0;
          const ok = positive ? actual.rank !== null && actual.rank <= 10 : !actual.hasGoldMarkerAt10;
          return { passed: ok, metrics: { passed: ok ? 1 : 0 } };
        },
        aggregate: results => {
          const overall = computeMetrics(results, () => true);
          return {
            recall_at_10_overall: overall.recall_at_10,
            mrr_at_10_overall: overall.mrr_at_10,
            fallback_rate_overall: overall.fallback_rate,
            noise_gold_hit_rate_at_10_overall: overall.noise_gold_hit_rate_at_10,
          };
        },
      });

      expect(report.summary.total).toBeGreaterThan(0);
      expect(report.aggregateMetrics.recall_at_10_overall ?? 0).toBeGreaterThan(0.5);
      expect(report.aggregateMetrics.noise_gold_hit_rate_at_10_overall ?? 1).toBeLessThanOrEqual(0.25);
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
