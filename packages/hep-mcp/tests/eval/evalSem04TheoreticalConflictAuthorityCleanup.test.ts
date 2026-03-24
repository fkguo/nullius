import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runEvalSet, type EvalResult } from '../../src/eval/index.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { readEvalSetFixture } from './evalSnapshots.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { handleToolCall } = await import('../../src/tools/index.js');

type MockPaper = {
  recid: string;
  title: string;
  year: number;
  abstract: string;
};

type Sem04Input = {
  subject_entity: string;
  inputs?: Array<'title' | 'abstract'>;
  papers: MockPaper[];
  sampling_response: Record<string, unknown>;
};

type Sem04Actual = {
  candidate_count: number;
  relation: string | null;
  decision_status: string | null;
  reason_code: string | null;
};

function readTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find(item => item.type === 'text' && typeof item.text === 'string');
  if (!block?.text) throw new Error('missing text content block');
  return block.text;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

describe('eval: sem04 theoretical conflict authority cleanup', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createRun(): Promise<string> {
    const projectRes = await handleToolCall('hep_project_create', { name: 'SEM04 Eval Project', description: 'Local-only' });
    const projectPayload = JSON.parse(readTextBlock(projectRes)) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: projectPayload.project_id, args_snapshot: { eval: 'sem04' } });
    return (JSON.parse(readTextBlock(runRes)) as { run_id: string }).run_id;
  }

  async function runCase(input: Sem04Input): Promise<Sem04Actual> {
    vi.mocked(api.getPaper).mockImplementation(async (recid: string) => {
      const paper = input.papers.find(candidate => candidate.recid === recid);
      if (!paper) throw new Error(`missing recid mock: ${recid}`);
      return paper as never;
    });

    const run_id = await createRun();
    const res = await handleToolCall('inspire_theoretical_conflicts', {
      run_id,
      recids: input.papers.map(paper => paper.recid),
      subject_entity: input.subject_entity,
      inputs: input.inputs,
      prompt_version: 'v2',
      max_candidates_total: 10,
      max_llm_requests: 10,
    }, 'standard', {
      createMessage: vi.fn().mockResolvedValue({
        model: 'eval-sampling-model',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(input.sampling_response) }],
      }),
    });

    expect(res.isError).toBeFalsy();

    const candidates = readJsonl<{ candidate_provenance: { retrieval_strategy: string } }>(
      getRunArtifactPath(run_id, 'theoretical_conflict_candidates.jsonl'),
    );
    const conflicts = readJson<{
      conflicts: Array<{
        relation: string;
        provenance?: { decision_status?: string; reason_code?: string };
      }>;
    }>(getRunArtifactPath(run_id, 'theoretical_conflicts_v1.json'));
    const firstEdge = conflicts.conflicts[0];

    return {
      candidate_count: candidates.filter(candidate => candidate.candidate_provenance.retrieval_strategy === 'semantic_similarity').length,
      relation: firstEdge?.relation ?? null,
      decision_status: firstEdge?.provenance?.decision_status ?? null,
      reason_code: firstEdge?.provenance?.reason_code ?? null,
    };
  }

  function aggregate(results: Array<EvalResult<Sem04Actual>>): Record<string, number> {
    const hardCases = results.filter(result => result.tags.includes('hard_case'));
    const holdoutCases = results.filter(result => result.tags.includes('holdout'));
    return {
      pass_rate: results.length === 0 ? 0 : results.filter(result => result.passed).length / results.length,
      hard_case_pass_rate: hardCases.length === 0 ? 0 : hardCases.filter(result => result.passed).length / hardCases.length,
      holdout_pass_rate: holdoutCases.length === 0 ? 0 : holdoutCases.filter(result => result.passed).length / holdoutCases.length,
    };
  }

  it('removes retrieval-prior authority and keeps only internal-sampling adjudications', async () => {
    const evalSet = readEvalSetFixture('sem04/sem04_theoretical_conflict_authority_eval.json');
    const report = await runEvalSet<Sem04Input, Sem04Actual>(evalSet, {
      run: runCase,
      judge: (expected, actual) => {
        const exp = expected as Record<string, unknown>;
        const pass = actual.candidate_count >= Number(exp.min_candidates ?? 1)
          && actual.relation === exp.relation
          && actual.decision_status === exp.decision_status
          && actual.reason_code === exp.reason_code;
        return { passed: pass, metrics: { passed: pass ? 1 : 0 } };
      },
      aggregate,
    });

    expect(report.summary.passRate).toBe(1);
    expect(report.aggregateMetrics.hard_case_pass_rate).toBe(1);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt('preserves abstained holdout behavior under internal sampling only', async () => {
    const evalSet = readEvalSetFixture('sem04/sem04_theoretical_conflict_authority_holdout.json');
    const report = await runEvalSet<Sem04Input, Sem04Actual>(evalSet, {
      run: runCase,
      judge: (expected, actual) => {
        const exp = expected as Record<string, unknown>;
        const pass = actual.candidate_count >= Number(exp.min_candidates ?? 1)
          && actual.relation === exp.relation
          && actual.decision_status === exp.decision_status
          && actual.reason_code === exp.reason_code;
        return { passed: pass, metrics: { passed: pass ? 1 : 0 } };
      },
      aggregate,
    });

    expect(report.summary.passRate).toBe(1);
    expect(report.aggregateMetrics.holdout_pass_rate).toBe(1);
  });
});
