import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { IdeaRpcClient } from '../src/rpc-client.js';

function initParams() {
  return {
    charter: {
      campaign_name: 'idea-mcp-roundtrip',
      domain: 'test-domain',
      scope: 'round-trip fixture for the campaign lifecycle bridge',
      approval_gate_ref: 'gate://a0.1',
    },
    seed_pack: {
      seeds: [
        { seed_type: 'text', content: 'seed-a' },
        { seed_type: 'text', content: 'seed-b' },
      ],
    },
    budget: {
      max_tokens: 100000,
      max_cost_usd: 100,
      max_wall_clock_s: 100000,
      max_steps: 20,
    },
    idempotency_key: 'init-roundtrip',
  };
}

describe('IdeaRpcClient integration', () => {
  let client: IdeaRpcClient | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
  });

  it('round-trips the TS idea-engine host for campaign lifecycle, posterior updates, and ranking', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'idea-mcp-engine-'));
    client = new IdeaRpcClient({
      rootDir: dataDir,
    });

    const initResult = await client.call('campaign.init', initParams()) as Record<string, unknown>;
    expect(initResult.status).toBe('running');
    expect(typeof initResult.campaign_id).toBe('string');

    const campaignId = initResult.campaign_id as string;
    const statusResult = await client.call('campaign.status', {
      campaign_id: campaignId,
    }) as Record<string, unknown>;
    expect(statusResult.status).toBe('running');
    expect(statusResult.node_count).toBe(2);

    const listResult = await client.call('node.list', {
      campaign_id: campaignId,
    }) as Record<string, unknown>;
    const nodeIds = (listResult.nodes as Array<Record<string, unknown>>).map(node => String(node.node_id));
    expect(nodeIds).toHaveLength(2);

    const posteriorResult = await client.call('node.set_posterior', {
      campaign_id: campaignId,
      node_id: nodeIds[0],
      idempotency_key: 'posterior-roundtrip',
      posterior: { value: 0.58, evidence_count: 3 },
      literature_coverage: {
        status: 'saturated',
        survey_ref: `project://artifacts/literature/${nodeIds[0]}-literature_survey_v1.json#sha256:${'a'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${nodeIds[0]}-close-prior-matrix.json#sha256:${'b'.repeat(64)}`,
      },
    }) as Record<string, unknown>;
    expect(((posteriorResult.node as Record<string, unknown>).posterior as Record<string, unknown>).value).toBe(0.58);

    const rankResult = await client.call('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-roundtrip',
      method: 'posterior',
    }) as Record<string, unknown>;
    const rankedNodes = rankResult.ranked_nodes as Array<Record<string, unknown>>;
    expect(rankedNodes).toHaveLength(1);
    expect(rankedNodes[0]!.node_id).toBe(nodeIds[0]);
    expect(rankedNodes[0]!.literature_coverage_status).toBe('saturated');
    expect(rankedNodes[0]!.allocation_eligible).toBe(true);
    expect(rankedNodes[0]!.exploratory_allocation).toBe(false);
    expect(rankResult.skipped_nodes).toEqual([
      { node_id: nodeIds[1], reason: 'no_posterior' },
    ]);

    const pauseResult = await client.call('campaign.pause', {
      campaign_id: campaignId,
      idempotency_key: 'pause-roundtrip',
    }) as Record<string, unknown>;
    expect((pauseResult.campaign_status as Record<string, unknown>).status).toBe('paused');

    const resumeResult = await client.call('campaign.resume', {
      campaign_id: campaignId,
      idempotency_key: 'resume-roundtrip',
    }) as Record<string, unknown>;
    expect((resumeResult.campaign_status as Record<string, unknown>).status).toBe('running');
  }, 120_000);
});
