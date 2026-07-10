import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import {
  CONDITION_CARRYING_STATES,
  LIFECYCLE_TRANSITIONS,
  ensureNodeInCampaign,
  lifecycleEntryPreconditionFailure,
  nodeLifecycleReason,
  nodeLifecycleState,
  type NodeLifecycleState,
} from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

/**
 * node.set_lifecycle: move a node through the enforced lifecycle state
 * machine (see LIFECYCLE_TRANSITIONS in node-shared.ts). The requested
 * transition must be legal from the node's current state and must satisfy
 * the target's entry precondition on stored data (posterior presence/status,
 * close-prior coverage). waiting_activation and admission_blocked require an
 * activation_condition; every other target state must not carry one (the
 * stored condition is cleared). archived requires a non-empty reason. The
 * reason is stored on the node as lifecycle_reason and recorded in the
 * mutation log. Does not consume step budget. Allowed in any campaign state
 * except completed.
 */
export function executeNodeSetLifecycle(options: {
  contracts: IdeaEngineContractCatalog;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const nodeId = String(options.params.node_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const targetState = String(options.params.lifecycle_state) as NodeLifecycleState;
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'node.set_lifecycle',
      payloadHash: options.payloadHash,
      store: options.store,
    });
    if (replay) {
      if (replay.kind === 'error') {
        throw new RpcError(-32603, 'internal_error', replay.payload);
      }
      return replay.payload;
    }

    const activationCondition = options.params.activation_condition as Record<string, unknown> | null | undefined;
    const hasActivationCondition = activationCondition !== undefined && activationCondition !== null;
    const targetCarriesCondition = (CONDITION_CARRYING_STATES as readonly string[]).includes(targetState);
    if (targetCarriesCondition && !hasActivationCondition) {
      const data = {
        reason: 'activation_condition_required',
        campaign_id: campaignId,
        node_id: nodeId,
        details: { message: `lifecycle_state=${targetState} requires activation_condition` },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }
    if (!targetCarriesCondition && hasActivationCondition) {
      const data = {
        reason: 'activation_condition_unexpected',
        campaign_id: campaignId,
        node_id: nodeId,
        details: { message: `lifecycle_state=${targetState} must not carry activation_condition` },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }

    const reason = typeof options.params.reason === 'string' && options.params.reason.length > 0
      ? options.params.reason
      : null;
    if (targetState === 'archived' && reason === null) {
      const data = {
        reason: 'archived_reason_required',
        campaign_id: campaignId,
        node_id: nodeId,
        details: { message: 'lifecycle_state=archived requires a non-empty reason (why the idea leaves the pool is part of the record)' },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }

    const campaign = loadCampaignOrError(options.store, campaignId);
    ensureCampaignNotCompleted(campaign);

    const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = ensureNodeInCampaign({
      campaignId,
      contracts: options.contracts,
      nodeId,
      nodes,
    });

    const currentState = nodeLifecycleState(node);
    const allowedNext = LIFECYCLE_TRANSITIONS[currentState];
    if (!allowedNext.includes(targetState)) {
      const data = {
        reason: 'illegal_transition',
        campaign_id: campaignId,
        node_id: nodeId,
        details: {
          current_state: currentState,
          requested_state: targetState,
          allowed_next: [...allowedNext],
          message: `no transition ${currentState} -> ${targetState}; allowed next states from ${currentState}: ${allowedNext.join(', ')}`,
        },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32018, 'lifecycle_transition_invalid', data);
    }

    const preconditionFailure = lifecycleEntryPreconditionFailure(targetState, node);
    if (preconditionFailure) {
      const data = {
        reason: 'entry_precondition_failed',
        campaign_id: campaignId,
        node_id: nodeId,
        details: {
          current_state: currentState,
          requested_state: targetState,
          requirement: preconditionFailure.requirement,
          message: preconditionFailure.message,
        },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32018, 'lifecycle_transition_invalid', data);
    }

    const now = options.now();
    const updatedNode = structuredClone(node);
    updatedNode.lifecycle_state = targetState;
    updatedNode.lifecycle_reason = reason;
    updatedNode.activation_condition = targetCarriesCondition
      ? structuredClone(activationCondition)
      : null;
    updatedNode.revision = Number(updatedNode.revision ?? 0) + 1;
    updatedNode.updated_at = now;
    options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.set_lifecycle/node/${nodeId}`);
    nodes[nodeId] = updatedNode;

    const result = {
      budget_snapshot: budgetSnapshot(campaign),
      campaign_id: campaignId,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      node: {
        activation_condition: (updatedNode.activation_condition as Record<string, unknown> | null) ?? null,
        idea_id: String(updatedNode.idea_id),
        lifecycle_reason: nodeLifecycleReason(updatedNode),
        lifecycle_state: nodeLifecycleState(updatedNode),
        node_id: nodeId,
        posterior: (updatedNode.posterior as Record<string, unknown> | null | undefined) ?? null,
        revision: Number(updatedNode.revision),
        updated_at: now,
      },
    };
    options.contracts.validateResult('node.set_lifecycle', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.set_lifecycle',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.saveNodes(campaignId, nodes);
    options.store.appendNodeLog(campaignId, updatedNode, 'set_lifecycle', reason === null ? undefined : { reason });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.set_lifecycle',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
