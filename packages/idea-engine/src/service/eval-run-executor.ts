import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { pathToFileURL } from 'url';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { ensureNodeInCampaign, validateFormalizationTrace } from './post-search-shared.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './search-step-campaign.js';

const PLACEHOLDER_EVIDENCE_URI = 'https://example.org/reference';

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))];
}

function collectNodeEvidenceUris(node: Record<string, unknown>): string[] {
  const evidence = new Set<string>();
  const operatorTrace = node.operator_trace;
  if (operatorTrace && typeof operatorTrace === 'object' && !Array.isArray(operatorTrace)) {
    const traceEvidence = (operatorTrace as Record<string, unknown>).evidence_uris_used;
    if (Array.isArray(traceEvidence)) {
      for (const value of traceEvidence) {
        if (typeof value === 'string' && value.length > 0) {
          evidence.add(value);
        }
      }
    }
  }
  const ideaCard = node.idea_card;
  if (ideaCard && typeof ideaCard === 'object' && !Array.isArray(ideaCard)) {
    const claims = (ideaCard as Record<string, unknown>).claims;
    if (Array.isArray(claims)) {
      for (const claim of claims) {
        if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
          continue;
        }
        const claimEvidence = (claim as Record<string, unknown>).evidence_uris;
        if (!Array.isArray(claimEvidence)) {
          continue;
        }
        for (const value of claimEvidence) {
          if (typeof value === 'string' && value.length > 0) {
            evidence.add(value);
          }
        }
      }
    }
  }
  return [...evidence];
}

function hasStructuredComputePlan(node: Record<string, unknown>): boolean {
  const ideaCard = node.idea_card;
  if (!ideaCard || typeof ideaCard !== 'object' || Array.isArray(ideaCard)) {
    return false;
  }
  const computePlan = (ideaCard as Record<string, unknown>).minimal_compute_plan;
  return Array.isArray(computePlan) && computePlan.some(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return false;
    }
    const record = step as Record<string, unknown>;
    return typeof record.method === 'string'
      && record.method.trim().length > 0
      && typeof record.step === 'string'
      && record.step.trim().length > 0;
  });
}

function evaluateNodeAgainstDimensions(options: {
  campaignId: string;
  dimensions: string[];
  node: Record<string, unknown>;
  nodeId: string;
  now: string;
}): {
  evidenceUris: string[];
  failureModes: string[];
  fixSuggestions: Array<Record<string, unknown>>;
  groundingAudit: Record<string, unknown> | null;
  notes?: string;
  scores: Record<string, number>;
  status: 'complete' | 'partial' | 'failed';
} {
  const evidenceUris = collectNodeEvidenceUris(options.node);
  const usableEvidenceUris = evidenceUris.filter(uri => uri !== PLACEHOLDER_EVIDENCE_URI);
  const failureModes: string[] = [];
  const fixSuggestions: Array<Record<string, unknown>> = [];
  const scores: Record<string, number> = {};
  const unsupportedDimensions: string[] = [];
  let formalizationValid = true;

  try {
    validateFormalizationTrace({
      campaignId: options.campaignId,
      node: options.node,
      nodeId: options.nodeId,
    });
  } catch {
    formalizationValid = false;
    failureModes.push('formalization_trace_invalid');
    fixSuggestions.push({
      failure_mode: 'untestable',
      suggested_action: 'Repair operator_trace.params.formalization so eval.run can verify the rationale lineage.',
      target_field: 'operator_trace.params.formalization',
      priority: 'critical',
    });
  }

  if (usableEvidenceUris.length === 0) {
    failureModes.push('missing_evidence');
    fixSuggestions.push({
      failure_mode: 'missing_evidence',
      suggested_action: 'Attach at least one non-placeholder evidence URI before treating this node as grounded.',
      target_field: 'idea_card.claims',
      priority: 'major',
    });
  }

  const hasComputePlan = hasStructuredComputePlan(options.node);
  if (!hasComputePlan) {
    failureModes.push('missing_compute_plan');
    fixSuggestions.push({
      failure_mode: 'not_computable',
      suggested_action: 'Add a minimal_compute_plan with a concrete step and method before ranking this node for execution.',
      target_field: 'idea_card.minimal_compute_plan',
      priority: 'major',
    });
  }

  for (const dimension of options.dimensions) {
    if (dimension === 'novelty' || dimension === 'impact' || dimension === 'grounding') {
      if (formalizationValid && usableEvidenceUris.length > 0) scores[dimension] = 1;
      continue;
    }
    if (dimension === 'feasibility' || dimension === 'tractability') {
      if (hasComputePlan && formalizationValid && usableEvidenceUris.length > 0) scores[dimension] = 1;
      continue;
    }
    unsupportedDimensions.push(dimension);
  }

  for (const dimension of unsupportedDimensions) {
    failureModes.push(`unsupported_dimension:${dimension}`);
  }

  const groundingFailures = uniqueStrings(
    [
      !formalizationValid ? 'formalization_trace_invalid' : '',
      usableEvidenceUris.length === 0 ? 'missing_grounding_evidence' : '',
    ],
  );
  const groundingAudit = options.dimensions.includes('grounding')
    ? {
      failures: groundingFailures,
      folklore_risk_score: usableEvidenceUris.length > 0 && formalizationValid ? 0.15 : formalizationValid ? 0.45 : 0.85,
      status: usableEvidenceUris.length > 0 && formalizationValid ? 'pass' : formalizationValid ? 'partial' : 'fail',
      timestamp: options.now,
    }
    : null;

  const supportedDimensions = Object.keys(scores).length;
  const status = supportedDimensions === 0
    ? 'failed'
    : supportedDimensions === options.dimensions.length
      ? 'complete'
      : 'partial';
  const notes = unsupportedDimensions.length > 0
    ? `internal_only: unsupported dimensions abstained=${unsupportedDimensions.join(',')}`
    : undefined;

  return {
    evidenceUris: usableEvidenceUris,
    failureModes: uniqueStrings(failureModes),
    fixSuggestions,
    groundingAudit,
    ...(notes ? { notes } : {}),
    scores,
    status,
  };
}

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
    const scorecardsArtifactName = `scorecards-${options.createId()}.json`;
    const scorecardsArtifactRef = pathToFileURL(
      options.store.artifactPath(campaignId, 'scorecards', scorecardsArtifactName),
    ).href;
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
      const evaluation = evaluateNodeAgainstDimensions({
        campaignId,
        dimensions,
        node,
        nodeId,
        now,
      });
      const previousEvalInfo = node.eval_info && typeof node.eval_info === 'object' && !Array.isArray(node.eval_info)
        ? node.eval_info as Record<string, unknown>
        : {};
      const previousPromotionSupportRef = previousEvalInfo.promotion_scorecards_artifact_ref;
      const keepsExistingPromotionSupport = typeof previousPromotionSupportRef === 'string'
        && !evaluation.failureModes.some(mode => mode === 'missing_evidence' || mode === 'formalization_trace_invalid');
      const promotionScorecardsArtifactRef = evaluation.groundingAudit
        ? scorecardsArtifactRef
        : keepsExistingPromotionSupport
          ? previousPromotionSupportRef
          : null;
      node.eval_info = {
        failure_modes: structuredClone(evaluation.failureModes),
        fix_suggestions: structuredClone(evaluation.fixSuggestions),
        ...(promotionScorecardsArtifactRef ? { promotion_scorecards_artifact_ref: promotionScorecardsArtifactRef } : {}),
        scores: structuredClone(evaluation.scores),
      };
      if (evaluation.groundingAudit) {
        node.grounding_audit = evaluation.groundingAudit;
      }
      node.revision = Number(node.revision ?? 0) + 1;
      node.updated_at = now;
      nodeRevisions[nodeId] = Number(node.revision);
      options.contracts.validateAgainstRef('./idea_node_v1.schema.json', node, `eval.run/node/${nodeId}`);
      scorecards.push({
        ...(evaluation.evidenceUris.length > 0 ? { evidence_uris: evaluation.evidenceUris } : {}),
        failure_modes: structuredClone(evaluation.failureModes),
        fix_suggestions: structuredClone(evaluation.fixSuggestions),
        node_id: nodeId,
        ...(evaluation.notes ? { notes: evaluation.notes } : {}),
        reviewer_count: nReviewers,
        scores: structuredClone(evaluation.scores),
        status: evaluation.status,
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
