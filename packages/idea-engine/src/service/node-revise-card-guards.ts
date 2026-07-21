import { RpcError } from './errors.js';
import { NOVELTY_DELTA_CLAIM_DELIMITER, NOVELTY_DELTA_CLAIM_PREFIX } from './node-shared.js';

export const CARD_REVISION_LIFECYCLE_STATES = ['candidate', 'admission_review', 'admitted', 'needs_refresh'] as const;

const REVISION_ERROR_MESSAGES = new Map<number, string>([
  [-32603, 'internal_error'],
  [-32019, 'revision_conflict'],
  [-32018, 'lifecycle_transition_invalid'],
  [-32015, 'campaign_not_active'],
  [-32014, 'node_not_in_campaign'],
  [-32004, 'node_not_found'],
  [-32003, 'campaign_not_found'],
  [-32002, 'schema_validation_failed'],
]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function revisionValidationError(reason: string, campaignId: string, nodeId: string, message: string, details: Record<string, unknown> = {}): RpcError {
  return new RpcError(-32002, 'schema_validation_failed', {
    reason,
    campaign_id: campaignId,
    node_id: nodeId,
    details: { message, ...details },
  });
}

export function replayedRevisionError(payload: Record<string, unknown>, campaignId: string, nodeId: string): RpcError {
  const code = payload.code;
  const message = payload.message;
  const data = asRecord(payload.data);
  if (typeof code === 'number' && Number.isInteger(code) && typeof message === 'string' && REVISION_ERROR_MESSAGES.get(code) === message && data) {
    return RpcError.fromStored(code, message, data);
  }
  return new RpcError(-32603, 'internal_error', {
    reason: 'idea_card_revision_recovery_conflict',
    campaign_id: campaignId,
    node_id: nodeId,
    details: { message: 'stored node.revise_card error response is malformed and cannot be replayed exactly' },
  });
}

function cardClaims(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(card.claims) ? card.claims.map(asRecord).filter((claim): claim is Record<string, unknown> => claim !== null) : [];
}

/** Keep reserved claim identity coherent without freezing its scientific content. */
export function ensureReservedProvenanceClaimCoherent(options: {
  campaignId: string;
  currentCard: Record<string, unknown>;
  node: Record<string, unknown>;
  nodeId: string;
  replacementCard: Record<string, unknown>;
}): void {
  const operatorTrace = asRecord(options.node.operator_trace);
  const inputs = asRecord(operatorTrace?.inputs);
  const noveltyDelta = asRecord(inputs?.novelty_delta);
  const closestPrior = noveltyDelta?.closest_prior;
  const currentReserved = cardClaims(options.currentCard).filter((claim) => typeof claim.claim_text === 'string' && claim.claim_text.startsWith(NOVELTY_DELTA_CLAIM_PREFIX));
  const replacementReserved = cardClaims(options.replacementCard).filter((claim) => typeof claim.claim_text === 'string' && claim.claim_text.startsWith(NOVELTY_DELTA_CLAIM_PREFIX));

  if (typeof closestPrior !== 'string' || closestPrior.length === 0) {
    if (replacementReserved.length === 0) return;
    throw revisionValidationError(
      'reserved_provenance_claim_changed',
      options.campaignId,
      options.nodeId,
      'replacement_idea_card may not carry the engine-reserved novelty-delta prefix on a node with no recorded novelty_delta.closest_prior; generated-node provenance changes belong to node.rewrite_provenance',
      { replacement_reserved_claim_count: replacementReserved.length },
    );
  }

  // A scientific card revision may withdraw the generated hypothesis or
  // replace it with an ordinary claim. The generation-time record stays pinned
  // in the archived pack, while the append-only before-node event preserves the
  // prior card and trace. The reserved prefix itself may only descend from the
  // claim assembled at import: once withdrawn, a later revision cannot forge a
  // new engine-looking claim.
  if (replacementReserved.length === 0) return;
  if (currentReserved.length === 0) {
    throw revisionValidationError(
      'reserved_provenance_claim_changed',
      options.campaignId,
      options.nodeId,
      'replacement_idea_card may not introduce the engine-reserved novelty-delta prefix; it identifies a claim assembled at import and may only be retained, revised, or withdrawn',
      {
        current_reserved_claim_count: currentReserved.length,
        replacement_reserved_claim_count: replacementReserved.length,
      },
    );
  }
  const expectedPrefix = `${NOVELTY_DELTA_CLAIM_PREFIX}${closestPrior}${NOVELTY_DELTA_CLAIM_DELIMITER}`;
  const replacementExact = replacementReserved.filter((claim) => String(claim.claim_text).startsWith(expectedPrefix));
  if (replacementReserved.length === 1 && replacementExact.length === 1) return;
  throw revisionValidationError(
    'reserved_provenance_claim_changed',
    options.campaignId,
    options.nodeId,
    "a retained engine-reserved novelty-delta claim must be unique and use the closest_prior identity stored in operator_trace; withdraw or replace the scientific claim through node.revise_card, and use node.rewrite_provenance only to correct the provenance identity",
    {
      current_reserved_claim_count: currentReserved.length,
      replacement_reserved_claim_count: replacementReserved.length,
    },
  );
}
