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

  it('lets reviewed cards retain, falsify, withdraw, or replace a generated novelty claim without changing origin provenance', () => {
    const variants = ['retained', 'falsified', 'withdrawn', 'replaced'] as const;
    for (const variant of variants) {
      const { service } = fresh(tempDirs, `idea-revise-provenance-${variant}-`);
      const { campaignId, nodeId } = initCampaign(service, `init-${variant}`);
      const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
      const node = nodes[nodeId]!;
      const prior = 'https://example.org/closest-prior';
      const card = structuredClone(node.idea_card) as Record<string, unknown>;
      const claims = card.claims as Array<Record<string, unknown>>;
      claims.push({
        claim_text: `Novelty delta vs closest prior (${prior}): generated hypothesis under review`,
        support_type: 'literature',
        evidence_uris: [prior],
        verification_status: 'verified',
      });
      const trace = node.operator_trace as Record<string, unknown>;
      const inputs = trace.inputs as Record<string, unknown>;
      inputs.novelty_delta = { closest_prior: prior };
      node.idea_card = card;
      service.read.store.saveNodes(campaignId, nodes);

      const changed = replacementCard(node, `A reviewed scientific proposition for the ${variant} case.`);
      const changedClaims = changed.claims as Array<Record<string, unknown>>;
      const reservedIndex = changedClaims.length - 1;
      if (variant === 'falsified') {
        changedClaims[reservedIndex] = {
          ...changedClaims[reservedIndex],
          claim_text: `Novelty delta vs closest prior (${prior}): the generated hypothesis failed its declared test`,
          verification_status: 'falsified',
          verification_notes: 'The current evidence rejects the generated hypothesis.',
        };
      } else if (variant === 'withdrawn' || variant === 'replaced') {
        changedClaims.splice(reservedIndex, 1);
        if (variant === 'replaced') {
          changedClaims.push({
            claim_text: 'A narrower evidence-responsive proposition replaces the generated hypothesis.',
            support_type: 'assumption',
            evidence_uris: [],
            verification_plan: 'Test the narrower proposition before admission.',
            verification_status: 'unverified',
          });
        }
      }

      const success = service.handle('node.revise_card', {
        campaign_id: campaignId,
        node_id: nodeId,
        expected_revision: node.revision,
        replacement_idea_card: changed,
        reason: `evidence-responsive ${variant} revision`,
        idempotency_key: `reserved-${variant}`,
      });
      const updated = success.node as Record<string, unknown>;
      expect(updated.idea_card).toEqual(changed);
      const updatedInputs = ((updated.operator_trace as Record<string, unknown>).inputs as Record<string, unknown>);
      expect((updatedInputs.novelty_delta as Record<string, unknown>).closest_prior).toBe(prior);
      const event = success.mutation_event as Record<string, unknown>;
      expect(((event.before_node as Record<string, unknown>).operator_trace as Record<string, unknown>)).toEqual(trace);
    }
  });

  it('rejects reserved-prefix impersonation, closest-prior drift, and duplicate reserved claims', () => {
    const { service } = fresh(tempDirs, 'idea-revise-reserved-conflicts-');
    const { campaignId, nodeId } = initCampaign(service);
    const seed = currentNode(service, campaignId, nodeId);
    const introduced = replacementCard(seed, 'A seed-card revision must not impersonate generated provenance.');
    (introduced.claims as Array<Record<string, unknown>>).push({
      claim_text: 'Novelty delta vs closest prior (ref-a): unauthorized reserved claim',
      support_type: 'assumption',
      evidence_uris: [],
      verification_plan: 'This claim must be rejected before any verification.',
    });
    expectRpcError(
      () => service.handle('node.revise_card', {
        ...reviseParams(campaignId, nodeId, seed, 'reserved-introduced'),
        replacement_idea_card: introduced,
      }),
      -32002,
      'reserved_provenance_claim_changed',
    );

    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId]!;
    const prior = 'ref-a';
    const generatedCard = structuredClone(node.idea_card) as Record<string, unknown>;
    (generatedCard.claims as Array<Record<string, unknown>>).push({
      claim_text: `Novelty delta vs closest prior (${prior}): generated hypothesis`,
      support_type: 'assumption',
      evidence_uris: [],
      verification_plan: 'Test the generated hypothesis.',
    });
    const generatedTrace = node.operator_trace as Record<string, unknown>;
    const generatedInputs = generatedTrace.inputs as Record<string, unknown>;
    generatedInputs.novelty_delta = { closest_prior: prior };
    node.idea_card = generatedCard;
    service.read.store.saveNodes(campaignId, nodes);

    const drifted = replacementCard(node, 'A revision with a mismatched reserved prior must fail.');
    const driftedClaims = drifted.claims as Array<Record<string, unknown>>;
    driftedClaims[driftedClaims.length - 1] = {
      ...driftedClaims[driftedClaims.length - 1],
      claim_text: 'Novelty delta vs closest prior (ref-b): changed without provenance rewrite',
    };
    expectRpcError(
      () => service.handle('node.revise_card', {
        ...reviseParams(campaignId, nodeId, node, 'reserved-drifted'),
        replacement_idea_card: drifted,
      }),
      -32002,
      'reserved_provenance_claim_changed',
    );

    const duplicated = replacementCard(node, 'A revision with duplicate reserved claims must fail.');
    const duplicatedClaims = duplicated.claims as Array<Record<string, unknown>>;
    duplicatedClaims.push(structuredClone(duplicatedClaims[duplicatedClaims.length - 1]!));
    expectRpcError(
      () => service.handle('node.revise_card', {
        ...reviseParams(campaignId, nodeId, node, 'reserved-duplicated'),
        replacement_idea_card: duplicated,
      }),
      -32002,
      'reserved_provenance_claim_changed',
    );
  });

  it('rejects recreation of the engine-reserved prefix after a reviewed withdrawal', () => {
    const { service } = fresh(tempDirs, 'idea-revise-reserved-recreation-');
    const { campaignId, nodeId } = initCampaign(service);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId]!;
    const prior = 'ref-a';
    const generatedCard = structuredClone(node.idea_card) as Record<string, unknown>;
    (generatedCard.claims as Array<Record<string, unknown>>).push({
      claim_text: `Novelty delta vs closest prior (${prior}): generated hypothesis`,
      support_type: 'assumption',
      evidence_uris: [],
      verification_plan: 'Test the generated hypothesis.',
    });
    const trace = node.operator_trace as Record<string, unknown>;
    (trace.inputs as Record<string, unknown>).novelty_delta = { closest_prior: prior };
    node.idea_card = generatedCard;
    service.read.store.saveNodes(campaignId, nodes);

    const withdrawn = replacementCard(node, 'Reviewed evidence withdraws the generated hypothesis.');
    withdrawn.claims = (withdrawn.claims as Array<Record<string, unknown>>).filter(
      claim => !String(claim.claim_text).startsWith('Novelty delta vs closest prior ('),
    );
    service.handle('node.revise_card', {
      ...reviseParams(campaignId, nodeId, node, 'reserved-withdrawn'),
      replacement_idea_card: withdrawn,
    });

    const afterWithdrawal = currentNode(service, campaignId, nodeId);
    const ordinaryRevision = replacementCard(afterWithdrawal, 'A later ordinary revision keeps the reviewed withdrawal in force.');
    const ordinaryResult = service.handle('node.revise_card', {
      ...reviseParams(campaignId, nodeId, afterWithdrawal, 'ordinary-after-withdrawal'),
      replacement_idea_card: ordinaryRevision,
    });
    expect((ordinaryResult.node as Record<string, unknown>).idea_card).toEqual(ordinaryRevision);

    const afterOrdinaryRevision = currentNode(service, campaignId, nodeId);
    const reintroduced = replacementCard(afterOrdinaryRevision, 'A later revision attempts to forge an engine-looking claim.');
    (reintroduced.claims as Array<Record<string, unknown>>).push({
      claim_text: `Novelty delta vs closest prior (${prior}): manually recreated claim`,
      support_type: 'assumption',
      evidence_uris: [],
      verification_plan: 'This claim must be rejected before review.',
    });
    const beforeRejectedWrite = JSON.stringify(afterOrdinaryRevision);
    expectRpcError(
      () => service.handle('node.revise_card', {
        ...reviseParams(campaignId, nodeId, afterOrdinaryRevision, 'reserved-reintroduced'),
        replacement_idea_card: reintroduced,
      }),
      -32002,
      'reserved_provenance_claim_changed',
    );
    expect(JSON.stringify(currentNode(service, campaignId, nodeId))).toBe(beforeRejectedWrite);
  });

  it('repairs an out-of-contract retained claim identity without changing trace provenance', () => {
    const { service } = fresh(tempDirs, 'idea-revise-reserved-repair-');
    const { campaignId, nodeId } = initCampaign(service);
    const nodes = service.read.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId]!;
    const prior = 'ref-a';
    const card = structuredClone(node.idea_card) as Record<string, unknown>;
    (card.claims as Array<Record<string, unknown>>).push({
      claim_text: 'Novelty delta vs closest prior (wrong-ref): malformed retained claim',
      support_type: 'assumption',
      evidence_uris: [],
      verification_plan: 'Repair the card identity before review.',
    });
    const trace = node.operator_trace as Record<string, unknown>;
    (trace.inputs as Record<string, unknown>).novelty_delta = { closest_prior: prior };
    node.idea_card = card;
    service.read.store.saveNodes(campaignId, nodes);

    const repaired = replacementCard(node, 'The retained claim identity is repaired against the unchanged trace.');
    const repairedClaims = repaired.claims as Array<Record<string, unknown>>;
    repairedClaims[repairedClaims.length - 1] = {
      ...repairedClaims[repairedClaims.length - 1],
      claim_text: `Novelty delta vs closest prior (${prior}): repaired retained claim`,
    };
    const result = service.handle('node.revise_card', {
      ...reviseParams(campaignId, nodeId, node, 'reserved-identity-repair'),
      replacement_idea_card: repaired,
    });
    expect((result.node as Record<string, unknown>).idea_card).toEqual(repaired);
    expect(((result.node as Record<string, unknown>).operator_trace as Record<string, unknown>)).toEqual(trace);
  });
});
