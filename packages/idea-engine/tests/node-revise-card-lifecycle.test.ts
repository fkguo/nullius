import { rmSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentNode,
  enterReview,
  expectRpcError,
  fresh,
  initCampaign,
  replacementCard,
  reviseParams,
  setPosterior,
} from './helpers/revise-card-test-fixture.js';

describe('node.revise_card lifecycle and provenance', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('allows only candidate, admission_review, admitted, and needs_refresh as source states', () => {
    const cases: Array<{ allowed: boolean; state: string }> = [
      { state: 'candidate', allowed: true },
      { state: 'admission_review', allowed: true },
      { state: 'admitted', allowed: true },
      { state: 'needs_refresh', allowed: true },
      { state: 'admission_blocked', allowed: false },
      { state: 'waiting_activation', allowed: false },
      { state: 'archived', allowed: false },
    ];
    for (const { allowed, state } of cases) {
      const { service } = fresh(tempDirs, `idea-revise-${state}-`);
      const { campaignId, nodeId } = initCampaign(service, `init-${state}`);
      if (state === 'admission_review' || state === 'admitted' || state === 'needs_refresh') {
        enterReview(service, campaignId, nodeId, `review-${state}`);
      }
      if (state === 'admitted') setPosterior(service, campaignId, nodeId, 'posterior-admitted');
      if (state === 'needs_refresh') setPosterior(service, campaignId, nodeId, 'posterior-refresh', 'provisional');
      if (state === 'admission_blocked' || state === 'waiting_activation') {
        service.handle('node.set_lifecycle', {
          campaign_id: campaignId,
          node_id: nodeId,
          lifecycle_state: state,
          activation_condition: {
            kind: 'required_evidence',
            description: 'produce missing evidence',
            satisfied: false,
          },
          idempotency_key: `state-${state}`,
        });
      }
      if (state === 'archived') {
        service.handle('node.set_lifecycle', {
          campaign_id: campaignId,
          node_id: nodeId,
          lifecycle_state: 'archived',
          reason: 'retained for record',
          idempotency_key: 'state-archived',
        });
      }
      const node = currentNode(service, campaignId, nodeId);
      const params = reviseParams(campaignId, nodeId, node, `revise-${state}`, `A revised proposition originating from lifecycle state ${state}.`);
      if (allowed) {
        expect((service.handle('node.revise_card', params).node as Record<string, unknown>).lifecycle_state).toBe('candidate');
      } else {
        expectRpcError(() => service.handle('node.revise_card', params), -32018, 'idea_card_revision_lifecycle_invalid');
      }
    }
  });

  it('keeps generated-node reserved provenance engine-owned while allowing ordinary card changes', () => {
    const { service } = fresh(tempDirs, 'idea-revise-provenance-');
    const { campaignId, nodeId } = initCampaign(service);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId]!;
    const prior = 'https://example.org/closest-prior';
    const card = structuredClone(node.idea_card) as Record<string, unknown>;
    const claims = card.claims as Array<Record<string, unknown>>;
    claims.push({
      claim_text: `Novelty delta vs closest prior (${prior}): engine-owned comparison`,
      support_type: 'literature',
      evidence_uris: [prior],
      verification_status: 'verified',
    });
    const trace = node.operator_trace as Record<string, unknown>;
    const inputs = trace.inputs as Record<string, unknown>;
    inputs.novelty_delta = { closest_prior: prior };
    node.idea_card = card;
    service.read.store.saveNodes(campaignId, nodes);

    const changed = replacementCard(node, 'An ordinary scientific claim changes while reserved provenance remains exact.');
    const altered = structuredClone(changed);
    const alteredClaims = altered.claims as Array<Record<string, unknown>>;
    alteredClaims[alteredClaims.length - 1] = {
      ...alteredClaims[alteredClaims.length - 1],
      confidence: 0.5,
    };
    expectRpcError(
      () =>
        service.handle('node.revise_card', {
          campaign_id: campaignId,
          node_id: nodeId,
          expected_revision: node.revision,
          replacement_idea_card: altered,
          reason: 'attempt reserved claim mutation',
          idempotency_key: 'reserved-fail',
        }),
      -32002,
      'reserved_provenance_claim_changed',
    );
    const success = service.handle('node.revise_card', {
      campaign_id: campaignId,
      node_id: nodeId,
      expected_revision: node.revision,
      replacement_idea_card: changed,
      reason: 'ordinary proposition change',
      idempotency_key: 'reserved-pass',
    });
    expect((success.node as Record<string, unknown>).idea_card).toEqual(changed);
  });
});
