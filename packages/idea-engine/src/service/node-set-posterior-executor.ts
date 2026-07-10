import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError, schemaValidationError } from './errors.js';
import {
  POSTERIOR_WRITE_STATES,
  ensureNodeInCampaign,
  nodeLifecycleReason,
  nodeLifecycleState,
} from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

/**
 * node.set_posterior: record the externally computed belief-graph posterior
 * for a node. The posterior is produced outside the engine (pinned external
 * belief-graph tool); the engine only stores it, stamps updated_at,
 * increments the node revision, and appends to the mutation log. Legal only
 * while the node is in admission_review, admitted, or needs_refresh (a
 * candidate must first declare admission_review; blocked/waiting/archived
 * nodes must be transitioned out first). After the write the engine derives
 * the lifecycle itself: status current -> admitted, otherwise needs_refresh —
 * the single-writer rule that keeps lifecycle and posterior consistent. Does
 * not consume step budget. Allowed in any campaign state except completed.
 */
export function executeNodeSetPosterior(options: {
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
      method: 'node.set_posterior',
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
        reason: 'posterior_write_lifecycle_invalid',
        campaign_id: campaignId,
        node_id: nodeId,
        details: {
          current_state: currentLifecycle,
          allowed_states: [...POSTERIOR_WRITE_STATES],
          message: currentLifecycle === 'candidate'
            ? 'a candidate must enter admission_review via node.set_lifecycle before any posterior write (declaring the review gives admission a logged start)'
            : `posterior writes are legal only in ${POSTERIOR_WRITE_STATES.join(', ')}; move the node out of ${currentLifecycle} first`,
        },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32018, 'lifecycle_transition_invalid', data);
    }

    const posteriorParams = options.params.posterior as Record<string, unknown>;
    const literatureCoverageParams = options.params.literature_coverage as Record<string, unknown>;
    const now = options.now();
    const coverageStatus = literatureCoverageParams.status === 'saturated' || literatureCoverageParams.status === 'coverage_incomplete'
      ? literatureCoverageParams.status
      : 'metadata_only';
    if (coverageStatus === 'metadata_only') {
      throw schemaValidationError('node.set_posterior requires source-first close-prior literature coverage, not metadata_only', {
        campaign_id: campaignId,
        node_id: nodeId,
      });
    }
    const hasRefs = typeof literatureCoverageParams.survey_ref === 'string' && literatureCoverageParams.survey_ref.trim().length > 0
      && typeof literatureCoverageParams.close_prior_matrix_ref === 'string' && literatureCoverageParams.close_prior_matrix_ref.trim().length > 0;
    if (!hasRefs) {
      throw schemaValidationError('node.set_posterior requires survey_ref and close_prior_matrix_ref for close-prior literature coverage', {
        campaign_id: campaignId,
        node_id: nodeId,
      });
    }
    const coverageSupportsCurrent = coverageStatus === 'saturated' || literatureCoverageParams.exploratory_allocation === true;
    const resolvedStatus = typeof posteriorParams.status === 'string'
      ? posteriorParams.status
      : (coverageSupportsCurrent ? 'current' : 'provisional');
    if (resolvedStatus === 'current' && !coverageSupportsCurrent) {
      const data = {
        reason: 'posterior_status_not_supported_by_coverage',
        campaign_id: campaignId,
        node_id: nodeId,
        details: {
          coverage_status: coverageStatus,
          message: 'posterior.status=current requires saturated coverage or the explicit exploratory waiver on coverage_incomplete; write provisional instead',
        },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }
    const posterior: Record<string, unknown> = {
      value: Number(posteriorParams.value),
      evidence_count: Number(posteriorParams.evidence_count),
      updated_at: now,
      status: resolvedStatus,
    };
    if (typeof posteriorParams.gaia_package_ref === 'string' && posteriorParams.gaia_package_ref.length > 0) {
      posterior.gaia_package_ref = posteriorParams.gaia_package_ref;
    }
    const literatureCoverage: Record<string, unknown> = {
      status: coverageStatus,
    };
    for (const key of ['survey_ref', 'close_prior_matrix_ref', 'exploratory_allocation'] as const) {
      if (literatureCoverageParams[key] !== undefined) {
        literatureCoverage[key] = literatureCoverageParams[key];
      }
    }

    const derivedLifecycle = resolvedStatus === 'current' ? 'admitted' : 'needs_refresh';
    const updatedNode = structuredClone(node);
    updatedNode.posterior = posterior;
    updatedNode.literature_coverage = literatureCoverage;
    if (currentLifecycle !== derivedLifecycle) {
      updatedNode.lifecycle_state = derivedLifecycle;
      updatedNode.lifecycle_reason = `posterior_status=${resolvedStatus}`;
    }
    updatedNode.revision = Number(updatedNode.revision ?? 0) + 1;
    updatedNode.updated_at = now;
    options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.set_posterior/node/${nodeId}`);
    nodes[nodeId] = updatedNode;

    const result = {
      budget_snapshot: budgetSnapshot(campaign),
      campaign_id: campaignId,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      node: {
        activation_condition: (updatedNode.activation_condition as Record<string, unknown> | null | undefined) ?? null,
        idea_id: String(updatedNode.idea_id),
        lifecycle_reason: nodeLifecycleReason(updatedNode),
        lifecycle_state: nodeLifecycleState(updatedNode),
        literature_coverage: literatureCoverage,
        node_id: nodeId,
        posterior,
        revision: Number(updatedNode.revision),
        updated_at: now,
      },
    };
    options.contracts.validateResult('node.set_posterior', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.set_posterior',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.saveNodes(campaignId, nodes);
    options.store.appendNodeLog(campaignId, updatedNode, 'set_posterior');

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.set_posterior',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
