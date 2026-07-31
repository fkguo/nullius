import { existsSync } from 'fs';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { payloadHash as artifactPayloadHash } from '../hash/payload-hash.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { filterNodes, type NodeListFilter, type NodeRecord } from './filter-nodes.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { isPortfolioScoringEligible, nodeLifecycleState, nodeLiteratureCoverage, nodePosterior, sanitizeText, type LiteratureCoverageStatus } from './node-shared.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './campaign-state.js';

interface RankedRow {
  node_id: string;
  idea_id: string;
  title: string;
  rank: number;
  posterior_value: number;
  evidence_count: number;
  literature_coverage_status: LiteratureCoverageStatus;
  allocation_eligible: boolean;
  exploratory_allocation: boolean;
  tie_group_id?: string;
}

interface TieGroup {
  tie_group_id: string;
  node_ids: string[];
  within_group_order_informative: false;
  suggested_discriminator: 'pairwise_match';
}

/**
 * Adjacent rows whose COMPLETE sort key (posterior_value, evidence_count)
 * matches bit-for-bit share a tie group: their relative order is stable input
 * order only and carries no preference information. Rows equal only on
 * posterior_value are NOT grouped — the evidence_count tiebreak is
 * informative. Every ranked row is admitted, so any group with two or more
 * members is a designed input for a pairwise comparison (adjacent posteriors
 * at distance zero — the most informative pair).
 */
function assignTieGroups(rankedNodes: RankedRow[]): TieGroup[] {
  const tieGroups: TieGroup[] = [];
  let start = 0;
  while (start < rankedNodes.length) {
    let end = start + 1;
    while (
      end < rankedNodes.length
      && rankedNodes[end].posterior_value === rankedNodes[start].posterior_value
      && rankedNodes[end].evidence_count === rankedNodes[start].evidence_count
    ) {
      end += 1;
    }
    if (end - start >= 2) {
      const group: TieGroup = {
        tie_group_id: `tie-${rankedNodes[start].rank}`,
        node_ids: rankedNodes.slice(start, end).map(row => row.node_id),
        within_group_order_informative: false,
        suggested_discriminator: 'pairwise_match',
      };
      for (let i = start; i < end; i += 1) {
        rankedNodes[i].tie_group_id = group.tie_group_id;
      }
      tieGroups.push(group);
    }
    start = end;
  }
  return tieGroups;
}

function nodeTitle(node: NodeRecord): string {
  const rationale = node.rationale_draft;
  const record = rationale && typeof rationale === 'object' && !Array.isArray(rationale)
    ? rationale as Record<string, unknown>
    : {};
  return sanitizeText(record.title, 'Untitled rationale');
}

interface SkippedRow {
  node_id: string;
  reason: 'candidate' | 'admission_review' | 'admission_blocked' | 'needs_refresh' | 'waiting_activation' | 'archived'
    | 'no_posterior' | 'metadata_only' | 'coverage_incomplete' | 'posterior_not_current';
  literature_coverage_status?: LiteratureCoverageStatus;
  allocation_eligible?: boolean;
  posterior_status?: 'current' | 'provisional' | 'stale';
}

/**
 * rank.compute: order nodes by their externally computed belief-graph
 * posterior. Only admitted nodes participate; every other node is reported
 * explicitly in skipped_nodes with its lifecycle state as the reason instead
 * of being silently dropped. Admitted nodes are re-checked against the
 * stored data (posterior presence/status, close-prior coverage) as defense
 * in depth for hand-migrated stores. An empty ranking is a valid result.
 *
 * Store-state awareness: the request computes a canonical digest over the
 * ranking-relevant projection of the store (per filtered node: identity,
 * lifecycle, posterior value/count/status, coverage fields, title) plus the
 * filter. When the digest matches the campaign's recorded last ranking and
 * that ranking's artifact still exists, the call returns the existing
 * artifact ref with unchanged_since set — no new artifact is minted and no
 * step budget is consumed. A run of identical re-rank calls therefore
 * produces one artifact, not one per call, and every ranking artifact is
 * mechanically traceable to the exact store state (store_digest) it ranked.
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

    // Ranking-relevant projection of the filtered store, in stable input
    // order: exactly the stored fields the ranked/skipped/title outputs are
    // computed from — stored values only, never recomputed quantities, so
    // bit-identical store state yields a bit-identical digest.
    const projection = resolvedNodes.map(node => {
      const posterior = nodePosterior(node);
      const coverage = nodeLiteratureCoverage(node);
      return {
        node_id: String(node.node_id),
        idea_id: String(node.idea_id),
        lifecycle_state: String(node.lifecycle_state),
        posterior: posterior === null
          ? null
          : {
            value: posterior.value,
            evidence_count: posterior.evidence_count,
            status: posterior.status ?? null,
          },
        literature_coverage: {
          status: coverage.status,
          survey_ref: coverage.survey_ref ?? null,
          close_prior_matrix_ref: coverage.close_prior_matrix_ref ?? null,
          exploratory_allocation: coverage.exploratory_allocation ?? null,
        },
        title: nodeTitle(node),
      };
    });
    const storeDigest = artifactPayloadHash({
      filter: (options.params.filter as NodeListFilter | undefined) ?? null,
      nodes: projection,
    });

    const skippedNodes: SkippedRow[] = [];
    const candidates: Array<{
      nodeId: string;
      ideaId: string;
      title: string;
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
      if (lifecycle !== 'admitted') {
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
      if (posterior.status !== 'current') {
        skippedNodes.push({
          node_id: nodeId,
          reason: 'posterior_not_current',
          literature_coverage_status: literatureCoverage.status,
          ...(posterior.status ? { posterior_status: posterior.status } : {}),
          allocation_eligible: false,
        });
        continue;
      }
      candidates.push({
        nodeId,
        ideaId: String(node.idea_id),
        title: nodeTitle(node),
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
      title: candidate.title,
      rank: index + 1,
      posterior_value: candidate.posteriorValue,
      evidence_count: candidate.evidenceCount,
      literature_coverage_status: candidate.literatureCoverageStatus,
      allocation_eligible: candidate.allocationEligible,
      exploratory_allocation: candidate.exploratoryAllocation,
    }));
    const tieGroups = assignTieGroups(rankedNodes);

    const now = options.now();

    // Reuse branch: the store projection and filter are unchanged since the
    // recorded last ranking, and that artifact is still on disk — return the
    // existing ref without minting a new artifact or consuming a step. The
    // response rows are freshly computed from the same store state, so they
    // are identical to the artifact's by construction of the digest.
    const lastRanking = campaign.last_ranking && typeof campaign.last_ranking === 'object' && !Array.isArray(campaign.last_ranking)
      ? campaign.last_ranking as Record<string, unknown>
      : null;
    if (
      lastRanking
      && lastRanking.store_digest === storeDigest
      && typeof lastRanking.ranking_artifact_ref === 'string'
      && typeof lastRanking.generated_at === 'string'
    ) {
      let artifactStillExists = false;
      try {
        artifactStillExists = existsSync(options.store.artifactPathFromRef(lastRanking.ranking_artifact_ref));
      } catch {
        artifactStillExists = false;
      }
      if (artifactStillExists) {
        const reuseResult = {
          budget_snapshot: budgetSnapshot(campaign),
          campaign_id: campaignId,
          generated_at: now,
          idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
          method: 'posterior',
          ranked_nodes: rankedNodes,
          ranking_artifact_ref: lastRanking.ranking_artifact_ref,
          skipped_nodes: skippedNodes,
          store_digest: storeDigest,
          ...(tieGroups.length > 0 ? { tie_groups: tieGroups } : {}),
          unchanged_since: lastRanking.generated_at,
        };
        options.contracts.validateResult('rank.compute', reuseResult);
        storeIdempotency({
          campaignId,
          createdAt: now,
          idempotencyKeyValue,
          kind: 'result',
          method: 'rank.compute',
          payload: reuseResult,
          payloadHash: options.payloadHash,
          state: 'prepared',
          store: options.store,
        });
        storeIdempotency({
          campaignId,
          createdAt: now,
          idempotencyKeyValue,
          kind: 'result',
          method: 'rank.compute',
          payload: reuseResult,
          payloadHash: options.payloadHash,
          state: 'committed',
          store: options.store,
        });
        return reuseResult;
      }
    }

    const artifactName = `ranking-${now.replace(/[^0-9]/g, '')}.json`;
    const rankingArtifact = {
      campaign_id: campaignId,
      generated_at: now,
      method: 'posterior',
      ranked_nodes: rankedNodes,
      skipped_nodes: skippedNodes,
      store_digest: storeDigest,
      ...(tieGroups.length > 0 ? { tie_groups: tieGroups } : {}),
    };
    const rankingArtifactPath = options.store.artifactPath(campaignId, 'rankings', artifactName);
    const rankingArtifactRef = options.store.portableArtifactRef(
      rankingArtifactPath,
      artifactPayloadHash(rankingArtifact),
    );

    const plannedCampaign = structuredClone(campaign);
    plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
    setCampaignRunningIfBudgetAvailable(plannedCampaign);
    plannedCampaign.last_ranking = {
      store_digest: storeDigest,
      ranking_artifact_ref: rankingArtifactRef,
      generated_at: now,
    };

    const result = {
      budget_snapshot: budgetSnapshot(plannedCampaign),
      campaign_id: campaignId,
      generated_at: now,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      method: 'posterior',
      ranked_nodes: rankedNodes,
      ranking_artifact_ref: rankingArtifactRef,
      skipped_nodes: skippedNodes,
      store_digest: storeDigest,
      ...(tieGroups.length > 0 ? { tie_groups: tieGroups } : {}),
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
