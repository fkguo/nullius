import { describe, it } from 'vitest';

import { runEvalSet } from '../../src/eval/index.js';
import { readEvalSetFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');

type NetworkInput = { query: string; size: number; sort: string };

const itNetwork = process.env.EVAL_NETWORK === '1' ? it : it.skip;

describe('eval: network smoke (opt-in)', () => {
  itNetwork('runs a small INSPIRE search (no fixtures; sanity only)', async () => {
    const evalSet = readEvalSetFixture('e2e_network_eval_set.json');
    const report = await runEvalSet<NetworkInput, unknown>(evalSet, {
      run: async (input: NetworkInput) => {
        return handleToolCall('inspire_search', {
          query: input.query,
          size: input.size,
          sort: input.sort,
        });
      },
      judge: () => ({ passed: true, metrics: { success: 1 } }),
    });
    if (report.summary.failed > 0) {
      throw new Error(`Network eval failed with ${report.summary.failed} case(s).`);
    }
  });
});
