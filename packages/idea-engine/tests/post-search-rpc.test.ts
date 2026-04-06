import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { RpcError } from '../src/service/errors.js';

function initCampaign(service: IdeaEngineRpcService): string {
  const result = service.handle('campaign.init', {
    budget: {
      max_cost_usd: 100.0,
      max_nodes: 100,
      max_steps: 100,
      max_tokens: 100_000,
      max_wall_clock_s: 100_000,
    },
    charter: {
      approval_gate_ref: 'gate://a0.1',
      campaign_name: 'post-search-rpc',
      domain: 'hep-ph',
      scope: 'post-search TS migration regression fixture',
    },
    idempotency_key: 'init-key',
    seed_pack: {
      seeds: [
        {
          content: 'seed-one',
          seed_type: 'text',
          source_uris: ['https://example.org/seed-1'],
        },
      ],
    },
  });
  return String(result.campaign_id);
}

function firstNodeId(service: IdeaEngineRpcService, campaignId: string): string {
  const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
  return Object.keys(nodes)[0]!;
}

describe('post-search RPC migration slice', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('handles eval.run, rank.compute, and node.promote through idea-engine', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service);
    const nodeId = firstNodeId(service, campaignId);

    const evalResult = service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['novelty', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-key',
      node_ids: [nodeId],
    });
    expect(evalResult.updated_node_ids).toEqual([nodeId]);
    expect(evalResult.node_revisions[nodeId]).toBeTypeOf('number');

    const replay = service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['novelty', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-key',
      node_ids: [nodeId],
    });
    expect(replay.scorecards_artifact_ref).toBe(evalResult.scorecards_artifact_ref);
    expect(replay.idempotency.is_replay).toBe(true);

    const rankResult = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-key',
      method: 'pareto',
    });
    expect(rankResult.ranked_nodes.length).toBeGreaterThanOrEqual(1);
    expect(rankResult.ranked_nodes[0].node_id).toBe(nodeId);

    const promoteResult = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-key',
      node_id: nodeId,
    });
    expect(promoteResult.node_id).toBe(nodeId);
    expect(promoteResult.has_reduction_report).toBe(false);
    expect(promoteResult.reduction_audit_summary).toBeNull();

    const handoff = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(promoteResult.handoff_artifact_ref),
    );
    expect(handoff.node_id).toBe(nodeId);
    expect(handoff.idea_card).toBeTruthy();
  });

  it('keeps rank.compute fail-closed when scorecards are unavailable', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-rank-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service);

    expect(() => service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-no-scorecards',
      method: 'pareto',
    })).toThrowError(RpcError);
    try {
      service.handle('rank.compute', {
        campaign_id: campaignId,
        idempotency_key: 'rank-no-scorecards',
        method: 'pareto',
      });
    } catch (error) {
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32013);
      expect(rpcError.data.reason).toBe('no_scorecards');
    }
  });

  it('keeps node.promote fail-closed on missing grounding pass', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-promote-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service);
    const nodeId = firstNodeId(service, campaignId);

    expect(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-grounding-fail',
      node_id: nodeId,
    })).toThrowError(RpcError);
    try {
      service.handle('node.promote', {
        campaign_id: campaignId,
        idempotency_key: 'promote-grounding-fail',
        node_id: nodeId,
      });
    } catch (error) {
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32011);
      expect(rpcError.data.reason).toBe('grounding_audit_not_pass');
    }
  });

  it('keeps node.promote fail-closed when formalization trace hash is mismatched', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-formalization-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service);
    const nodeId = firstNodeId(service, campaignId);
    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['novelty', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-for-formalization',
      node_ids: [nodeId],
    });

    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId] as Record<string, unknown>;
    const operatorTrace = node.operator_trace as Record<string, unknown>;
    const params = operatorTrace.params as Record<string, unknown>;
    const formalization = params.formalization as Record<string, unknown>;
    formalization.rationale_hash = `sha256:${'0'.repeat(64)}`;
    service.read.store.saveNodes(campaignId, nodes);

    expect(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-formalization-mismatch',
      node_id: nodeId,
    })).toThrowError(RpcError);
    try {
      service.handle('node.promote', {
        campaign_id: campaignId,
        idempotency_key: 'promote-formalization-mismatch',
        node_id: nodeId,
      });
    } catch (error) {
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
      expect(String((rpcError.data.details as Record<string, unknown>).message)).toContain('rationale_hash mismatch');
    }
  });
});
