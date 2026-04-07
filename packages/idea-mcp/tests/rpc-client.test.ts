import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IdeaRpcClient } from '../src/rpc-client.js';

function initParams(campaignName: string, maxSteps = 5) {
  return {
    budget: {
      max_cost_usd: 100,
      max_steps: maxSteps,
      max_tokens: 10_000,
      max_wall_clock_s: 3600,
    },
    charter: {
      approval_gate_ref: 'gate://idea.ts-only',
      campaign_name: campaignName,
      domain: 'hep-ph',
      scope: 'idea-mcp ts-only regression',
    },
    idempotency_key: `${campaignName}-init`,
    seed_pack: {
      seeds: [{ content: 'seed-a', seed_type: 'text' }],
    },
  };
}

function createClient(prefix: string): { client: IdeaRpcClient; rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  return {
    client: new IdeaRpcClient({ rootDir }),
    rootDir,
  };
}

describe('IdeaRpcClient', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without an explicit rootDir', () => {
    expect(() => new IdeaRpcClient({})).toThrow(
      'IdeaRpcClient requires explicit rootDir; repo-local defaults are forbidden',
    );
  });

  it('uses the in-process TS idea-engine host for campaign.init', async () => {
    const { client, rootDir } = createClient('idea-mcp-ts-only-');
    tempDirs.push(rootDir);

    try {
      const initResult = await client.call(
        'campaign.init',
        initParams('ts-only-default-host'),
      ) as Record<string, unknown>;

      expect(typeof initResult.campaign_id).toBe('string');
      expect(initResult.status).toBe('running');
    } finally {
      client.close();
    }
  });

  it('maps unsupported lifecycle methods to INTERNAL_ERROR with JSON-RPC context', async () => {
    const { client, rootDir } = createClient('idea-mcp-ts-method-');
    tempDirs.push(rootDir);

    try {
      const initResult = await client.call(
        'campaign.init',
        initParams('ts-method-not-found'),
      ) as Record<string, unknown>;

      await expect(client.call('campaign.pause', {
        campaign_id: initResult.campaign_id,
        idempotency_key: 'pause-1',
      })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        retryable: false,
        data: {
          reason: 'method_not_found',
          rpc: { code: -32601, message: 'method_not_found' },
        },
      });
    } finally {
      client.close();
    }
  });

  it('maps search.step budget_exhausted to INVALID_PARAMS', async () => {
    const { client, rootDir } = createClient('idea-mcp-ts-budget-');
    tempDirs.push(rootDir);

    try {
      const initResult = await client.call(
        'campaign.init',
        initParams('ts-budget-exhausted', 1),
      ) as Record<string, unknown>;

      await client.call('search.step', {
        campaign_id: initResult.campaign_id,
        idempotency_key: 'search-budget-first',
        n_steps: 5,
      });

      await expect(client.call('search.step', {
        campaign_id: initResult.campaign_id,
        idempotency_key: 'search-budget-second',
        n_steps: 1,
      })).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        retryable: false,
        data: {
          reason: 'dimension_exhausted',
          rpc: { code: -32001, message: 'budget_exhausted' },
        },
      });
    } finally {
      client.close();
    }
  });

  it('maps campaign_not_found to NOT_FOUND', async () => {
    const { client, rootDir } = createClient('idea-mcp-ts-status-');
    tempDirs.push(rootDir);
    const missingCampaignId = '11111111-1111-4111-8111-111111111111';

    try {
      await expect(client.call('campaign.status', { campaign_id: missingCampaignId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        retryable: false,
        data: {
          campaign_id: missingCampaignId,
          rpc: { code: -32003, message: 'campaign_not_found' },
        },
      });
    } finally {
      client.close();
    }
  });

  it('rejects calls after close', async () => {
    const { client, rootDir } = createClient('idea-mcp-ts-closed-');
    tempDirs.push(rootDir);
    client.close();

    await expect(client.call('campaign.init', initParams('closed-client'))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
  });
});
