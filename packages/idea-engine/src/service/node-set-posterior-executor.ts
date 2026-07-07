import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError, schemaValidationError } from './errors.js';
import { ensureNodeInCampaign, nodeLifecycleState } from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

/**
 * node.set_posterior: record the externally computed belief-graph posterior
 * for a node. The posterior is produced outside the engine (pinned external
 * belief-graph tool); the engine only stores it, stamps updated_at,
 * increments the node revision, and appends to the mutation log. Does not
 * consume step budget. Allowed in any campaign state except completed.
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
    const posterior: Record<string, unknown> = {
      value: Number(posteriorParams.value),
      evidence_count: Number(posteriorParams.evidence_count),
      updated_at: now,
      status: typeof posteriorParams.status === 'string'
        ? posteriorParams.status
        : (coverageStatus === 'saturated' || literatureCoverageParams.exploratory_allocation === true ? 'current' : 'provisional'),
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

    const updatedNode = structuredClone(node);
    updatedNode.posterior = posterior;
    updatedNode.literature_coverage = literatureCoverage;
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
