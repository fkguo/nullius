import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { canonicalJson, payloadHash as canonicalPayloadHash } from '../hash/payload-hash.js';
import { NodeLogCorruptionError, type IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';
import { RpcError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { NOVELTY_DELTA_CLAIM_PREFIX, ensureNodeInCampaign, nodeLifecycleReason, nodeLifecycleState } from './node-shared.js';
import { toSchemaError } from './service-contract-error.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function revisionValidationError(reason: string, campaignId: string, nodeId: string, message: string, details: Record<string, unknown> = {}): RpcError {
  return new RpcError(-32002, 'schema_validation_failed', {
    reason,
    campaign_id: campaignId,
    node_id: nodeId,
    details: { message, ...details },
  });
}

function cardClaims(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(card.claims) ? card.claims.map(asRecord).filter((claim): claim is Record<string, unknown> => claim !== null) : [];
}

const CARD_REVISION_LIFECYCLE_STATES = ['candidate', 'admission_review', 'admitted', 'needs_refresh'] as const;
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

function replayedRevisionError(payload: Record<string, unknown>, campaignId: string, nodeId: string): RpcError {
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
    details: {
      message: 'stored node.revise_card error response is malformed and cannot be replayed exactly',
    },
  });
}

/**
 * A whole-card replacement must not become a back door around the deliberately
 * narrow node.rewrite_provenance method. Generated nodes carry exactly one
 * engine-owned novelty-delta claim synchronized to operator_trace. revise_card
 * may change every ordinary scientific claim, but must preserve that claim
 * byte-for-byte at the canonical-JSON level. Seed nodes may not mint the
 * reserved prefix themselves.
 */
function ensureReservedProvenanceClaimPreserved(options: {
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
    if (replacementReserved.length === 0) {
      return;
    }
    throw revisionValidationError(
      'reserved_provenance_claim_changed',
      options.campaignId,
      options.nodeId,
      'replacement_idea_card may not introduce the engine-reserved novelty-delta claim; generated-node provenance changes belong to node.rewrite_provenance',
      { replacement_reserved_claim_count: replacementReserved.length },
    );
  }

  const expectedPrefix = `${NOVELTY_DELTA_CLAIM_PREFIX}${closestPrior}): `;
  const currentExact = currentReserved.filter((claim) => String(claim.claim_text).startsWith(expectedPrefix));
  const replacementExact = replacementReserved.filter((claim) => String(claim.claim_text).startsWith(expectedPrefix));
  const preserved =
    currentReserved.length === 1 &&
    replacementReserved.length === 1 &&
    currentExact.length === 1 &&
    replacementExact.length === 1 &&
    canonicalJson(currentExact[0]) === canonicalJson(replacementExact[0]);
  if (!preserved) {
    throw revisionValidationError(
      'reserved_provenance_claim_changed',
      options.campaignId,
      options.nodeId,
      "replacement_idea_card must preserve the generated node's engine-owned novelty-delta claim exactly; use node.rewrite_provenance for the allowlisted provenance correction",
      {
        current_reserved_claim_count: currentReserved.length,
        replacement_reserved_claim_count: replacementReserved.length,
      },
    );
  }
}

/**
 * node.revise_card: optimistic-concurrency replacement of one complete
 * idea_card_v1. A scientific proposition change invalidates every current
 * card-grounding/allocation input: grounding_audit, posterior, its
 * literature_coverage, and any reduction report/audit are removed from latest
 * state and survive only in the prior append-only revision. The node returns
 * to candidate with no activation condition. Blocked, waiting, and archived
 * nodes fail closed: revising a proposition must not silently satisfy their
 * explicit activation/revival conditions.
 */
export function executeNodeReviseCard(options: {
  contracts: IdeaEngineContractCatalog;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);

  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'node.revise_card',
      payloadHash: options.payloadHash,
      store: options.store,
    });
    if (replay) {
      if (replay.kind === 'error') {
        throw replayedRevisionError(replay.payload, campaignId, String(options.params.node_id ?? '00000000'));
      }
      return replay.payload;
    }

    let preparedWritten = false;
    try {
      options.contracts.validateRequestParams('node.revise_card', options.params);
      const nodeId = String(options.params.node_id);
      const expectedRevision = Number(options.params.expected_revision);
      const reason = String(options.params.reason);

      const campaign = loadCampaignOrError(options.store, campaignId);
      ensureCampaignNotCompleted(campaign);

      const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
      const node = ensureNodeInCampaign({
        campaignId,
        contracts: options.contracts,
        nodeId,
        nodes,
      });
      const currentRevision = Number(node.revision);
      if (currentRevision !== expectedRevision) {
        const data = {
          reason: 'stale_revision',
          campaign_id: campaignId,
          node_id: nodeId,
          details: {
            expected_revision: expectedRevision,
            current_revision: currentRevision,
            message: 'expected_revision does not match the current node revision; reload the node and author a new replacement instead of merging implicitly',
          },
        };
        options.contracts.validateErrorData(data);
        throw new RpcError(-32019, 'revision_conflict', data);
      }

      // A new revision may append only to a fully parseable ledger. Unlike
      // prepared-event recovery, a fresh request has no authority to truncate a
      // pre-existing fragment, so even a malformed final segment fails closed.
      try {
        options.store.loadNodeLogEntriesStrict(campaignId);
      } catch (error) {
        if (!(error instanceof NodeLogCorruptionError)) throw error;
        throw new RpcError(-32603, 'internal_error', {
          reason: 'idea_card_revision_recovery_conflict',
          campaign_id: campaignId,
          node_id: nodeId,
          details: {
            message: 'append-only node log is not fully parseable; a fresh card revision cannot repair pre-existing ledger bytes',
            corruption_kind: error.kind,
            line_number: error.lineNumber,
          },
        });
      }
      if (reason.trim().length === 0) {
        throw revisionValidationError('schema_invalid', campaignId, nodeId, 'reason is blank (whitespace only) — an idea-card revision must record why the scientific proposition changed');
      }

      const currentCard = asRecord(node.idea_card);
      if (!currentCard) {
        throw revisionValidationError('idea_card_missing', campaignId, nodeId, 'node.revise_card requires an existing idea_card; it does not create a first card for an unformalized node');
      }
      const replacementCard = structuredClone(options.params.replacement_idea_card) as Record<string, unknown>;
      // The request-param $ref already performs this check. Keep the direct
      // validation at the mutation boundary as the explicit authority lock: a
      // future OpenRPC refactor cannot accidentally turn this into an untyped
      // whole-object write.
      options.contracts.validateAgainstRef('./idea_card_v1.schema.json', replacementCard, `node.revise_card/replacement_idea_card/${nodeId}`);

      const beforeIdeaCardHash = canonicalPayloadHash(currentCard);
      const afterIdeaCardHash = canonicalPayloadHash(replacementCard);
      if (beforeIdeaCardHash === afterIdeaCardHash) {
        throw revisionValidationError(
          'replacement_idea_card_unchanged',
          campaignId,
          nodeId,
          'replacement_idea_card is canonically identical to the current card; use the original idempotency key to replay an earlier revision',
          { idea_card_hash: beforeIdeaCardHash },
        );
      }
      ensureReservedProvenanceClaimPreserved({
        campaignId,
        currentCard,
        node,
        nodeId,
        replacementCard,
      });

      const previousLifecycle = nodeLifecycleState(node);
      if (!(CARD_REVISION_LIFECYCLE_STATES as readonly string[]).includes(previousLifecycle)) {
        const data = {
          reason: 'idea_card_revision_lifecycle_invalid',
          campaign_id: campaignId,
          node_id: nodeId,
          details: {
            current_state: previousLifecycle,
            allowed_states: [...CARD_REVISION_LIFECYCLE_STATES],
            message: 'blocked, waiting, and archived nodes require an explicit lifecycle decision before their scientific proposition may be revised',
          },
        };
        options.contracts.validateErrorData(data);
        throw new RpcError(-32018, 'lifecycle_transition_invalid', data);
      }
      const now = options.now();
      const updatedNode = structuredClone(node);
      updatedNode.idea_card = replacementCard;
      updatedNode.grounding_audit = null;
      updatedNode.posterior = null;
      updatedNode.literature_coverage = null;
      updatedNode.reduction_report = null;
      updatedNode.reduction_audit = null;
      updatedNode.lifecycle_state = 'candidate';
      updatedNode.lifecycle_reason = 'idea_card_revised';
      updatedNode.activation_condition = null;
      updatedNode.revision = currentRevision + 1;
      updatedNode.updated_at = now;
      options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.revise_card/node/${nodeId}`);

      const originalIdempotency = responseIdempotency(idempotencyKeyValue, options.payloadHash);
      const mutationEvent = {
        mutation: 'revise_card',
        campaign_id: campaignId,
        node_id: nodeId,
        idea_id: String(updatedNode.idea_id),
        expected_revision: expectedRevision,
        revision: Number(updatedNode.revision),
        reason,
        before_idea_card_hash: beforeIdeaCardHash,
        after_idea_card_hash: afterIdeaCardHash,
        before_node: structuredClone(node),
        before: {
          revision: currentRevision,
          idea_card: structuredClone(currentCard),
          grounding_audit: structuredClone(node.grounding_audit ?? null),
          posterior: structuredClone(node.posterior ?? null),
          literature_coverage: structuredClone(node.literature_coverage ?? null),
          reduction_report: structuredClone(node.reduction_report ?? null),
          reduction_audit: structuredClone(node.reduction_audit ?? null),
          lifecycle_state: previousLifecycle,
          lifecycle_reason: nodeLifecycleReason(node),
          activation_condition: structuredClone(node.activation_condition ?? null),
          updated_at: typeof node.updated_at === 'string' ? node.updated_at : null,
        },
        invalidations: {
          grounding_audit: node.grounding_audit != null,
          posterior: node.posterior != null,
          literature_coverage: node.literature_coverage != null,
          reduction_report: node.reduction_report != null,
          reduction_audit: node.reduction_audit != null,
          activation_condition: node.activation_condition != null,
          allocation_eligibility: true,
        },
        occurred_at: now,
        idempotency: structuredClone(originalIdempotency),
        node: structuredClone(updatedNode),
      };
      options.contracts.validateAgainstRef('./idea_card_revision_event_v1.schema.json', mutationEvent, `node.revise_card/mutation_event/${nodeId}`);

      const result = {
        budget_snapshot: budgetSnapshot(campaign),
        campaign_id: campaignId,
        idempotency: originalIdempotency,
        mutation_event: mutationEvent,
        node: updatedNode,
      };
      options.contracts.validateResult('node.revise_card', result);

      // The prepared record embeds the complete resulting node and exact event.
      // recordOrReplay uses them to complete either missing side after a crash;
      // it never regenerates card content or hashes.
      storeIdempotency({
        campaignId,
        createdAt: now,
        idempotencyKeyValue,
        kind: 'result',
        method: 'node.revise_card',
        payload: result,
        payloadHash: options.payloadHash,
        state: 'prepared',
        store: options.store,
      });
      preparedWritten = true;

      nodes[nodeId] = updatedNode;
      options.store.saveNodes(campaignId, nodes);
      options.store.appendNodeLogEntry(campaignId, mutationEvent);

      storeIdempotency({
        campaignId,
        createdAt: now,
        idempotencyKeyValue,
        kind: 'result',
        method: 'node.revise_card',
        payload: result,
        payloadHash: options.payloadHash,
        state: 'committed',
        store: options.store,
      });
      return result;
    } catch (error) {
      const rpcError = toSchemaError(error);
      if (!preparedWritten) {
        options.contracts.validateErrorData(rpcError.data);
        storeIdempotency({
          campaignId,
          createdAt: options.now(),
          idempotencyKeyValue,
          kind: 'error',
          method: 'node.revise_card',
          payload: {
            code: rpcError.code,
            message: rpcError.message,
            data: structuredClone(rpcError.data),
          },
          payloadHash: options.payloadHash,
          state: 'committed',
          store: options.store,
        });
      }
      throw rpcError;
    }
  });
}
