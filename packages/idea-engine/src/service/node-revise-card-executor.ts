import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { payloadHash as canonicalPayloadHash } from '../hash/payload-hash.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { NodeLogCorruptionError } from '../store/node-log-store.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';
import { RpcError } from './errors.js';
import { recordOrReplay, storeIdempotency } from './idempotency.js';
import {
  CARD_REVISION_LIFECYCLE_STATES,
  asRecord,
  ensureReservedProvenanceClaimCoherent,
  replayedRevisionError,
  revisionValidationError,
} from './node-revise-card-guards.js';
import { planIdeaCardRevision } from './node-revise-card-plan.js';
import { ensureNodeInCampaign, nodeLifecycleState } from './node-shared.js';
import { toSchemaError } from './service-contract-error.js';

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
      ensureReservedProvenanceClaimCoherent({
        campaignId,
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
      const { mutationEvent, now, result, updatedNode } = planIdeaCardRevision({
        afterIdeaCardHash,
        beforeIdeaCardHash,
        campaign,
        campaignId,
        contracts: options.contracts,
        currentCard,
        currentRevision,
        expectedRevision,
        idempotencyKey: idempotencyKeyValue,
        node,
        nodeId,
        now: options.now(),
        payloadHash: options.payloadHash,
        previousLifecycle,
        reason,
        replacementCard,
      });

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
