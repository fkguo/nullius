import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';
import { RpcError } from '../src/service/errors.js';
import { recordOrReplay } from '../src/service/idempotency.js';

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
      campaign_name: 'node-rpc',
      domain: 'test-domain',
      scope: 'portfolio runtime regression fixture',
    },
    idempotency_key: 'init-key',
    seed_pack: {
      seeds,
    },
  });
  return String(result.campaign_id);
}

function allNodeIds(service: IdeaEngineRpcService, campaignId: string): string[] {
  return Object.keys(service.read.store.loadNodes<Record<string, unknown>>(campaignId));
}

function setGroundingPass(service: IdeaEngineRpcService, campaignId: string, nodeId: string): void {
  const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
  nodes[nodeId]!.grounding_audit = {
    failures: [],
    folklore_risk_score: 0.1,
    status: 'pass',
    timestamp: '2026-07-05T00:00:00Z',
  };
  service.read.store.saveNodes(campaignId, nodes);
}

function enterAdmissionReview(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
): Record<string, unknown> {
  return service.handle('node.set_lifecycle', {
    campaign_id: campaignId,
    idempotency_key: key,
    lifecycle_state: 'admission_review',
    node_id: nodeId,
  });
}

/**
 * Drives the normal admission path: a candidate node first declares
 * admission_review (the machine forbids posterior writes on candidates),
 * then receives the posterior write, from which the engine derives
 * admitted / needs_refresh itself.
 */
function setPosterior(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
  value: number,
  evidenceCount: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const node = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
  if (node.lifecycle_state === 'candidate') {
    enterAdmissionReview(service, campaignId, nodeId, `${key}-review`);
  }
  return service.handle('node.set_posterior', {
    campaign_id: campaignId,
    idempotency_key: key,
    literature_coverage: {
      status: 'saturated',
      survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
      close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      ...((overrides.literature_coverage as Record<string, unknown> | undefined) ?? {}),
    },
    node_id: nodeId,
    posterior: { evidence_count: evidenceCount, value, ...((overrides.posterior as Record<string, unknown> | undefined) ?? {}) },
  });
}

function expectRpcError(fn: () => unknown, code: number, reason: string): RpcError {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(code);
    expect(error.data.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected RpcError ${code}/${reason}`);
}

describe('node-side RPC surface (posterior portfolio)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function freshService(prefix: string): IdeaEngineRpcService {
    const rootDir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(rootDir);
    return new IdeaEngineRpcService({ rootDir });
  }

  it('runs admission_review, set_posterior, rank.compute, and node.promote end to end', () => {
    const service = freshService('idea-engine-node-rpc-');
    const campaignId = initCampaign(service, [
      { content: 'seed-one', seed_type: 'text', source_uris: ['https://example.org/seed-1'] },
      { content: 'seed-two', seed_type: 'text', source_uris: ['https://example.org/seed-2'] },
    ]);
    const [n1, n2] = allNodeIds(service, campaignId);

    const stored = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    expect(stored[n1!]!.lifecycle_state).toBe('candidate');
    expect(stored[n1!]!.lifecycle_reason).toBeNull();

    const updated = setPosterior(service, campaignId, n1!, 'sp-1', 0.42, 3);
    // revision 1 = create, 2 = admission_review declaration, 3 = posterior write
    expect((updated.node as Record<string, unknown>).revision).toBe(3);
    const posterior = (updated.node as Record<string, unknown>).posterior as Record<string, unknown>;
    expect(posterior.value).toBe(0.42);
    expect(posterior.evidence_count).toBe(3);
    expect(posterior.status).toBe('current');
    expect(typeof posterior.updated_at).toBe('string');
    expect(((updated.node as Record<string, unknown>).literature_coverage as Record<string, unknown>).status).toBe('saturated');
    // The engine derived admitted from the current posterior itself.
    expect((updated.node as Record<string, unknown>).lifecycle_state).toBe('admitted');
    expect((updated.node as Record<string, unknown>).lifecycle_reason).toBe('posterior_status=current');

    setPosterior(service, campaignId, n2!, 'sp-2', 0.77, 1);

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-1',
      method: 'posterior',
    });
    const rankedNodes = rank.ranked_nodes as Array<Record<string, unknown>>;
    expect(rankedNodes.map(row => row.node_id)).toEqual([n2, n1]);
    expect(rankedNodes.map(row => row.rank)).toEqual([1, 2]);
    expect(rankedNodes[0]!.posterior_value).toBe(0.77);
    expect(rank.skipped_nodes).toEqual([]);
    expect(rank.method).toBe('posterior');
    expect(String(rank.ranking_artifact_ref)).toMatch(/^project:\/\/.+#sha256:[0-9a-f]{64}$/);
    expect(String(rank.ranking_artifact_ref)).not.toContain('file://');

    const rankingArtifact = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(rank.ranking_artifact_ref),
    );
    expect(rankingArtifact.method).toBe('posterior');
    expect(rankingArtifact.skipped_nodes).toEqual([]);
    expect((rankingArtifact.ranked_nodes as unknown[]).length).toBe(2);

    const rankIdempotency = service.read.store.loadIdempotency<Record<string, unknown>>(campaignId);
    rankIdempotency['rank.compute:rank-1']!.state = 'prepared';
    service.read.store.saveIdempotency(campaignId, rankIdempotency);
    const replayedRank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-1',
      method: 'posterior',
    });
    expect((replayedRank.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(replayedRank.ranking_artifact_ref).toBe(rank.ranking_artifact_ref);

    setGroundingPass(service, campaignId, n1!);
    const promoted = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-1',
      node_id: n1,
    });
    expect(promoted.node_id).toBe(n1);
    expect(promoted.has_reduction_report).toBe(false);
    expect(promoted.reduction_audit_summary).toBeNull();
    expect(String(promoted.handoff_artifact_ref)).toMatch(/^project:\/\/.+#sha256:[0-9a-f]{64}$/);
    expect(String(promoted.handoff_artifact_ref)).not.toContain('file://');

    const handoff = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(promoted.handoff_artifact_ref),
    );
    expect(handoff.node_id).toBe(n1);
    expect(handoff.idea_card).toBeTruthy();
    expect(handoff).not.toHaveProperty('evidence_support');

    const promoteIdempotency = service.read.store.loadIdempotency<Record<string, unknown>>(campaignId);
    promoteIdempotency['node.promote:promote-1']!.state = 'prepared';
    service.read.store.saveIdempotency(campaignId, promoteIdempotency);
    const replayedPromotion = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-1',
      node_id: n1,
    });
    expect((replayedPromotion.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(replayedPromotion.handoff_artifact_ref).toBe(promoted.handoff_artifact_ref);
  });

  it('ranks by posterior value, breaking ties by evidence_count then stable order', () => {
    const service = freshService('idea-engine-node-rank-ties-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
      { content: 'seed-c', seed_type: 'text', source_uris: ['https://example.org/c'] },
    ]);
    const [na, nb, nc] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, na!, 'sp-a', 0.5, 2);
    setPosterior(service, campaignId, nb!, 'sp-b', 0.5, 7);
    setPosterior(service, campaignId, nc!, 'sp-c', 0.5, 2);

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-ties',
      method: 'posterior',
    });
    const rankedNodes = rank.ranked_nodes as Array<Record<string, unknown>>;
    // nb wins on evidence_count; na precedes nc by stable input order.
    expect(rankedNodes.map(row => row.node_id)).toEqual([nb, na, nc]);
  });

  it('reports skipped nodes explicitly, with the lifecycle state as the reason, and accepts an empty ranking', () => {
    const service = freshService('idea-engine-node-rank-skips-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
      { content: 'seed-c', seed_type: 'text', source_uris: ['https://example.org/c'] },
      { content: 'seed-d', seed_type: 'text', source_uris: ['https://example.org/d'] },
      { content: 'seed-e', seed_type: 'text', source_uris: ['https://example.org/e'] },
    ]);
    const [na, nb, nc, nd, ne] = allNodeIds(service, campaignId);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-wait',
      lifecycle_state: 'waiting_activation',
      node_id: nb,
      activation_condition: {
        description: 'external data set not yet released',
        kind: 'data_release',
        satisfied: false,
      },
    });
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-arch',
      lifecycle_state: 'archived',
      node_id: nc,
      reason: 'superseded by a stronger variant',
    });
    enterAdmissionReview(service, campaignId, nd!, 'sl-review');
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-block',
      lifecycle_state: 'admission_blocked',
      node_id: ne,
      activation_condition: {
        description: 'needs an independent reproduction of the pilot computation',
        kind: 'required_evidence',
        satisfied: false,
      },
    });

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-skips',
      method: 'posterior',
    });
    expect(rank.ranked_nodes).toEqual([]);
    const skipped = rank.skipped_nodes as Array<Record<string, unknown>>;
    const reasonByNode = new Map(skipped.map(row => [row.node_id, row.reason]));
    expect(reasonByNode.get(na!)).toBe('candidate');
    expect(reasonByNode.get(nb!)).toBe('waiting_activation');
    expect(reasonByNode.get(nc!)).toBe('archived');
    expect(reasonByNode.get(nd!)).toBe('admission_review');
    expect(reasonByNode.get(ne!)).toBe('admission_blocked');
    expect(skipped).toHaveLength(5);
  });

  it('holds provisional-coverage posteriors in needs_refresh and re-checks admitted coverage as defense in depth', () => {
    const service = freshService('idea-engine-node-rank-coverage-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
      { content: 'seed-c', seed_type: 'text', source_uris: ['https://example.org/c'] },
    ]);
    const [na, nb, nc] = allNodeIds(service, campaignId);
    // Incomplete coverage without the waiver resolves to a provisional
    // posterior, so the engine parks the node in needs_refresh.
    const provisional = setPosterior(service, campaignId, na!, 'sp-a', 0.9, 10, {
      literature_coverage: { status: 'coverage_incomplete' },
    });
    expect((provisional.node as Record<string, unknown>).lifecycle_state).toBe('needs_refresh');
    expect(((provisional.node as Record<string, unknown>).posterior as Record<string, unknown>).status).toBe('provisional');

    // An admitted node whose coverage was stripped by hand (migrated store)
    // is caught by the data-level re-check.
    setPosterior(service, campaignId, nb!, 'sp-b', 0.8, 10);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    delete nodes[nb!]!.literature_coverage;
    service.read.store.saveNodes(campaignId, nodes);
    setPosterior(service, campaignId, nc!, 'sp-c', 0.2, 10);

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-coverage',
      method: 'posterior',
    });
    const rankedNodes = rank.ranked_nodes as Array<Record<string, unknown>>;
    expect(rankedNodes.map(row => row.node_id)).toEqual([nc]);
    expect(rankedNodes[0]!.literature_coverage_status).toBe('saturated');
    expect(rankedNodes[0]!.allocation_eligible).toBe(true);
    const skipped = rank.skipped_nodes as Array<Record<string, unknown>>;
    const reasonByNode = new Map(skipped.map(row => [row.node_id, row.reason]));
    expect(reasonByNode.get(na!)).toBe('needs_refresh');
    expect(reasonByNode.get(nb!)).toBe('metadata_only');
  });

  it('rejects direct set_posterior attempts without close-prior refs', () => {
    const service = freshService('idea-engine-node-posterior-coverage-gate-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);

    expectRpcError(() => service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-no-refs',
      literature_coverage: { status: 'saturated' },
      node_id: nodeId,
      posterior: { evidence_count: 1, value: 0.5 },
    }), -32002, 'schema_invalid');

    expectRpcError(() => service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-metadata-only',
      literature_coverage: {
        status: 'metadata_only',
        survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      },
      node_id: nodeId,
      posterior: { evidence_count: 1, value: 0.5 },
    }), -32002, 'schema_invalid');
  });

  it('does not rank legacy saturated coverage when close-prior refs are absent', () => {
    const service = freshService('idea-engine-node-rank-missing-coverage-refs-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-good', 0.9, 10);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId!]!.literature_coverage = { status: 'saturated' };
    service.read.store.saveNodes(campaignId, nodes);

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-missing-refs',
      method: 'posterior',
    });

    expect(rank.ranked_nodes).toEqual([]);
    expect(rank.skipped_nodes).toEqual([
      {
        node_id: nodeId,
        reason: 'metadata_only',
        literature_coverage_status: 'saturated',
        posterior_status: 'current',
        allocation_eligible: false,
      },
    ]);
  });

  it('parks stale posteriors in needs_refresh and catches hand-degraded admitted posteriors', () => {
    const service = freshService('idea-engine-node-rank-stale-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
      { content: 'seed-c', seed_type: 'text', source_uris: ['https://example.org/c'] },
    ]);
    const [na, nb, nc] = allNodeIds(service, campaignId);
    // An explicitly stale write lands in needs_refresh via the engine's own
    // derivation.
    const stale = setPosterior(service, campaignId, na!, 'sp-a', 0.9, 10, {
      posterior: { status: 'stale' },
    });
    expect((stale.node as Record<string, unknown>).lifecycle_state).toBe('needs_refresh');
    // An admitted node whose posterior status was degraded by hand (migrated
    // store) is caught by the data-level re-check.
    setPosterior(service, campaignId, nb!, 'sp-b', 0.7, 10);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    ((nodes[nb!]!.posterior) as Record<string, unknown>).status = 'provisional';
    service.read.store.saveNodes(campaignId, nodes);
    setPosterior(service, campaignId, nc!, 'sp-c', 0.3, 10);

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-stale',
      method: 'posterior',
    });
    expect((rank.ranked_nodes as Array<Record<string, unknown>>).map(row => row.node_id)).toEqual([nc]);
    const skipped = rank.skipped_nodes as Array<Record<string, unknown>>;
    expect(skipped).toContainEqual({
      node_id: na,
      reason: 'needs_refresh',
    });
    expect(skipped).toContainEqual({
      node_id: nb,
      reason: 'posterior_not_current',
      literature_coverage_status: 'saturated',
      posterior_status: 'provisional',
      allocation_eligible: false,
    });
  });

  it('rejects legacy rank methods at the contract boundary', () => {
    const service = freshService('idea-engine-node-rank-legacy-');
    const campaignId = initCampaign(service);
    expectRpcError(() => service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-legacy',
      method: 'pareto',
    }), -32002, 'schema_invalid');
  });

  it('keeps node.promote rejecting when grounding has not passed', () => {
    const service = freshService('idea-engine-node-promote-grounding-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp', 0.4, 1);

    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-grounding',
      node_id: nodeId,
    }), -32011, 'grounding_audit_not_pass');
  });

  it('blocks node.promote when an admitted node lost its posterior (hand-migrated store)', () => {
    const service = freshService('idea-engine-node-promote-posterior-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp', 0.6, 2);
    setGroundingPass(service, campaignId, nodeId!);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId!]!.posterior = null;
    service.read.store.saveNodes(campaignId, nodes);

    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-no-posterior',
      node_id: nodeId,
    }), -32017, 'posterior_missing');
  });

  it('blocks node.promote for non-admitted lifecycle states', () => {
    const service = freshService('idea-engine-node-promote-lifecycle-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
    ]);
    const [archivedNode, candidateNode] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, archivedNode!, 'sp', 0.6, 2);
    setGroundingPass(service, campaignId, archivedNode!);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-archive',
      lifecycle_state: 'archived',
      node_id: archivedNode,
      reason: 'kill criterion met',
    });
    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-archived',
      node_id: archivedNode,
    }), -32017, 'node_not_admitted');

    // A candidate that never went through admission is equally not promotable.
    setGroundingPass(service, campaignId, candidateNode!);
    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-candidate',
      node_id: candidateNode,
    }), -32017, 'node_not_admitted');
  });

  it('strips placeholder evidence from the promoted idea card and rejects placeholder-only claims', () => {
    const service = freshService('idea-engine-node-promote-placeholder-');
    const campaignId = initCampaign(service, [
      { content: 'seed-with-real-evidence', seed_type: 'text', source_uris: ['https://example.org/seed-1'] },
      { content: 'seed-without-evidence', seed_type: 'text' },
    ]);
    const [withEvidence, withoutEvidence] = allNodeIds(service, campaignId);
    for (const nodeId of [withEvidence, withoutEvidence]) {
      setPosterior(service, campaignId, nodeId!, `sp-${nodeId}`, 0.5, 1);
      setGroundingPass(service, campaignId, nodeId!);
    }
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const ideaCard = nodes[withEvidence!]!.idea_card as Record<string, unknown>;
    const firstClaim = (ideaCard.claims as Array<Record<string, unknown>>)[0]!;
    firstClaim.evidence_uris = ['https://example.org/seed-1', 'https://example.org/reference'];
    service.read.store.saveNodes(campaignId, nodes);

    const promoted = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-placeholder-mixed',
      node_id: withEvidence,
    });
    const handoff = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(promoted.handoff_artifact_ref),
    );
    const promotedClaim = ((handoff.idea_card as Record<string, unknown>).claims as Array<Record<string, unknown>>)[0]!;
    expect(promotedClaim.evidence_uris).toEqual(['https://example.org/seed-1']);

    // A literature-support claim whose only evidence is the placeholder must
    // fail the promoted idea_card schema check (defaults to not passing).
    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-placeholder-only',
      node_id: withoutEvidence,
    }), -32002, 'schema_invalid');
  });

  it('keeps node.promote rejecting a mismatched formalization trace', () => {
    const service = freshService('idea-engine-node-promote-trace-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp', 0.5, 1);
    setGroundingPass(service, campaignId, nodeId!);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const operatorTrace = nodes[nodeId!]!.operator_trace as Record<string, unknown>;
    const params = operatorTrace.params as Record<string, unknown>;
    (params.formalization as Record<string, unknown>).rationale_hash = `sha256:${'0'.repeat(64)}`;
    service.read.store.saveNodes(campaignId, nodes);

    try {
      service.handle('node.promote', {
        campaign_id: campaignId,
        idempotency_key: 'promote-trace-mismatch',
        node_id: nodeId,
      });
      throw new Error('expected RpcError');
    } catch (error) {
      const rpcError = error as RpcError;
      expect(rpcError.code).toBe(-32002);
      expect(rpcError.data.reason).toBe('schema_invalid');
      expect(String((rpcError.data.details as Record<string, unknown>).message)).toContain('rationale_hash mismatch');
    }
  });

  it('enforces the conditional reduction gate on promotion', () => {
    const service = freshService('idea-engine-node-promote-reduction-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp', 0.5, 1);
    setGroundingPass(service, campaignId, nodeId!);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId!]!.reduction_report = {
      abstract_problem: 'unregistered-problem-type',
      mapping: 'toy mapping description',
      assumptions: ['assumption-1'],
    };
    service.read.store.saveNodes(campaignId, nodes);

    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-reduction-missing',
      node_id: nodeId,
    }), -32016, 'reduction_audit_missing');
  });

  it('replays node.set_posterior idempotently and rejects payload conflicts', () => {
    const service = freshService('idea-engine-set-posterior-idem-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);

    const first = setPosterior(service, campaignId, nodeId!, 'sp-idem', 0.3, 2);
    expect((first.idempotency as Record<string, unknown>).is_replay).toBe(false);
    const replay = setPosterior(service, campaignId, nodeId!, 'sp-idem', 0.3, 2);
    expect((replay.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect((replay.node as Record<string, unknown>).revision).toBe((first.node as Record<string, unknown>).revision);

    // Same key, different payload: rejected without executing.
    expectRpcError(() => setPosterior(service, campaignId, nodeId!, 'sp-idem', 0.9, 2), -32002, 'idempotency_key_conflict');

    // A fresh key with new values performs a second mutation.
    const second = setPosterior(service, campaignId, nodeId!, 'sp-idem-2', 0.9, 5);
    expect((second.node as Record<string, unknown>).revision).toBe(4);
  });

  it('writes admission_review, set_posterior, and set_lifecycle mutations to the node mutation log', () => {
    const service = freshService('idea-engine-mutation-log-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp-log', 0.25, 1);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-log',
      lifecycle_state: 'archived',
      node_id: nodeId,
      reason: 'exploration budget better spent elsewhere',
    });

    const logLines = readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const mutations = logLines.map(line => line.mutation);
    expect(mutations).toEqual(['create', 'set_lifecycle', 'set_posterior', 'set_lifecycle']);
    const lifecycleEntry = logLines[3]!;
    expect(lifecycleEntry.reason).toBe('exploration budget better spent elsewhere');
    expect(lifecycleEntry.revision).toBe(4);
    const storedNode = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId!]!;
    expect(storedNode.lifecycle_reason).toBe('exploration budget better spent elsewhere');
  });

  it('requires an activation_condition for the condition-carrying states and clears it on exit', () => {
    const service = freshService('idea-engine-set-lifecycle-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);

    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-missing-condition',
      lifecycle_state: 'waiting_activation',
      node_id: nodeId,
    }), -32002, 'activation_condition_required');

    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-missing-blocked-condition',
      lifecycle_state: 'admission_blocked',
      node_id: nodeId,
    }), -32002, 'activation_condition_required');

    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-unexpected-condition',
      lifecycle_state: 'archived',
      node_id: nodeId,
      activation_condition: {
        description: 'should not be here',
        kind: 'other',
        satisfied: false,
      },
    }), -32002, 'activation_condition_unexpected');

    const waiting = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-wait',
      lifecycle_state: 'waiting_activation',
      node_id: nodeId,
      activation_condition: {
        description: 'needs the external solver to be validated',
        kind: 'tool_readiness',
        satisfied: false,
      },
    });
    expect((waiting.node as Record<string, unknown>).lifecycle_state).toBe('waiting_activation');
    expect(((waiting.node as Record<string, unknown>).activation_condition as Record<string, unknown>).kind).toBe('tool_readiness');

    const reactivated = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-reactivate',
      lifecycle_state: 'candidate',
      node_id: nodeId,
    });
    expect((reactivated.node as Record<string, unknown>).lifecycle_state).toBe('candidate');
    expect((reactivated.node as Record<string, unknown>).activation_condition).toBeNull();

    const storedNode = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId!]!;
    expect(storedNode.activation_condition).toBeNull();
    expect(storedNode.lifecycle_state).toBe('candidate');
  });

  it('rejects illegal transitions with the allowed next states', () => {
    const service = freshService('idea-engine-illegal-transition-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);

    const error = expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-shortcut',
      lifecycle_state: 'admitted',
      node_id: nodeId,
    }), -32018, 'illegal_transition');
    const details = error.data.details as Record<string, unknown>;
    expect(details.current_state).toBe('candidate');
    expect(details.requested_state).toBe('admitted');
    expect(details.allowed_next).toEqual(['admission_review', 'admission_blocked', 'waiting_activation', 'archived']);

    // needs_refresh is likewise not reachable from candidate.
    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-refresh-shortcut',
      lifecycle_state: 'needs_refresh',
      node_id: nodeId,
    }), -32018, 'illegal_transition');

    // Self-transition exists only for the condition-carrying states.
    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-selfloop',
      lifecycle_state: 'candidate',
      node_id: nodeId,
    }), -32018, 'illegal_transition');
  });

  it('enforces entry preconditions on stored data', () => {
    const service = freshService('idea-engine-entry-preconditions-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
    ]);
    const [na, nb] = allNodeIds(service, campaignId);

    // admitted requires a current posterior: a bare review cannot jump there.
    enterAdmissionReview(service, campaignId, na!, 'sl-review-a');
    const admittedError = expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-admit-early',
      lifecycle_state: 'admitted',
      node_id: na,
    }), -32018, 'entry_precondition_failed');
    expect((admittedError.data.details as Record<string, unknown>).requirement).toBe('posterior_required');

    // needs_refresh requires a posterior history.
    const refreshError = expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-refresh-early',
      lifecycle_state: 'needs_refresh',
      node_id: na,
    }), -32018, 'entry_precondition_failed');
    expect((refreshError.data.details as Record<string, unknown>).requirement).toBe('posterior_required');

    // candidate requires posterior null: a node with a posterior history
    // re-enters as needs_refresh, not candidate.
    setPosterior(service, campaignId, nb!, 'sp-b', 0.5, 2);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-archive-b',
      lifecycle_state: 'archived',
      node_id: nb,
      reason: 'parked for the record',
    });
    const candidateError = expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-revive-as-candidate',
      lifecycle_state: 'candidate',
      node_id: nb,
    }), -32018, 'entry_precondition_failed');
    expect((candidateError.data.details as Record<string, unknown>).requirement).toBe('posterior_must_be_null');

    const revived = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-revive-as-refresh',
      lifecycle_state: 'needs_refresh',
      node_id: nb,
      reason: 'revival: new evidence arrived, posterior must be re-reviewed',
    });
    expect((revived.node as Record<string, unknown>).lifecycle_state).toBe('needs_refresh');
  });

  it('requires a reason to archive', () => {
    const service = freshService('idea-engine-archive-reason-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-archive-no-reason',
      lifecycle_state: 'archived',
      node_id: nodeId,
    }), -32002, 'archived_reason_required');
  });

  it('scopes posterior writes to admission_review, admitted, and needs_refresh', () => {
    const service = freshService('idea-engine-posterior-scope-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
    ]);
    const [na, nb] = allNodeIds(service, campaignId);

    // Direct write on a candidate: must declare admission_review first.
    const candidateError = expectRpcError(() => service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-candidate',
      literature_coverage: {
        status: 'saturated',
        survey_ref: `project://artifacts/literature/${na}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${na}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      },
      node_id: na,
      posterior: { evidence_count: 1, value: 0.5 },
    }), -32018, 'posterior_write_lifecycle_invalid');
    const details = candidateError.data.details as Record<string, unknown>;
    expect(details.current_state).toBe('candidate');
    expect(details.allowed_states).toEqual(['admission_review', 'admitted', 'needs_refresh']);

    // Parked and archived nodes must be transitioned out before a write.
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-block-b',
      lifecycle_state: 'admission_blocked',
      node_id: nb,
      activation_condition: {
        description: 'needs a pilot computation before admission',
        kind: 'required_evidence',
        satisfied: false,
      },
    });
    expectRpcError(() => service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-blocked',
      literature_coverage: {
        status: 'saturated',
        survey_ref: `project://artifacts/literature/${nb}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${nb}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      },
      node_id: nb,
      posterior: { evidence_count: 1, value: 0.5 },
    }), -32018, 'posterior_write_lifecycle_invalid');
  });

  it('rejects a current-labeled posterior that its coverage cannot support', () => {
    const service = freshService('idea-engine-posterior-status-consistency-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    enterAdmissionReview(service, campaignId, nodeId!, 'sl-review');
    expectRpcError(() => service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-current-incomplete',
      literature_coverage: {
        status: 'coverage_incomplete',
        survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      },
      node_id: nodeId,
      posterior: { evidence_count: 1, value: 0.5, status: 'current' },
    }), -32002, 'posterior_status_not_supported_by_coverage');

    // The explicit exploratory waiver makes the same write legal.
    const waived = service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-current-waived',
      literature_coverage: {
        status: 'coverage_incomplete',
        exploratory_allocation: true,
        survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      },
      node_id: nodeId,
      posterior: { evidence_count: 1, value: 0.5, status: 'current' },
    });
    expect((waived.node as Record<string, unknown>).lifecycle_state).toBe('admitted');
  });

  it('derives admitted and needs_refresh from posterior writes, both ways', () => {
    const service = freshService('idea-engine-posterior-derivation-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);

    // First write is provisional -> needs_refresh.
    const provisional = setPosterior(service, campaignId, nodeId!, 'sp-1', 0.4, 1, {
      posterior: { status: 'provisional' },
    });
    expect((provisional.node as Record<string, unknown>).lifecycle_state).toBe('needs_refresh');
    expect((provisional.node as Record<string, unknown>).lifecycle_reason).toBe('posterior_status=provisional');

    // The reviewed writeback promotes to admitted.
    const current = setPosterior(service, campaignId, nodeId!, 'sp-2', 0.55, 3);
    expect((current.node as Record<string, unknown>).lifecycle_state).toBe('admitted');
    expect((current.node as Record<string, unknown>).lifecycle_reason).toBe('posterior_status=current');

    // A later stale write demotes an admitted node again.
    const stale = setPosterior(service, campaignId, nodeId!, 'sp-3', 0.55, 3, {
      posterior: { status: 'stale' },
    });
    expect((stale.node as Record<string, unknown>).lifecycle_state).toBe('needs_refresh');
    expect((stale.node as Record<string, unknown>).lifecycle_reason).toBe('posterior_status=stale');
  });

  it('moves admission_blocked nodes through condition updates back into review', () => {
    const service = freshService('idea-engine-admission-blocked-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);

    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-block',
      lifecycle_state: 'admission_blocked',
      node_id: nodeId,
      activation_condition: {
        description: 'needs an independent reproduction of the pilot computation',
        kind: 'required_evidence',
        satisfied: false,
      },
      reason: 'admission gate found the required evidence missing',
    });

    // Condition update via the self-transition.
    const updated = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-block-update',
      lifecycle_state: 'admission_blocked',
      node_id: nodeId,
      activation_condition: {
        description: 'needs an independent reproduction of the pilot computation',
        kind: 'required_evidence',
        satisfied: true,
      },
    });
    expect(((updated.node as Record<string, unknown>).activation_condition as Record<string, unknown>).satisfied).toBe(true);

    const reviewed = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-reenter-review',
      lifecycle_state: 'admission_review',
      node_id: nodeId,
      reason: 'required evidence produced',
    });
    expect((reviewed.node as Record<string, unknown>).lifecycle_state).toBe('admission_review');
    expect((reviewed.node as Record<string, unknown>).activation_condition).toBeNull();
  });

  it('returns admitted nodes from waiting_activation only while the stored data still supports it', () => {
    const service = freshService('idea-engine-waiting-return-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp', 0.6, 2);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-park',
      lifecycle_state: 'waiting_activation',
      node_id: nodeId,
      activation_condition: {
        description: 'waiting for the follow-up data release',
        kind: 'data_release',
        satisfied: false,
      },
    });

    const returned = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-return',
      lifecycle_state: 'admitted',
      node_id: nodeId,
      reason: 'awaited release arrived; posterior still current',
    });
    expect((returned.node as Record<string, unknown>).lifecycle_state).toBe('admitted');

    // Degrade the stored posterior by hand: the same return is now rejected.
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-park-2',
      lifecycle_state: 'waiting_activation',
      node_id: nodeId,
      activation_condition: {
        description: 'waiting for the second data release',
        kind: 'data_release',
        satisfied: false,
      },
    });
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    ((nodes[nodeId!]!.posterior) as Record<string, unknown>).status = 'stale';
    service.read.store.saveNodes(campaignId, nodes);
    const error = expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-return-2',
      lifecycle_state: 'admitted',
      node_id: nodeId,
    }), -32018, 'entry_precondition_failed');
    expect((error.data.details as Record<string, unknown>).requirement).toBe('posterior_status_current_required');
  });

  it('treats revival from archived as re-intake, never a shortcut back to admitted', () => {
    const service = freshService('idea-engine-revival-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
    ]);
    const [fresh, admitted] = allNodeIds(service, campaignId);

    // A never-admitted node revives as candidate.
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-arch-fresh',
      lifecycle_state: 'archived',
      node_id: fresh,
      reason: 'out of scope for this round',
    });
    const revivedFresh = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-revive-fresh',
      lifecycle_state: 'candidate',
      node_id: fresh,
      reason: 'scope widened again',
    });
    expect((revivedFresh.node as Record<string, unknown>).lifecycle_state).toBe('candidate');

    // A formerly admitted node cannot jump back to admitted from the archive.
    setPosterior(service, campaignId, admitted!, 'sp-admitted', 0.7, 4);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-arch-admitted',
      lifecycle_state: 'archived',
      node_id: admitted,
      reason: 'paused after the first investigation round',
    });
    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-shortcut-back',
      lifecycle_state: 'admitted',
      node_id: admitted,
    }), -32018, 'illegal_transition');
    const revived = service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-revive-admitted',
      lifecycle_state: 'needs_refresh',
      node_id: admitted,
      reason: 'revival: posterior must be re-reviewed before guidance',
    });
    expect((revived.node as Record<string, unknown>).lifecycle_state).toBe('needs_refresh');
    // The stored posterior is untouched history; a fresh current write
    // re-admits through the normal derivation.
    const readmitted = setPosterior(service, campaignId, admitted!, 'sp-readmit', 0.72, 5);
    expect((readmitted.node as Record<string, unknown>).lifecycle_state).toBe('admitted');
  });

  it('fails loudly on stores whose lifecycle_state is outside the machine', () => {
    const service = freshService('idea-engine-unmigrated-store-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId!]!.lifecycle_state = 'active';
    service.read.store.saveNodes(campaignId, nodes);

    const rankError = expectRpcError(() => service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-unmigrated',
      method: 'posterior',
    }), -32018, 'unknown_lifecycle_state');
    expect(String((rankError.data.details as Record<string, unknown>).message)).toContain('migrate the store');

    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-unmigrated',
      lifecycle_state: 'admission_review',
      node_id: nodeId,
    }), -32018, 'unknown_lifecycle_state');
  });

  it('rejects node mutations on a completed campaign but keeps reads working', () => {
    const service = freshService('idea-engine-completed-campaign-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    service.handle('campaign.complete', {
      campaign_id: campaignId,
      idempotency_key: 'complete-1',
    });

    expectRpcError(() => service.handle('node.set_posterior', {
      campaign_id: campaignId,
      idempotency_key: 'sp-after-complete',
      literature_coverage: {
        status: 'saturated',
        survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
        close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
      },
      node_id: nodeId,
      posterior: { evidence_count: 1, value: 0.5 },
    }), -32015, 'campaign_not_active');
    expectRpcError(() => service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-after-complete',
      lifecycle_state: 'archived',
      node_id: nodeId,
      reason: 'campaign is finished',
    }), -32015, 'campaign_not_active');

    const fetched = service.handle('node.get', { campaign_id: campaignId, node_id: nodeId });
    expect(fetched.node_id).toBe(nodeId);
  });

  it('allows posterior updates while the campaign is paused', () => {
    const service = freshService('idea-engine-paused-campaign-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    service.handle('campaign.pause', {
      campaign_id: campaignId,
      idempotency_key: 'pause-1',
    });

    const updated = setPosterior(service, campaignId, nodeId!, 'sp-paused', 0.61, 4);
    expect(((updated.node as Record<string, unknown>).posterior as Record<string, unknown>).value).toBe(0.61);

    // rank.compute still requires a running campaign.
    expectRpcError(() => service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-paused',
      method: 'posterior',
    }), -32015, 'campaign_not_active');
  });

  it('re-executes a prepared set_posterior whose write never landed, even when an unrelated mutation reached the recorded revision', () => {
    const service = freshService('idea-engine-idem-crash-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    const store = service.read.store;

    const before = store.loadNodes<Record<string, unknown>>(campaignId)[nodeId!]!;
    const baseRevision = Number(before.revision);

    // A prepared set_posterior record whose node write never reached the store
    // (crash before saveNodes): it claims revision baseRevision+1 and a
    // posterior the stored node does not have.
    const payloadHash = 'sha256:crash-recovery-fixture';
    const crashedAt = '2000-01-01T00:00:00.000Z';
    const idem = store.loadIdempotency<Record<string, unknown>>(campaignId);
    idem['node.set_posterior:crashed-key'] = {
      created_at: crashedAt,
      payload_hash: payloadHash,
      state: 'prepared',
      response: {
        kind: 'result',
        payload: {
          campaign_id: campaignId,
          node: {
            activation_condition: null,
            idea_id: String(before.idea_id),
            lifecycle_reason: 'posterior_status=current',
            lifecycle_state: 'admitted',
            literature_coverage: {
              status: 'saturated',
              survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
              close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
            },
            node_id: nodeId,
            posterior: { evidence_count: 5, updated_at: crashedAt, value: 0.9 },
            revision: baseRevision + 1,
            updated_at: crashedAt,
          },
        },
      },
    };
    store.saveIdempotency(campaignId, idem);

    // An unrelated mutation advances the node revision to the recorded revision
    // with a different updated_at; the crashed posterior write stays absent.
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'unrelated-lifecycle',
      lifecycle_state: 'archived',
      node_id: nodeId,
      reason: 'unrelated archive to advance the revision counter',
    });
    const bumped = store.loadNodes<Record<string, unknown>>(campaignId)[nodeId!]!;
    expect(Number(bumped.revision)).toBe(baseRevision + 1);
    expect(bumped.posterior ?? null).toBeNull();

    // The prepared op must not be treated as committed: its side effect never
    // landed, so recovery returns null and the caller re-executes rather than
    // replaying a cached response for a write that did not happen.
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue: 'crashed-key',
      method: 'node.set_posterior',
      payloadHash,
      store,
    });
    expect(replay).toBeNull();
  });

  it('replays a prepared set_posterior whose write did land (matching updated_at and posterior)', () => {
    const service = freshService('idea-engine-idem-landed-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    const store = service.read.store;

    const result = setPosterior(service, campaignId, nodeId!, 'sp-landed', 0.5, 2);
    const summary = result.node as Record<string, unknown>;

    // Simulate a crash after saveNodes but before the committed marker was
    // written: flip the record back to prepared. Recovery must recognize the
    // write landed (the node carries the recorded updated_at and posterior) and
    // replay the response, marking the record committed.
    const key = 'node.set_posterior:sp-landed';
    const idem = store.loadIdempotency<Record<string, unknown>>(campaignId);
    const record = idem[key]!;
    const payloadHash = String(record.payload_hash);
    record.state = 'prepared';
    idem[key] = record;
    store.saveIdempotency(campaignId, idem);

    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue: 'sp-landed',
      method: 'node.set_posterior',
      payloadHash,
      store,
    });
    expect(replay).not.toBeNull();
    expect(replay!.kind).toBe('result');
    expect((replay!.payload.node as Record<string, unknown>).posterior).toEqual(summary.posterior);
    expect((replay!.payload.idempotency as Record<string, unknown>).is_replay).toBe(true);

    const after = store.loadIdempotency<Record<string, unknown>>(campaignId);
    expect((after[key] as Record<string, unknown>).state).toBe('committed');
  });
});
