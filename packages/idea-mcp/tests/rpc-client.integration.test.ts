import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { IdeaRpcClient } from '../src/rpc-client.js';

const ideaCorePath = fileURLToPath(new URL('../../idea-core', import.meta.url));

function initParams() {
  return {
    charter: {
      campaign_name: 'idea-mcp-roundtrip',
      domain: 'hep-ph',
      scope: 'round-trip fixture for NEW-IDEA-01 retro closeout',
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

  it('round-trips the default idea-engine backend for campaign.init, campaign.status, search.step, and eval.run', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'idea-mcp-engine-'));
    client = new IdeaRpcClient({
      rootDir: dataDir,
      timeoutMs: 60_000,
    });

    const initResult = await client.call('campaign.init', initParams()) as Record<string, unknown>;
    expect(initResult.status).toBe('running');
    expect(typeof initResult.campaign_id).toBe('string');

    const campaignId = initResult.campaign_id as string;
    const statusResult = await client.call('campaign.status', {
      campaign_id: campaignId,
    }) as Record<string, unknown>;
    expect(statusResult.status).toBe('running');

    const stepResult = await client.call('search.step', {
      campaign_id: campaignId,
      n_steps: 1,
      idempotency_key: 'search-roundtrip',
    }) as Record<string, unknown>;
    const newNodeIds = stepResult.new_node_ids as string[];
    expect(stepResult.n_steps_executed).toBe(1);
    expect(newNodeIds.length).toBeGreaterThan(0);

    const evalResult = await client.call('eval.run', {
      campaign_id: campaignId,
      node_ids: [newNodeIds[0]],
      evaluator_config: { dimensions: ['novelty', 'impact'], n_reviewers: 2 },
      idempotency_key: 'eval-roundtrip',
    }) as Record<string, unknown>;
    expect(typeof evalResult.scorecards_artifact_ref).toBe('string');

    await expect(client.call('campaign.pause', {
      campaign_id: campaignId,
      idempotency_key: 'pause-roundtrip',
    })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      data: {
        reason: 'method_not_found',
        rpc: { code: -32601, message: 'method_not_found' },
      },
    });
  }, 120_000);

  it('keeps the Python idea-core path as explicit compatibility backend only', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'idea-mcp-'));
    client = new IdeaRpcClient({
      backend: 'idea-core-python',
      ideaCorePath,
      dataDir,
      timeoutMs: 60_000,
    });

    const initResult = await client.call('campaign.init', initParams()) as Record<string, unknown>;
    expect(initResult.status).toBe('running');
    expect(typeof initResult.campaign_id).toBe('string');

    const campaignId = initResult.campaign_id as string;
    const statusResult = await client.call('campaign.status', {
      campaign_id: campaignId,
    }) as Record<string, unknown>;
    expect(statusResult.status).toBe('running');

    const stepResult = await client.call('search.step', {
      campaign_id: campaignId,
      n_steps: 1,
      idempotency_key: 'search-roundtrip',
    }) as Record<string, unknown>;
    const newNodeIds = stepResult.new_node_ids as string[];
    expect(stepResult.n_steps_executed).toBe(1);
    expect(newNodeIds.length).toBeGreaterThan(0);

    const evalResult = await client.call('eval.run', {
      campaign_id: campaignId,
      node_ids: [newNodeIds[0]],
      evaluator_config: { dimensions: ['novelty', 'impact'], n_reviewers: 2 },
      idempotency_key: 'eval-roundtrip',
    }) as Record<string, unknown>;
    expect(typeof evalResult.scorecards_artifact_ref).toBe('string');

    await expect(client.call('campaign.pause', {
      campaign_id: campaignId,
      idempotency_key: 'pause-roundtrip',
    })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      data: {
        reason: 'method_not_implemented',
        rpc: { code: -32000, message: 'method_not_implemented' },
      },
    });
  }, 120_000);
});
