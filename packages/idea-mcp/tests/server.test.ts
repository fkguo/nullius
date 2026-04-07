import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoLegacyIdeaEnv, createIdeaRpcClient, resolveIdeaDataDir } from '../src/server.js';

function initParams(campaignName: string) {
  return {
    budget: {
      max_cost_usd: 100,
      max_steps: 5,
      max_tokens: 10_000,
      max_wall_clock_s: 3600,
    },
    charter: {
      approval_gate_ref: 'gate://idea.server',
      campaign_name: campaignName,
      domain: 'hep-ph',
      scope: 'idea-mcp server wiring regression',
    },
    idempotency_key: `${campaignName}-init`,
    seed_pack: {
      seeds: [{ content: 'seed-a', seed_type: 'text' }],
    },
  };
}

describe('idea-mcp server configuration', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when IDEA_MCP_DATA_DIR is missing', () => {
    expect(() => resolveIdeaDataDir({})).toThrow(
      'idea-mcp requires IDEA_MCP_DATA_DIR; repo-local default data roots are forbidden',
    );
  });

  it('resolves explicit data dir overrides', () => {
    expect(resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: join(tmpdir(), 'idea-runs') })).toContain('/idea-runs');
  });

  it('rejects repo-local data dir overrides', () => {
    expect(() => resolveIdeaDataDir({ IDEA_MCP_DATA_DIR: 'packages/idea-engine/runs' })).toThrow(
      'idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:',
    );
    expect(() => resolveIdeaDataDir({
      IDEA_MCP_DATA_DIR: resolve(import.meta.dirname, '../../idea-engine/runs'),
    })).toThrow('idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo:');
  });

  it('fails closed when legacy backend envs are present', () => {
    expect(() => assertNoLegacyIdeaEnv({ IDEA_MCP_BACKEND: 'idea-engine' })).toThrow(
      'idea-mcp no longer supports legacy backend envs: IDEA_MCP_BACKEND; TS idea-engine is the only host authority',
    );
    expect(() => assertNoLegacyIdeaEnv({ IDEA_CORE_PATH: '/tmp/idea-core' })).toThrow(
      'idea-mcp no longer supports legacy backend envs: IDEA_CORE_PATH; TS idea-engine is the only host authority',
    );
    expect(() => createIdeaRpcClient({ IDEA_MCP_BACKEND: 'idea-engine' })).toThrow(
      'idea-mcp no longer supports legacy backend envs: IDEA_MCP_BACKEND; TS idea-engine is the only host authority',
    );
  });

  it('wires createIdeaRpcClient through the configured data dir', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-mcp-server-'));
    tempDirs.push(rootDir);
    const client = createIdeaRpcClient({ IDEA_MCP_DATA_DIR: rootDir });

    try {
      const initResult = await client.call('campaign.init', initParams('server-entrypoint')) as Record<string, unknown>;
      expect(typeof initResult.campaign_id).toBe('string');
      expect(initResult.status).toBe('running');
    } finally {
      client.close();
    }
  });
});
