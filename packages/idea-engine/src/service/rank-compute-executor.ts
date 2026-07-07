import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { pathToFileURL } from 'url';
import { budgetSnapshot } from './budget-snapshot.js';
import { filterNodes, type NodeListFilter, type NodeRecord } from './filter-nodes.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { isPortfolioScoringEligible, nodeLifecycleState, nodeLiteratureCoverage, nodePosterior, type LiteratureCoverageStatus } from './node-shared.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './campaign-state.js';

interface RankedRow {
  node_id: string;
  idea_id: string;
  rank: number;
  posterior_value: number;
  evidence_count: number;
  literature_coverage_status: LiteratureCoverageStatus;
  allocation_eligible: boolean;
  exploratory_allocation: boolean;
}

interface SkippedRow {
  node_id: string;
  reason: 'no_posterior' | 'waiting_activation' | 'archived' | 'metadata_only' | 'coverage_incomplete' | 'posterior_not_current';
  literature_coverage_status?: LiteratureCoverageStatus;
  allocation_eligible?: boolean;
  posterior_status?: 'current' | 'provisional' | 'stale';
}

/**
 * rank.compute: order nodes by their externally computed belief-graph
 * posterior. Nodes without a posterior, or outside the active lifecycle
 * state, are reported explicitly in skipped_nodes instead of being
 * silently dropped. An empty ranking is a valid result.
 */
export function executeRankCompute(options: {
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

    const nodes = options.store.loadNodes<NodeRecord>(campaignId);
    const resolvedNodes = filterNodes(nodes, options.params.filter as NodeListFilter | undefined);

    const skippedNodes: SkippedRow[] = [];
    const candidates: Array<{
      nodeId: string;
      ideaId: string;
      posteriorValue: number;
      evidenceCount: number;
      literatureCoverageStatus: LiteratureCoverageStatus;
      allocationEligible: boolean;
      exploratoryAllocation: boolean;
      stableIndex: number;
    }> = [];
    for (const [index, node] of resolvedNodes.entries()) {
      const nodeId = String(node.node_id);
      const lifecycle = nodeLifecycleState(node);
      if (lifecycle === 'archived' || lifecycle === 'waiting_activation') {
        skippedNodes.push({ node_id: nodeId, reason: lifecycle });
        continue;
      }
      const posterior = nodePosterior(node);
      if (!posterior) {
        skippedNodes.push({ node_id: nodeId, reason: 'no_posterior' });
        continue;
      }
      const literatureCoverage = nodeLiteratureCoverage(node);
      if (!isPortfolioScoringEligible(literatureCoverage)) {
        const coverageSkipReason = literatureCoverage.status === 'coverage_incomplete' ? 'coverage_incomplete' : 'metadata_only';
        skippedNodes.push({
          node_id: nodeId,
          reason: coverageSkipReason,
          literature_coverage_status: literatureCoverage.status,
          ...(posterior.status ? { posterior_status: posterior.status } : {}),
          allocation_eligible: false,
        });
        continue;
      }
      if (posterior.status === 'stale' || posterior.status === 'provisional') {
        skippedNodes.push({
          node_id: nodeId,
          reason: 'posterior_not_current',
          literature_coverage_status: literatureCoverage.status,
          posterior_status: posterior.status,
          allocation_eligible: false,
        });
        continue;
      }
      candidates.push({
        nodeId,
        ideaId: String(node.idea_id),
        posteriorValue: posterior.value,
        evidenceCount: posterior.evidence_count,
        literatureCoverageStatus: literatureCoverage.status,
        allocationEligible: true,
        exploratoryAllocation: literatureCoverage.exploratory_allocation === true,
        stableIndex: index,
      });
    }

    candidates.sort((left, right) => {
      if (left.posteriorValue !== right.posteriorValue) return right.posteriorValue - left.posteriorValue;
      if (left.evidenceCount !== right.evidenceCount) return right.evidenceCount - left.evidenceCount;
      return left.stableIndex - right.stableIndex;
    });
    const rankedNodes: RankedRow[] = candidates.map((candidate, index) => ({
      node_id: candidate.nodeId,
      idea_id: candidate.ideaId,
      rank: index + 1,
      posterior_value: candidate.posteriorValue,
      evidence_count: candidate.evidenceCount,
      literature_coverage_status: candidate.literatureCoverageStatus,
      allocation_eligible: candidate.allocationEligible,
      exploratory_allocation: candidate.exploratoryAllocation,
    }));

    const now = options.now();
    const artifactName = `ranking-${now.replace(/[^0-9]/g, '')}.json`;
    const rankingArtifactRef = pathToFileURL(options.store.artifactPath(campaignId, 'rankings', artifactName)).href;
    const rankingArtifact = {
      campaign_id: campaignId,
      generated_at: now,
      method: 'posterior',
      ranked_nodes: rankedNodes,
      skipped_nodes: skippedNodes,
    };

    const plannedCampaign = structuredClone(campaign);
    plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
    setCampaignRunningIfBudgetAvailable(plannedCampaign);

    const result = {
      budget_snapshot: budgetSnapshot(plannedCampaign),
      campaign_id: campaignId,
      generated_at: now,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      method: 'posterior',
      ranked_nodes: rankedNodes,
      ranking_artifact_ref: rankingArtifactRef,
      skipped_nodes: skippedNodes,
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
