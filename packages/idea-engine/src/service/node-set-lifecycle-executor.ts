import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { ensureNodeInCampaign, nodeLifecycleState } from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

/**
 * node.set_lifecycle: move a node between active / waiting_activation /
 * archived. waiting_activation requires an activation_condition; the other
 * states must not carry one (the stored condition is cleared on leaving
 * waiting_activation). An optional reason is recorded in the mutation log.
 * Does not consume step budget. Allowed in any campaign state except
 * completed.
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
  const lifecycleState = String(options.params.lifecycle_state);
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
    if (lifecycleState === 'waiting_activation' && !hasActivationCondition) {
      throw new RpcError(-32002, 'schema_validation_failed', {
        reason: 'activation_condition_required',
        campaign_id: campaignId,
        node_id: nodeId,
        details: { message: 'lifecycle_state=waiting_activation requires activation_condition' },
      });
    }
    if (lifecycleState !== 'waiting_activation' && hasActivationCondition) {
      throw new RpcError(-32002, 'schema_validation_failed', {
        reason: 'activation_condition_unexpected',
        campaign_id: campaignId,
        node_id: nodeId,
        details: { message: `lifecycle_state=${lifecycleState} must not carry activation_condition` },
      });
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

    const now = options.now();
    const updatedNode = structuredClone(node);
    updatedNode.lifecycle_state = lifecycleState;
    updatedNode.activation_condition = lifecycleState === 'waiting_activation'
      ? structuredClone(activationCondition)
      : null;
    updatedNode.revision = Number(updatedNode.revision ?? 0) + 1;
    updatedNode.updated_at = now;
    options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.set_lifecycle/node/${nodeId}`);
    nodes[nodeId] = updatedNode;

    const reason = typeof options.params.reason === 'string' && options.params.reason.length > 0
      ? options.params.reason
      : null;

    const result = {
      budget_snapshot: budgetSnapshot(campaign),
      campaign_id: campaignId,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      node: {
        activation_condition: (updatedNode.activation_condition as Record<string, unknown> | null) ?? null,
        idea_id: String(updatedNode.idea_id),
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
