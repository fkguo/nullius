import { rmSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { payloadHash } from '../src/hash/payload-hash.js';
import {
  enterReview,
  expectRpcError,
  fresh,
  initCampaign,
  logEntries,
  reductionAudit,
  reductionReport,
  replacementCard,
  reviseParams,
  setPosterior,
} from './helpers/revise-card-test-fixture.js';

describe('node.revise_card state transition', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the card, preserves the full prior scientific state, invalidates derived guidance, and replays exactly once', () => {
    const { service } = fresh(tempDirs, 'idea-revise-full-');
    const { campaignId, nodeId } = initCampaign(service);
    enterReview(service, campaignId, nodeId, 'review');
    setPosterior(service, campaignId, nodeId, 'posterior');
    service.handle('node.set_grounding_audit', {
      campaign_id: campaignId,
      node_id: nodeId,
      grounding_audit: {
        status: 'pass',
        folklore_risk_score: 0.08,
        failures: [],
        report_ref: 'project://grounding/report.json',
      },
      idempotency_key: 'grounding',
    });
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    nodes[nodeId]!.reduction_report = reductionReport();
    nodes[nodeId]!.reduction_audit = reductionAudit();
    service.read.store.saveNodes(campaignId, nodes);
    const before = structuredClone(nodes[nodeId]!);
    const params = reviseParams(campaignId, nodeId, before, 'revise-1');

    const first = service.handle('node.revise_card', params);
    const updated = first.node as Record<string, unknown>;
    const event = first.mutation_event as Record<string, unknown>;
    const eventBefore = event.before as Record<string, unknown>;
    expect(updated.idea_card).toEqual(params.replacement_idea_card);
    expect((updated.idea_card as Record<string, unknown>).thesis_statement).toContain('Ω and  two');
    expect(updated.revision).toBe(Number(before.revision) + 1);
    expect(updated).toMatchObject({
      lifecycle_state: 'candidate',
      lifecycle_reason: 'idea_card_revised',
      activation_condition: null,
      grounding_audit: null,
      posterior: null,
      literature_coverage: null,
      reduction_report: null,
      reduction_audit: null,
    });
    expect(event.before_idea_card_hash).toBe(payloadHash(before.idea_card));
    expect(event.after_idea_card_hash).toBe(payloadHash(params.replacement_idea_card));
    expect(event.before_node).toEqual(before);
    expect(eventBefore).toMatchObject({
      revision: before.revision,
      idea_card: before.idea_card,
      grounding_audit: before.grounding_audit,
      posterior: before.posterior,
      literature_coverage: before.literature_coverage,
      reduction_report: before.reduction_report,
      reduction_audit: before.reduction_audit,
      lifecycle_state: 'admitted',
    });
    expect((eventBefore.posterior as Record<string, unknown>).gaia_package_ref).toBe('project://gaia/idea-package');
    expect(event.invalidations as Record<string, unknown>).toMatchObject({
      grounding_audit: true,
      posterior: true,
      literature_coverage: true,
      reduction_report: true,
      reduction_audit: true,
      allocation_eligibility: true,
    });
    const rank = service.handle('rank.compute', {
      campaign_id: campaignId,
      method: 'posterior',
      idempotency_key: 'rank-after',
    });
    expect(rank.ranked_nodes).toEqual([]);
    expect(rank.skipped_nodes).toEqual([{ node_id: nodeId, reason: 'candidate' }]);

    const replay = service.handle('node.revise_card', params);
    expect((replay.idempotency as Record<string, unknown>).is_replay).toBe(true);
    expect(logEntries(service, campaignId).filter((entry) => entry.mutation === 'revise_card')).toHaveLength(1);
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...params,
          reason: 'different intent under the same key',
        }),
      -32002,
      'idempotency_key_conflict',
    );
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...params,
          replacement_idea_card: replacementCard(before, 'too short'),
        }),
      -32002,
      'idempotency_key_conflict',
    );
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          ...params,
          idempotency_key: 'stale-key',
        }),
      -32019,
      'stale_revision',
    );
  });
});
