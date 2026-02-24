import { describe, it } from 'vitest';

const { handleToolCall } = await import('../../src/tools/index.js');

const itNetwork = process.env.EVAL_NETWORK === '1' ? it : it.skip;

describe('eval: network smoke (opt-in)', () => {
  itNetwork('runs a small INSPIRE search (no fixtures; sanity only)', async () => {
    await handleToolCall('inspire_search', { query: 't:exotic hadrons', size: 2, sort: 'mostcited' });
  });
});

