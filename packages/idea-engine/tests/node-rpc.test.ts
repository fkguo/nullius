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

function setPosterior(
  service: IdeaEngineRpcService,
  campaignId: string,
  nodeId: string,
  key: string,
  value: number,
  evidenceCount: number,
): Record<string, unknown> {
  return service.handle('node.set_posterior', {
    campaign_id: campaignId,
    idempotency_key: key,
    node_id: nodeId,
    posterior: { evidence_count: evidenceCount, value },
  });
}

function expectRpcError(fn: () => unknown, code: number, reason: string): void {
  try {
    fn();
    throw new Error(`expected RpcError ${code}/${reason}`);
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(code);
    expect(error.data.reason).toBe(reason);
  }
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

  it('runs set_posterior, rank.compute, and node.promote end to end', () => {
    const service = freshService('idea-engine-node-rpc-');
    const campaignId = initCampaign(service, [
      { content: 'seed-one', seed_type: 'text', source_uris: ['https://example.org/seed-1'] },
      { content: 'seed-two', seed_type: 'text', source_uris: ['https://example.org/seed-2'] },
    ]);
    const [n1, n2] = allNodeIds(service, campaignId);

    const updated = setPosterior(service, campaignId, n1!, 'sp-1', 0.42, 3);
    expect((updated.node as Record<string, unknown>).revision).toBe(2);
    const posterior = (updated.node as Record<string, unknown>).posterior as Record<string, unknown>;
    expect(posterior.value).toBe(0.42);
    expect(posterior.evidence_count).toBe(3);
    expect(typeof posterior.updated_at).toBe('string');

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

    const rankingArtifact = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(rank.ranking_artifact_ref),
    );
    expect(rankingArtifact.method).toBe('posterior');
    expect(rankingArtifact.skipped_nodes).toEqual([]);
    expect((rankingArtifact.ranked_nodes as unknown[]).length).toBe(2);

    setGroundingPass(service, campaignId, n1!);
    const promoted = service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-1',
      node_id: n1,
    });
    expect(promoted.node_id).toBe(n1);
    expect(promoted.has_reduction_report).toBe(false);
    expect(promoted.reduction_audit_summary).toBeNull();

    const handoff = service.read.store.loadArtifactFromRef<Record<string, unknown>>(
      String(promoted.handoff_artifact_ref),
    );
    expect(handoff.node_id).toBe(n1);
    expect(handoff.idea_card).toBeTruthy();
    expect(handoff).not.toHaveProperty('evidence_support');
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

  it('reports skipped nodes explicitly and accepts an empty ranking', () => {
    const service = freshService('idea-engine-node-rank-skips-');
    const campaignId = initCampaign(service, [
      { content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] },
      { content: 'seed-b', seed_type: 'text', source_uris: ['https://example.org/b'] },
      { content: 'seed-c', seed_type: 'text', source_uris: ['https://example.org/c'] },
    ]);
    const [na, nb, nc] = allNodeIds(service, campaignId);
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

    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      idempotency_key: 'rank-skips',
      method: 'posterior',
    });
    expect(rank.ranked_nodes).toEqual([]);
    const skipped = rank.skipped_nodes as Array<Record<string, unknown>>;
    const reasonByNode = new Map(skipped.map(row => [row.node_id, row.reason]));
    expect(reasonByNode.get(na!)).toBe('no_posterior');
    expect(reasonByNode.get(nb!)).toBe('waiting_activation');
    expect(reasonByNode.get(nc!)).toBe('archived');
    expect(skipped).toHaveLength(3);
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

  it('blocks node.promote without a posterior', () => {
    const service = freshService('idea-engine-node-promote-posterior-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setGroundingPass(service, campaignId, nodeId!);

    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-no-posterior',
      node_id: nodeId,
    }), -32017, 'posterior_missing');
  });

  it('blocks node.promote for non-active lifecycle states', () => {
    const service = freshService('idea-engine-node-promote-lifecycle-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    setPosterior(service, campaignId, nodeId!, 'sp', 0.6, 2);
    setGroundingPass(service, campaignId, nodeId!);
    service.handle('node.set_lifecycle', {
      campaign_id: campaignId,
      idempotency_key: 'sl-archive',
      lifecycle_state: 'archived',
      node_id: nodeId,
      reason: 'kill criterion met',
    });

    expectRpcError(() => service.handle('node.promote', {
      campaign_id: campaignId,
      idempotency_key: 'promote-archived',
      node_id: nodeId,
    }), -32017, 'node_not_active');
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
    expect((second.node as Record<string, unknown>).revision).toBe(3);
  });

  it('writes set_posterior and set_lifecycle mutations to the node mutation log', () => {
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
    expect(mutations).toEqual(['create', 'set_posterior', 'set_lifecycle']);
    const lifecycleEntry = logLines[2]!;
    expect(lifecycleEntry.reason).toBe('exploration budget better spent elsewhere');
    expect(lifecycleEntry.revision).toBe(3);
  });

  it('requires an activation_condition for waiting_activation and clears it on return to active', () => {
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
      lifecycle_state: 'active',
      node_id: nodeId,
    });
    expect((reactivated.node as Record<string, unknown>).lifecycle_state).toBe('active');
    expect((reactivated.node as Record<string, unknown>).activation_condition).toBeNull();

    const storedNode = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId!]!;
    expect(storedNode.activation_condition).toBeNull();
    expect(storedNode.lifecycle_state).toBe('active');
  });

  it('rejects node mutations on a completed campaign but keeps reads working', () => {
    const service = freshService('idea-engine-completed-campaign-');
    const campaignId = initCampaign(service);
    const [nodeId] = allNodeIds(service, campaignId);
    service.handle('campaign.complete', {
      campaign_id: campaignId,
      idempotency_key: 'complete-1',
    });

    expectRpcError(() => setPosterior(service, campaignId, nodeId!, 'sp-after-complete', 0.5, 1), -32015, 'campaign_not_active');
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
            lifecycle_state: 'active',
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
