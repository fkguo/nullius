import { describe, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { readEvalFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');
const { readHepResource } = await import('../../src/vnext/resources.js');

type RetrievalFixture = {
  name: string;
  cases: Array<{ query: string; expected_evidence_ids: string[] }>;
};

function computeRecallAtK(ranks: Array<number | null>, k: number): number {
  if (ranks.length === 0) return 0;
  const hit = ranks.filter(r => r !== null && r <= k).length;
  return hit / ranks.length;
}

function computeMrrAtK(ranks: Array<number | null>, k: number): number {
  if (ranks.length === 0) return 0;
  let sum = 0;
  for (const r of ranks) {
    if (r === null || r > k) continue;
    sum += 1 / r;
  }
  return sum / ranks.length;
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
    const fixture = readEvalFixture<RetrievalFixture>('retrieval_cases.json');

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

      const ranks: Array<number | null> = [];
      const explanationAvailable: boolean[] = [];

      for (const c of fixture.cases) {
        const res = await handleToolCall('hep_project_query_evidence_semantic', {
          run_id: run.run_id,
          project_id: project.project_id,
          query: c.query,
          limit: 10,
          include_explanation: true,
        });

        const payload = JSON.parse(res.content[0].text) as { artifacts: Array<{ name: string; uri: string }> };
        const artifactUri = payload.artifacts[0]?.uri;
        if (!artifactUri) {
          ranks.push(null);
          explanationAvailable.push(false);
          continue;
        }

        const artifactText = (readHepResource(artifactUri) as any).text as string;
        const artifact = JSON.parse(artifactText) as any;
        const ids: string[] = Array.isArray(artifact?.evidence_ids) ? artifact.evidence_ids : [];

        const expected = Array.isArray(c.expected_evidence_ids) ? c.expected_evidence_ids : [];
        const firstExpected = expected[0];
        const rank0 = firstExpected ? ids.indexOf(firstExpected) : -1;
        ranks.push(rank0 >= 0 ? rank0 + 1 : null);

        const hits = Array.isArray(artifact?.result?.hits) ? artifact.result.hits : [];
        const top = hits[0];
        explanationAvailable.push(Boolean(Array.isArray(top?.matched_tokens) && top.matched_tokens.length > 0));
      }

      const recallAt10 = computeRecallAtK(ranks, 10);
      const mrrAt10 = computeMrrAtK(ranks, 10);

      // Baseline comparison is warning-only (non-blocking).
      const here = path.dirname(fileURLToPath(import.meta.url));
      const baselinePath = path.join(here, 'snapshots', 'retrieval_baseline.json');
      const update = process.env.EVAL_UPDATE_SNAPSHOTS === '1';

      const baselinePayload = {
        version: 1,
        generated_at: new Date().toISOString(),
        fixture: fixture.name,
        cases: fixture.cases.length,
        recall_at_10: recallAt10,
        mrr_at_10: mrrAt10,
      };

      if (update) {
        fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
        fs.writeFileSync(baselinePath, `${JSON.stringify(baselinePayload, null, 2)}\n`, 'utf-8');
        return;
      }

      if (!fs.existsSync(baselinePath)) {
        throw new Error(`Missing retrieval baseline: ${baselinePath}. Run 'pnpm -r test:eval:update'.`);
      }

      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as any;
      const baseRecall = Number(baseline?.recall_at_10 ?? NaN);
      const baseMrr = Number(baseline?.mrr_at_10 ?? NaN);

      const warnDrop = (label: string, base: number, current: number) => {
        if (!Number.isFinite(base) || !Number.isFinite(current)) return;
        const drop = base - current;
        if (drop <= 0.05) return;
        // eslint-disable-next-line no-console
        console.warn(`[evalRetrieval] ${label} dropped >5%: baseline=${base.toFixed(3)} current=${current.toFixed(3)}`);
      };

      warnDrop('recall@10', baseRecall, recallAt10);
      warnDrop('MRR@10', baseMrr, mrrAt10);

      // Explanation is expected to be available for top hits in this synthetic fixture.
      if (explanationAvailable.some(v => v === false)) {
        // eslint-disable-next-line no-console
        console.warn('[evalRetrieval] explanation missing for at least one query (matched_tokens empty)');
      }
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
