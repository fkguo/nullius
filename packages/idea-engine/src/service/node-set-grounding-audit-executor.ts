import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import {
  POSTERIOR_WRITE_STATES,
  ensureNodeInCampaign,
  nodeLifecycleReason,
  nodeLifecycleState,
} from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

/**
 * node.set_grounding_audit: record the result of an independently produced
 * grounding check onto the node — the only sanctioned write path for
 * grounding_audit (a direct store edit is not). The check itself happens
 * outside the engine (statement-support verification of the idea card's
 * cited claims); the engine stores the result with the report_ref naming the
 * grounding record it summarizes, stamps the timestamp, increments the node
 * revision, and appends to the mutation log. Legal only in the same review
 * window as posterior writes (admission_review, admitted, needs_refresh).
 * Does not derive lifecycle: a failing audit is recorded as data, and any
 * consequent transition is an explicit node.set_lifecycle decision. Does not
 * consume step budget. Allowed in any campaign state except completed.
 */
export function executeNodeSetGroundingAudit(options: {
  contracts: IdeaEngineContractCatalog;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const nodeId = String(options.params.node_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'node.set_grounding_audit',
      payloadHash: options.payloadHash,
      store: options.store,
    });
    if (replay) {
      if (replay.kind === 'error') {
        throw new RpcError(-32603, 'internal_error', replay.payload);
      }
      return replay.payload;
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

    const currentLifecycle = nodeLifecycleState(node);
    if (!(POSTERIOR_WRITE_STATES as readonly string[]).includes(currentLifecycle)) {
      const data = {
        reason: 'grounding_audit_write_lifecycle_invalid',
        campaign_id: campaignId,
        node_id: nodeId,
        details: {
          current_state: currentLifecycle,
          allowed_states: [...POSTERIOR_WRITE_STATES],
          message: currentLifecycle === 'candidate'
            ? 'a candidate must enter admission_review via node.set_lifecycle before a grounding-audit write (the audit is admission evidence and its review deserves a logged start)'
            : `grounding-audit writes are legal only in ${POSTERIOR_WRITE_STATES.join(', ')}; move the node out of ${currentLifecycle} first`,
        },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32018, 'lifecycle_transition_invalid', data);
    }

    const auditParams = options.params.grounding_audit as Record<string, unknown>;
    // The params schema enforces report_ref minLength 1, but a whitespace-only
    // value slips through and would promote without a usable reference to the
    // independent-verification record it is supposed to name. report_ref is the
    // whole point of the mandatory field, so a blank one is rejected.
    const reportRef = String(auditParams.report_ref);
    if (reportRef.trim().length === 0) {
      const data = {
        reason: 'schema_invalid',
        campaign_id: campaignId,
        node_id: nodeId,
        details: { message: 'grounding_audit.report_ref is blank (whitespace only) — it must name the independent grounding record this audit summarizes' },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }
    const now = options.now();
    const groundingAudit: Record<string, unknown> = {
      status: String(auditParams.status),
      folklore_risk_score: Number(auditParams.folklore_risk_score),
      failures: (auditParams.failures as unknown[]).map(String),
      timestamp: now,
      report_ref: reportRef,
    };

    const updatedNode = structuredClone(node);
    updatedNode.grounding_audit = groundingAudit;
    updatedNode.revision = Number(updatedNode.revision ?? 0) + 1;
    updatedNode.updated_at = now;
    options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.set_grounding_audit/node/${nodeId}`);
    nodes[nodeId] = updatedNode;

    const result = {
      budget_snapshot: budgetSnapshot(campaign),
      campaign_id: campaignId,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      node: {
        activation_condition: (updatedNode.activation_condition as Record<string, unknown> | null | undefined) ?? null,
        grounding_audit: groundingAudit,
        idea_id: String(updatedNode.idea_id),
        lifecycle_reason: nodeLifecycleReason(updatedNode),
        lifecycle_state: nodeLifecycleState(updatedNode),
        node_id: nodeId,
        posterior: (updatedNode.posterior as Record<string, unknown> | null | undefined) ?? null,
        revision: Number(updatedNode.revision),
        updated_at: now,
      },
    };
    options.contracts.validateResult('node.set_grounding_audit', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.set_grounding_audit',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.saveNodes(campaignId, nodes);
    options.store.appendNodeLog(campaignId, updatedNode, 'set_grounding_audit', {
      report_ref: String(auditParams.report_ref),
    });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.set_grounding_audit',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
