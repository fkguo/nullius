import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { RpcError } from '../src/service/errors.js';

function initCampaign(
  service: IdeaEngineRpcService,
  seeds: Array<Record<string, unknown>> = [
    {
      content: 'seed-one',
      seed_type: 'text',
      source_uris: ['https://example.org/seed-1'],
    },
  ],
): string {
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
      seeds,
    },
  });
  return String(result.campaign_id);
}

function firstNodeId(service: IdeaEngineRpcService, campaignId: string): string {
  const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
  return Object.keys(nodes)[0]!;
}

function allNodeIds(service: IdeaEngineRpcService, campaignId: string): string[] {
  return Object.keys(service.read.store.loadNodes<Record<string, unknown>>(campaignId));
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
      evaluator_config: { dimensions: ['feasibility', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-key',
      node_ids: [nodeId],
    });
    expect(evalResult.updated_node_ids).toEqual([nodeId]);
    expect(evalResult.node_revisions[nodeId]).toBeTypeOf('number');

    const replay = service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['feasibility', 'grounding'], n_reviewers: 2 },
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

  it('keeps novelty and impact as supported evidence-gated eval dimensions', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-novelty-impact-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service);
    const nodeId = firstNodeId(service, campaignId);

    const evalResult = service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['novelty', 'impact'], n_reviewers: 2 },
      idempotency_key: 'eval-novelty-impact-key',
      node_ids: [nodeId],
    });
    const node = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId] as Record<string, unknown>;
    const scorecards = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(evalResult.scorecards_artifact_ref),
    );
    const scorecard = (scorecards.scorecards as Array<Record<string, unknown>>)[0]!;

    expect(scorecard.status).toBe('complete');
    expect(scorecard.scores).toEqual({ novelty: 1, impact: 1 });
    expect((node.eval_info as Record<string, unknown>).scores).toEqual({ novelty: 1, impact: 1 });
  });

  it('keeps rank.compute fail-closed when eval.run cannot support pareto dimensions from evidence', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-pareto-guard-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'seed-without-grounding-evidence',
        seed_type: 'text',
      },
    ]);
    const nodeId = firstNodeId(service, campaignId);

    const evalResult = service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['feasibility', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-partial-key',
      node_ids: [nodeId],
    });
    const node = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId] as Record<string, unknown>;
    const scorecards = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(evalResult.scorecards_artifact_ref),
    );
    const scorecard = (scorecards.scorecards as Array<Record<string, unknown>>)[0]!;

    expect(node.eval_info).toMatchObject({
      failure_modes: expect.arrayContaining(['missing_evidence']),
      scores: {},
    });
    expect(node.grounding_audit).toMatchObject({ status: 'partial' });
    expect(scorecard.status).toBe('failed');
    expect(scorecard.scores).toEqual({});
    expect(scorecard.evidence_uris).toBeUndefined();

    expect(() => service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-insufficient-dimensions',
      method: 'pareto',
    })).toThrowError(RpcError);
    try {
      service.handle('rank.compute', {
        campaign_id: campaignId,
        idempotency_key: 'rank-insufficient-dimensions',
        method: 'pareto',
      });
    } catch (error) {
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32013);
      expect(rpcError.data.reason).toBe('no_scorecards');
    }
  });

  it('keeps rank.compute elo fail-closed when only one node has evidence-backed eval signals', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-elo-guard-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'seed-without-grounding-evidence',
        seed_type: 'text',
      },
      {
        content: 'seed-with-grounding-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-2'],
      },
    ]);
    const [weakNodeId, strongNodeId] = allNodeIds(service, campaignId);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['feasibility', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-elo-key',
      node_ids: [weakNodeId, strongNodeId],
    });

    expect(() => service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-elo-guard',
      method: 'elo',
      elo_config: { initial_rating: 1000, k_factor: 16, max_rounds: 4, seed: 7 },
    })).toThrowError(RpcError);
    try {
      service.handle('rank.compute', {
        campaign_id: campaignId,
        idempotency_key: 'rank-elo-guard',
        method: 'elo',
        elo_config: { initial_rating: 1000, k_factor: 16, max_rounds: 4, seed: 7 },
      });
    } catch (error) {
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32013);
      expect(rpcError.data.reason).toBe('insufficient_nodes');
    }
  });

  it('prefers the strongest evaluated node as the search frontier parent when eval evidence exists', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-frontier-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'older-seed-with-placeholder-evidence',
        seed_type: 'text',
      },
      {
        content: 'newer-seed-with-real-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-2'],
      },
    ]);
    const [olderNodeId, strongerNodeId] = allNodeIds(service, campaignId);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['feasibility', 'grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-frontier-key',
      node_ids: [olderNodeId, strongerNodeId],
    });
    const evaluatedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    expect((evaluatedNodes[olderNodeId]!.eval_info as Record<string, unknown>).scores).toEqual({});
    expect((evaluatedNodes[strongerNodeId]!.grounding_audit as Record<string, unknown>).status).toBe('pass');

    const searchResult = service.handle('search.step', {
      campaign_id: campaignId,
      idempotency_key: 'search-step-frontier-key',
      n_steps: 1,
    });
    const newNodeId = String((searchResult.new_node_ids as string[])[0]);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const newNode = nodes[newNodeId] as Record<string, unknown>;

    expect(newNode.parent_node_ids).toEqual([strongerNodeId]);
  });

  it('keeps failed eval nodes in stable fallback instead of boosting them as frontier support', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-frontier-failed-fallback-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'older-stable-fallback-seed',
        seed_type: 'text',
      },
      {
        content: 'newer-failed-eval-seed',
        seed_type: 'text',
      },
    ]);
    const [stableFallbackNodeId, failedEvalNodeId] = allNodeIds(service, campaignId);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[stableFallbackNodeId]!.created_at = '2026-03-25T00:00:00Z';
    nodes[failedEvalNodeId]!.created_at = '2026-03-25T00:01:00Z';
    nodes[failedEvalNodeId]!.eval_info = {
      failure_modes: ['missing_evidence'],
      fix_suggestions: [],
      scores: { grounding: 0 },
    };
    nodes[failedEvalNodeId]!.grounding_audit = {
      failures: ['missing_grounding_evidence'],
      folklore_risk_score: 0.85,
      status: 'fail',
      timestamp: '2026-03-25T00:00:00Z',
    };
    service.read.store.saveNodes(campaignId, nodes);

    const searchResult = service.handle('search.step', {
      campaign_id: campaignId,
      idempotency_key: 'search-step-frontier-failed-fallback-key',
      n_steps: 1,
    });
    const newNodeId = String((searchResult.new_node_ids as string[])[0]);
    const updatedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const newNode = updatedNodes[newNodeId] as Record<string, unknown>;

    expect(newNode.parent_node_ids).toEqual([stableFallbackNodeId]);
  });

  it('keeps invalid formalization eval nodes in stable fallback instead of boosting them as frontier support', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-frontier-invalid-formalization-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'older-stable-fallback-seed',
        seed_type: 'text',
      },
      {
        content: 'newer-invalid-formalization-seed',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-2'],
      },
    ]);
    const [stableFallbackNodeId, invalidEvalNodeId] = allNodeIds(service, campaignId);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[stableFallbackNodeId]!.created_at = '2026-03-25T00:00:00Z';
    nodes[invalidEvalNodeId]!.created_at = '2026-03-25T00:01:00Z';
    nodes[invalidEvalNodeId]!.eval_info = {
      failure_modes: ['formalization_trace_invalid'],
      fix_suggestions: [],
      scores: { feasibility: 1 },
    };
    nodes[invalidEvalNodeId]!.grounding_audit = {
      failures: ['formalization_trace_invalid'],
      folklore_risk_score: 0.85,
      status: 'fail',
      timestamp: '2026-03-25T00:00:00Z',
    };
    service.read.store.saveNodes(campaignId, nodes);

    const searchResult = service.handle('search.step', {
      campaign_id: campaignId,
      idempotency_key: 'search-step-frontier-invalid-formalization-key',
      n_steps: 1,
    });
    const newNodeId = String((searchResult.new_node_ids as string[])[0]);
    const updatedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const newNode = updatedNodes[newNodeId] as Record<string, unknown>;

    expect(newNode.parent_node_ids).toEqual([stableFallbackNodeId]);
  });

  it('uses coarse support markers without creating false quality differences between passing nodes', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-coarse-support-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'first-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-1'],
      },
      {
        content: 'second-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-2'],
      },
    ]);
    const [firstNodeId, secondNodeId] = allNodeIds(service, campaignId);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['novelty', 'impact'], n_reviewers: 2 },
      idempotency_key: 'eval-coarse-support-key',
      node_ids: [firstNodeId, secondNodeId],
    });
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);

    expect((nodes[firstNodeId]!.eval_info as Record<string, unknown>).scores).toEqual({ novelty: 1, impact: 1 });
    expect((nodes[secondNodeId]!.eval_info as Record<string, unknown>).scores).toEqual({ novelty: 1, impact: 1 });

    const rankResult = service.handle('rank.compute', {
      campaign_id: campaignId,
      dimensions: ['novelty', 'impact'],
      idempotency_key: 'rank-coarse-support-key',
      method: 'pareto',
    });
    const rankedNodes = rankResult.ranked_nodes as Array<Record<string, unknown>>;

    expect(rankedNodes).toHaveLength(2);
    expect(rankedNodes.map(node => node.pareto_front)).toEqual([true, true]);
  });

  it('uses stable tie-breaks between multiple evidence-supported frontier parents', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-frontier-supported-tie-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'first-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-1'],
      },
      {
        content: 'second-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-2'],
      },
    ]);
    const [firstNodeId, secondNodeId] = allNodeIds(service, campaignId);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[firstNodeId]!.created_at = '2026-03-25T00:00:00Z';
    nodes[secondNodeId]!.created_at = '2026-03-25T00:01:00Z';
    service.read.store.saveNodes(campaignId, nodes);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['novelty', 'impact'], n_reviewers: 2 },
      idempotency_key: 'eval-frontier-supported-tie-key',
      node_ids: [firstNodeId, secondNodeId],
    });
    const searchResult = service.handle('search.step', {
      campaign_id: campaignId,
      idempotency_key: 'search-step-frontier-supported-tie-key',
      n_steps: 1,
    });
    const newNodeId = String((searchResult.new_node_ids as string[])[0]);
    const updatedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const newNode = updatedNodes[newNodeId] as Record<string, unknown>;

    expect(newNode.parent_node_ids).toEqual([firstNodeId]);
  });

  it('ignores stale grounding failure when ranking on refreshed non-grounding dimensions', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-stale-grounding-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'older-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-1'],
      },
      {
        content: 'newer-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-2'],
      },
    ]);
    const [firstNodeId, secondNodeId] = allNodeIds(service, campaignId);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const firstNode = nodes[firstNodeId] as Record<string, unknown>;
    const operatorTrace = firstNode.operator_trace as Record<string, unknown>;
    const params = operatorTrace.params as Record<string, unknown>;
    const formalization = params.formalization as Record<string, unknown>;
    const originalHash = String(formalization.rationale_hash);

    formalization.rationale_hash = `sha256:${'0'.repeat(64)}`;
    service.read.store.saveNodes(campaignId, nodes);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-stale-grounding-fail',
      node_ids: [firstNodeId],
    });

    const failedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    expect((failedNodes[firstNodeId]!.grounding_audit as Record<string, unknown>).status).toBe('fail');

    ((failedNodes[firstNodeId]!.operator_trace as Record<string, unknown>).params as Record<string, unknown>).formalization =
      { ...formalization, rationale_hash: originalHash };
    service.read.store.saveNodes(campaignId, failedNodes);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['feasibility'], n_reviewers: 2 },
      idempotency_key: 'eval-stale-grounding-refresh',
      node_ids: [firstNodeId, secondNodeId],
    });

    const rankResult = service.handle('rank.compute', {
      campaign_id: campaignId,
      dimensions: ['feasibility'],
      elo_config: { initial_rating: 1000, k_factor: 16, max_rounds: 4, seed: 9 },
      idempotency_key: 'rank-ignore-stale-grounding',
      method: 'elo',
    });

    expect(rankResult.ranked_nodes).toHaveLength(2);
  });

  it('ignores stale grounding failure when choosing refreshed non-grounding frontier support', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-engine-post-search-frontier-stale-grounding-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const campaignId = initCampaign(service, [
      {
        content: 'older-seed-with-evidence',
        seed_type: 'text',
        source_uris: ['https://example.org/seed-1'],
      },
      {
        content: 'newer-stable-fallback-seed',
        seed_type: 'text',
      },
    ]);
    const [supportedNodeId, fallbackNodeId] = allNodeIds(service, campaignId);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[supportedNodeId]!.created_at = '2026-03-25T00:01:00Z';
    nodes[fallbackNodeId]!.created_at = '2026-03-25T00:00:00Z';
    const supportedNode = nodes[supportedNodeId] as Record<string, unknown>;
    const operatorTrace = supportedNode.operator_trace as Record<string, unknown>;
    const params = operatorTrace.params as Record<string, unknown>;
    const formalization = params.formalization as Record<string, unknown>;
    const originalHash = String(formalization.rationale_hash);

    formalization.rationale_hash = `sha256:${'0'.repeat(64)}`;
    service.read.store.saveNodes(campaignId, nodes);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['grounding'], n_reviewers: 2 },
      idempotency_key: 'eval-frontier-stale-grounding-fail',
      node_ids: [supportedNodeId],
    });

    const failedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    expect((failedNodes[supportedNodeId]!.grounding_audit as Record<string, unknown>).status).toBe('fail');

    ((failedNodes[supportedNodeId]!.operator_trace as Record<string, unknown>).params as Record<string, unknown>).formalization =
      { ...formalization, rationale_hash: originalHash };
    service.read.store.saveNodes(campaignId, failedNodes);

    service.handle('eval.run', {
      campaign_id: campaignId,
      evaluator_config: { dimensions: ['feasibility'], n_reviewers: 2 },
      idempotency_key: 'eval-frontier-stale-grounding-refresh',
      node_ids: [supportedNodeId],
    });
    const searchResult = service.handle('search.step', {
      campaign_id: campaignId,
      idempotency_key: 'search-step-frontier-stale-grounding-key',
      n_steps: 1,
    });
    const newNodeId = String((searchResult.new_node_ids as string[])[0]);
    const updatedNodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const newNode = updatedNodes[newNodeId] as Record<string, unknown>;

    expect(newNode.parent_node_ids).toEqual([supportedNodeId]);
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
      evaluator_config: { dimensions: ['feasibility', 'grounding'], n_reviewers: 2 },
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
