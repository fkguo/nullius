import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { pathToFileURL } from 'url';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { deterministicScore, ensureNodeInCampaign } from './post-search-shared.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './search-step-campaign.js';

export function executeEvalRun(options: {
  contracts: IdeaEngineContractCatalog;
  createId: () => string;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const evaluatorConfig = options.params.evaluator_config as Record<string, unknown>;
  const dimensions = (evaluatorConfig.dimensions as unknown[]).map(value => String(value));
  const nReviewers = Number(evaluatorConfig.n_reviewers);
  const nodeIds = (options.params.node_ids as unknown[]).map(value => String(value));
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'eval.run',
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
    ensureCampaignRunning(campaign);

    const now = options.now();
    const updatedNodes = structuredClone(options.store.loadNodes<Record<string, unknown>>(campaignId));
    const nodeRevisions: Record<string, number> = {};
    const scorecards: Array<Record<string, unknown>> = [];
    for (const nodeId of nodeIds) {
      const node = ensureNodeInCampaign({
        campaignId,
        contracts: options.contracts,
        nodeId,
        nodes: updatedNodes,
      });
      const scores: Record<string, number> = {};
      for (const dimension of dimensions) {
        scores[dimension] = deterministicScore(nodeId, dimension);
      }
      node.eval_info = {
        failure_modes: [],
        fix_suggestions: [],
        scores: structuredClone(scores),
      };
      if (dimensions.includes('grounding')) {
        node.grounding_audit = {
          failures: [],
          folklore_risk_score: 0.2,
          status: 'pass',
          timestamp: now,
        };
      }
      node.revision = Number(node.revision ?? 0) + 1;
      node.updated_at = now;
      nodeRevisions[nodeId] = Number(node.revision);
      options.contracts.validateAgainstRef('./idea_node_v1.schema.json', node, `eval.run/node/${nodeId}`);
      scorecards.push({
        failure_modes: [],
        fix_suggestions: [],
        node_id: nodeId,
        reviewer_count: nReviewers,
        scores,
        status: 'complete',
      });
    }

    const scorecardsPayload = {
      campaign_id: campaignId,
      evaluator_config: evaluatorConfig,
      generated_at: now,
      scorecards,
    };
    options.contracts.validateAgainstRef(
      './idea_scorecards_v1.schema.json',
      scorecardsPayload,
      `eval.run/scorecards/${campaignId}`,
    );

    const scorecardsArtifactName = `scorecards-${options.createId()}.json`;
    const scorecardsArtifactRef = pathToFileURL(
      options.store.artifactPath(campaignId, 'scorecards', scorecardsArtifactName),
    ).href;

    const plannedCampaign = structuredClone(campaign);
    plannedCampaign.last_scorecards_artifact_ref = scorecardsArtifactRef;
    plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
    setCampaignRunningIfBudgetAvailable(plannedCampaign);

    const result = {
      budget_snapshot: budgetSnapshot(plannedCampaign),
      campaign_id: campaignId,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      node_ids: nodeIds,
      node_revisions: nodeRevisions,
      scorecards_artifact_ref: scorecardsArtifactRef,
      updated_node_ids: nodeIds,
    };
    options.contracts.validateResult('eval.run', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'eval.run',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.writeArtifact(campaignId, 'scorecards', scorecardsArtifactName, scorecardsPayload);
    options.store.saveNodes(campaignId, updatedNodes);
    for (const nodeId of nodeIds) {
      options.store.appendNodeLog(campaignId, updatedNodes[nodeId]!, 'eval.update');
    }
    options.store.saveCampaign(plannedCampaign as Record<string, unknown> & { campaign_id: string });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'eval.run',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });

    return result;
  });
}
