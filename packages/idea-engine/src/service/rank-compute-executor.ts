import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { pathToFileURL } from 'url';
import { budgetSnapshot } from './budget-snapshot.js';
import { filterNodes, type NodeListFilter, type NodeRecord } from './filter-nodes.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError, schemaValidationError } from './errors.js';
import { orderedDimensions } from './post-search-shared.js';
import { insufficientEvalDataError, scorecardIndex } from './rank-compute-helpers.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './search-step-campaign.js';

export function executeRankCompute(options: {
  contracts: IdeaEngineContractCatalog;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const method = String(options.params.method);
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'rank.compute',
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

    const eloConfig = options.params.elo_config;
    if (method === 'elo' && (eloConfig === undefined || eloConfig === null)) {
      const data = { campaign_id: campaignId, reason: 'elo_config_required' };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }
    if (method === 'pareto' && eloConfig !== undefined && eloConfig !== null) {
      const data = { campaign_id: campaignId, reason: 'elo_config_unexpected' };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32002, 'schema_validation_failed', data);
    }

    const rawScorecardsRef = options.params.scorecards_artifact_ref ?? campaign.last_scorecards_artifact_ref;
    if (typeof rawScorecardsRef !== 'string' || rawScorecardsRef.length === 0) {
      throw insufficientEvalDataError({ campaignId, contracts: options.contracts, reason: 'no_scorecards' });
    }
    let scorecardsPayload: Record<string, unknown>;
    try {
      scorecardsPayload = options.store.loadArtifactFromRef<Record<string, unknown>>(rawScorecardsRef);
    } catch {
      throw schemaValidationError('scorecards_artifact_ref not resolvable', { campaign_id: campaignId });
    }

    const nodes = options.store.loadNodes<NodeRecord>(campaignId);
    const resolvedNodes = filterNodes(nodes, options.params.filter as NodeListFilter | undefined);
    const nodeIds = new Set(resolvedNodes.map(node => String(node.node_id)));
    const scorecardsByNodeId = scorecardIndex(scorecardsPayload);
    const resolvedScorecards = [...nodeIds]
      .filter(nodeId => nodeId in scorecardsByNodeId)
      .map(nodeId => scorecardsByNodeId[nodeId]!);

    const observedKeys = new Set<string>();
    for (const card of resolvedScorecards) {
      if (card.status !== 'complete' && card.status !== 'partial') {
        continue;
      }
      const scores = card.scores;
      if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
        continue;
      }
      for (const key of Object.keys(scores as Record<string, unknown>)) {
        observedKeys.add(key);
      }
    }
    if (observedKeys.size === 0) {
      throw insufficientEvalDataError({ campaignId, contracts: options.contracts, reason: 'no_scorecards' });
    }

    const requestedDimensions = Array.isArray(options.params.dimensions)
      ? (options.params.dimensions as unknown[]).map(value => String(value))
      : null;
    const effectiveDimensions = orderedDimensions(
      requestedDimensions ? requestedDimensions.filter(dimension => observedKeys.has(dimension)) : observedKeys,
    );
    if (method === 'pareto' && effectiveDimensions.length < 2) {
      throw insufficientEvalDataError({ campaignId, contracts: options.contracts, reason: 'insufficient_dimensions' });
    }

    const usableNodes = resolvedNodes.filter(node => {
      const card = scorecardsByNodeId[String(node.node_id)];
      const groundingStatus = node.grounding_audit?.status;
      return !!card && card.status !== 'failed' && (!effectiveDimensions.includes('grounding') || groundingStatus !== 'fail');
    });
    if ((method === 'elo' && usableNodes.length < 2) || (method === 'pareto' && usableNodes.length < 1)) {
      throw insufficientEvalDataError({ campaignId, contracts: options.contracts, reason: 'insufficient_nodes' });
    }

    const initialRating = method === 'elo' && eloConfig && typeof eloConfig === 'object' && !Array.isArray(eloConfig)
      ? Number((eloConfig as Record<string, unknown>).initial_rating ?? 1500)
      : 1500;
    const scoredRows = usableNodes.map((node, index) => {
      const card = scorecardsByNodeId[String(node.node_id)]!;
      const scores = card.scores as Record<string, unknown>;
      const supportedScores = effectiveDimensions
        .map(dimension => scores[dimension])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const coverage = supportedScores.length / effectiveDimensions.length;
      const aggregate = supportedScores.length === 0 ? 0 : coverage;
      return {
        _aggregate: aggregate,
        _stableIndex: index,
        elo_rating: initialRating,
        idea_id: node.idea_id,
        node_id: node.node_id,
      };
    });
    scoredRows.sort((left, right) => {
      if (left._aggregate !== right._aggregate) return right._aggregate - left._aggregate;
      return left._stableIndex - right._stableIndex;
    });
    const topAggregate = scoredRows[0]?._aggregate ?? null;
    const rankedNodes = scoredRows.map((row, index) => {
      const base: Record<string, unknown> = { idea_id: row.idea_id, node_id: row.node_id, rank: index + 1 };
      if (method === 'elo') {
        base.elo_rating = row.elo_rating;
      } else {
        base.pareto_front = topAggregate !== null && row._aggregate === topAggregate;
      }
      return base;
    });
    if (rankedNodes.length === 0 || (method === 'pareto' && effectiveDimensions.length < 2)) {
      throw insufficientEvalDataError({ campaignId, contracts: options.contracts, reason: 'insufficient_nodes' });
    }

    const now = options.now();
    const artifactName = `ranking-${now.replace(/[^0-9]/g, '')}.json`;
    const rankingArtifactRef = pathToFileURL(options.store.artifactPath(campaignId, 'rankings', artifactName)).href;
    const rankingArtifact = {
      campaign_id: campaignId,
      effective_dimensions: effectiveDimensions,
      generated_at: now,
      method,
      ranked_nodes: rankedNodes,
      scorecards_artifact_ref: rawScorecardsRef,
    };

    const plannedCampaign = structuredClone(campaign);
    plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
    setCampaignRunningIfBudgetAvailable(plannedCampaign);

    const result = {
      budget_snapshot: budgetSnapshot(plannedCampaign),
      campaign_id: campaignId,
      effective_dimensions: effectiveDimensions,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      method,
      ranked_nodes: rankedNodes,
      ranking_artifact_ref: rankingArtifactRef,
      scorecards_artifact_ref: rawScorecardsRef,
    };
    options.contracts.validateResult('rank.compute', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'rank.compute',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.writeArtifact(campaignId, 'rankings', artifactName, rankingArtifact);
    options.store.saveCampaign(plannedCampaign as Record<string, unknown> & { campaign_id: string });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'rank.compute',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
