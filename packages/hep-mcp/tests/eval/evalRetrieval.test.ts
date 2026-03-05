import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compareWithBaseline,
  loadBaseline,
  mrrAtK,
  recallAtK,
  runEvalSet,
  saveBaseline,
  type EvalCase,
} from '../../src/eval/index.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/core/resources.js');

type RetrievalInput = { query: string };
type RetrievalExpected = { expected_evidence_ids: string[] };
type RetrievalActual = {
  evidenceIds: string[];
  explanationAvailable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') strings.push(item);
  }
  return strings;
}

function readResourceText(uri: string): string {
  const resource = readHepResource(uri);
  if (!('text' in resource)) {
    throw new Error(`Expected text resource: ${uri}`);
  }
  return resource.text;
}

function firstRank(evalCase: EvalCase, evidenceIds: string[]): number | null {
  const expected = evalCase.expected as RetrievalExpected;
  if (!Array.isArray(expected.expected_evidence_ids) || expected.expected_evidence_ids.length === 0) {
    return null;
  }
  const target = expected.expected_evidence_ids[0];
  const rank0 = target ? evidenceIds.indexOf(target) : -1;
  return rank0 >= 0 ? rank0 + 1 : null;
}

describe('eval: retrieval metrics + explanation (local-only)', () => {
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

  it('computes recall@10/MRR@10 and can emit retrieval explanations', async () => {
    const evalSet = readEvalSetFixture('retrieval_cases.json');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-tex-'));
    try {
      const texPath = path.join(tmp, 'main.tex');
      const tex = [
        '\\documentclass{article}',
        '\\title{Synthetic Retrieval Fixture}',
        '\\begin{document}',
        '\\maketitle',
        'We interpret X(3872) as a D*0 D0 molecular state near threshold.',
        '\\section{Tetraquark interpretation}',
        'We discuss a compact diquark-antidiquark tetraquark picture for X(3872).',
        '\\section{Hybrid charmonium scenario}',
        'We consider a hybrid charmonium interpretation with gluonic excitation.',
        '\\end{document}',
        '',
      ].join('\n');
      fs.writeFileSync(texPath, tex, 'utf-8');

      const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-retrieval' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      await handleToolCall('hep_run_build_writing_evidence', {
        run_id: run.run_id,
        continue_on_error: false,
        latex_sources: [{ identifier: 'paper_retrieval', main_tex_path: texPath }],
        max_evidence_items: 200,
        embedding_dim: 64,
      });

      const report = await runEvalSet<RetrievalInput, RetrievalActual>(evalSet, {
        run: async input => {
          const res = await handleToolCall('hep_project_query_evidence_semantic', {
            run_id: run.run_id,
            project_id: project.project_id,
            query: input.query,
            limit: 10,
            include_explanation: true,
          });

          const payload = JSON.parse(res.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
          const artifactUri = payload.artifacts[0]?.uri;
          if (!artifactUri) {
            return { evidenceIds: [], explanationAvailable: false };
          }
          const artifactText = readResourceText(artifactUri);
          const artifact = JSON.parse(artifactText) as unknown;
          const artifactObject = isRecord(artifact) ? artifact : {};
          const evidenceIds = toStringArray(artifactObject.evidence_ids);
          const resultObject = isRecord(artifactObject.result) ? artifactObject.result : {};
          const hits = Array.isArray(resultObject.hits) ? resultObject.hits : [];
          const top = hits[0];
          const explanationAvailable = isRecord(top) && Array.isArray(top.matched_tokens) && top.matched_tokens.length > 0;
          return { evidenceIds, explanationAvailable };
        },
        judge: (_expected, actual, evalCase) => {
          const rank = firstRank(evalCase, actual.evidenceIds);
          return {
            passed: rank !== null && rank <= 10,
            metrics: {
              rank: rank ?? -1,
              recall_at_10_case: rank !== null && rank <= 10 ? 1 : 0,
              mrr_at_10_case: rank !== null && rank <= 10 ? 1 / rank : 0,
              explanation_available: actual.explanationAvailable ? 1 : 0,
            },
          };
        },
        aggregate: results => {
          const ranks = results.map(result => {
            const rank = result.metrics.rank;
            return rank >= 1 ? rank : null;
          });
          const explanationRate =
            results.length === 0
              ? 0
              : results.reduce((sum, result) => sum + (result.metrics.explanation_available ?? 0), 0) /
                results.length;
          return {
            recall_at_10: recallAtK(ranks, 10),
            mrr_at_10: mrrAtK(ranks, 10),
            explanation_rate: explanationRate,
          };
        },
      });

      expect(report.summary.total).toBe(evalSet.cases.length);
      expect(report.aggregateMetrics.recall_at_10).toBeGreaterThan(0);

      const updateBaselines = process.env.EVAL_UPDATE_BASELINES === '1';
      if (updateBaselines) {
        saveBaseline(report, BASELINES_DIR);
      }

      const baseline = loadBaseline(evalSet.name, BASELINES_DIR);
      const comparison = compareWithBaseline(report, baseline);
      if (!comparison.isFirstRun) {
        const recallDelta = comparison.deltas.recall_at_10;
        if (recallDelta && recallDelta.delta < -0.05) {
          // eslint-disable-next-line no-console
          console.warn(
            `[evalRetrieval] recall@10 dropped >5%: baseline=${recallDelta.baseline.toFixed(3)} current=${recallDelta.current.toFixed(3)}`,
          );
        }
        const mrrDelta = comparison.deltas.mrr_at_10;
        if (mrrDelta && mrrDelta.delta < -0.05) {
          // eslint-disable-next-line no-console
          console.warn(
            `[evalRetrieval] MRR@10 dropped >5%: baseline=${mrrDelta.baseline.toFixed(3)} current=${mrrDelta.current.toFixed(3)}`,
          );
        }
      }
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
