import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { pathToFileURL } from 'url';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError, schemaValidationError } from './errors.js';
import { ensureNodeInCampaign, validateFormalizationTrace } from './post-search-shared.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './search-step-campaign.js';

const PLACEHOLDER_EVIDENCE_URI = 'https://example.org/reference';
const DISQUALIFYING_FAILURE_MODES = new Set(['missing_evidence', 'formalization_trace_invalid']);

function reductionError(options: {
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  nodeId: string;
  reason: string;
}): RpcError {
  const data = { campaign_id: options.campaignId, node_id: options.nodeId, reason: options.reason };
  options.contracts.validateErrorData(data);
  return new RpcError(-32016, 'reduction_audit_failed', data);
}

function promotionSupportError(options: {
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  nodeId: string;
  reason: string;
}): RpcError {
  const data = { campaign_id: options.campaignId, node_id: options.nodeId, reason: options.reason };
  options.contracts.validateErrorData(data);
  return new RpcError(-32011, 'grounding_audit_failed', data);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function sanitizePromotedIdeaCard(ideaCard: Record<string, unknown>): Record<string, unknown> {
  const promotedIdeaCard = structuredClone(ideaCard);
  if (!Array.isArray(promotedIdeaCard.claims)) {
    return promotedIdeaCard;
  }
  promotedIdeaCard.claims = promotedIdeaCard.claims.map(claim => {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      return claim;
    }
    const promotedClaim = { ...(claim as Record<string, unknown>) };
    promotedClaim.evidence_uris = stringArray(promotedClaim.evidence_uris)
      .filter(uri => uri !== PLACEHOLDER_EVIDENCE_URI);
    return promotedClaim;
  });
  return promotedIdeaCard;
}

function loadPromotionEvidenceSupport(options: {
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  node: Record<string, unknown>;
  nodeId: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const evalInfo = options.node.eval_info && typeof options.node.eval_info === 'object' && !Array.isArray(options.node.eval_info)
    ? options.node.eval_info as Record<string, unknown>
    : {};
  const scorecardsArtifactRef = evalInfo.promotion_scorecards_artifact_ref;
  if (typeof scorecardsArtifactRef !== 'string' || scorecardsArtifactRef.length === 0) {
    throw promotionSupportError({
      campaignId: options.campaignId,
      contracts: options.contracts,
      nodeId: options.nodeId,
      reason: 'promotion_support_missing',
    });
  }

  let scorecardsPayload: Record<string, unknown>;
  try {
    scorecardsPayload = options.store.loadArtifactFromRef<Record<string, unknown>>(scorecardsArtifactRef);
  } catch {
    throw promotionSupportError({
      campaignId: options.campaignId,
      contracts: options.contracts,
      nodeId: options.nodeId,
      reason: 'promotion_support_missing',
    });
  }

  const scorecards = Array.isArray(scorecardsPayload.scorecards)
    ? scorecardsPayload.scorecards
    : [];
  const scorecard = scorecards.find(card => (
    card
      && typeof card === 'object'
      && !Array.isArray(card)
      && (card as Record<string, unknown>).node_id === options.nodeId
  )) as Record<string, unknown> | undefined;
  if (!scorecard) {
    throw promotionSupportError({
      campaignId: options.campaignId,
      contracts: options.contracts,
      nodeId: options.nodeId,
      reason: 'promotion_support_missing',
    });
  }

  const scorecardStatus = String(scorecard.status);
  const scores = scorecard.scores && typeof scorecard.scores === 'object' && !Array.isArray(scorecard.scores)
    ? scorecard.scores as Record<string, unknown>
    : {};
  const supportedDimensions = Object.keys(scores)
    .filter(key => typeof scores[key] === 'number' && Number.isFinite(scores[key]));
  const evaluatorConfig = scorecardsPayload.evaluator_config;
  const requestedDimensions = (
    evaluatorConfig && typeof evaluatorConfig === 'object' && !Array.isArray(evaluatorConfig)
  )
    ? stringArray((evaluatorConfig as Record<string, unknown>).dimensions)
    : [];
  const unsupportedDimensions = requestedDimensions.filter(dimension => !supportedDimensions.includes(dimension));
  const failureModes = stringArray(scorecard.failure_modes);
  const evidenceUris = stringArray(scorecard.evidence_uris)
    .filter(uri => uri !== PLACEHOLDER_EVIDENCE_URI);
  const hasDisqualifyingFailure = failureModes.some(mode => DISQUALIFYING_FAILURE_MODES.has(mode));

  if (
    scorecardStatus === 'failed'
    || supportedDimensions.length === 0
    || evidenceUris.length === 0
    || hasDisqualifyingFailure
  ) {
    throw promotionSupportError({
      campaignId: options.campaignId,
      contracts: options.contracts,
      nodeId: options.nodeId,
      reason: 'promotion_support_not_supported',
    });
  }

  return {
    evidence_uris: evidenceUris,
    failure_modes: failureModes,
    scorecard_status: scorecardStatus,
    scorecards_artifact_ref: scorecardsArtifactRef,
    support_status: unsupportedDimensions.length === 0 ? 'supported' : 'partially_supported',
    supported_dimensions: supportedDimensions,
    unsupported_dimensions: unsupportedDimensions,
  };
}

export function executeNodePromote(options: {
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
      method: 'node.promote',
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

    const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = ensureNodeInCampaign({
      campaignId,
      contracts: options.contracts,
      nodeId,
      nodes,
    });
    validateFormalizationTrace({ campaignId, node, nodeId });

    if (!node.idea_card || typeof node.idea_card !== 'object' || Array.isArray(node.idea_card)) {
      throw schemaValidationError('idea_card is required for promotion', {
        campaign_id: campaignId,
        node_id: nodeId,
      });
    }
    options.contracts.validateAgainstRef('./idea_card_v1.schema.json', node.idea_card, `node.promote/idea_card/${nodeId}`);

    const groundingAudit = node.grounding_audit;
    const groundingAuditRecord = (
      groundingAudit && typeof groundingAudit === 'object' && !Array.isArray(groundingAudit)
    )
      ? (groundingAudit as Record<string, unknown>)
      : null;
    if (!groundingAuditRecord || groundingAuditRecord.status !== 'pass') {
      const data = { campaign_id: campaignId, node_id: nodeId, reason: 'grounding_audit_not_pass' };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32011, 'grounding_audit_failed', data);
    }
    const evidenceSupport = loadPromotionEvidenceSupport({
      campaignId,
      contracts: options.contracts,
      node,
      nodeId,
      store: options.store,
    });
    const promotedIdeaCard = sanitizePromotedIdeaCard(node.idea_card as Record<string, unknown>);
    options.contracts.validateAgainstRef(
      './idea_card_v1.schema.json',
      promotedIdeaCard,
      `node.promote/promoted_idea_card/${nodeId}`,
    );

    const hasReductionReport = node.reduction_report !== null && node.reduction_report !== undefined;
    let reductionAuditSummary: Record<string, unknown> | null = null;
    if (hasReductionReport) {
      const reductionAudit = node.reduction_audit;
      if (!reductionAudit || typeof reductionAudit !== 'object' || Array.isArray(reductionAudit)) {
        throw reductionError({ campaignId, contracts: options.contracts, nodeId, reason: 'reduction_audit_missing' });
      }
      const auditRecord = reductionAudit as Record<string, unknown>;
      if (auditRecord.status !== 'pass') {
        throw reductionError({ campaignId, contracts: options.contracts, nodeId, reason: 'reduction_audit_not_pass' });
      }
      const registryEntries = (campaign.abstract_problem_registry as Record<string, unknown> | undefined)?.entries;
      const registryTypes = new Set(
        Array.isArray(registryEntries)
          ? registryEntries
            .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
            .map(entry => String(entry.abstract_problem_type))
          : [],
      );
      if (!registryTypes.has(String(auditRecord.abstract_problem))) {
        throw reductionError({ campaignId, contracts: options.contracts, nodeId, reason: 'abstract_problem_not_in_registry' });
      }
      reductionAuditSummary = {
        abstract_problem: String(auditRecord.abstract_problem),
        all_assumptions_satisfied: true,
        assumption_count: Array.isArray(auditRecord.assumptions) ? auditRecord.assumptions.length : 0,
        status: 'pass',
        toy_check_result: 'pass',
      };
    }

    const now = options.now();
    const handoffArtifactName = `handoff-${nodeId}.json`;
    const handoffArtifactRef = pathToFileURL(options.store.artifactPath(campaignId, 'handoff', handoffArtifactName)).href;
    const handoffPayload: Record<string, unknown> = {
      campaign_id: campaignId,
      evidence_support: evidenceSupport,
      grounding_audit: groundingAudit,
      idea_card: promotedIdeaCard,
      idea_id: node.idea_id,
      node_id: nodeId,
      promoted_at: now,
    };
    if (hasReductionReport) {
      handoffPayload.reduction_audit = node.reduction_audit as Record<string, unknown>;
      handoffPayload.reduction_report = node.reduction_report as Record<string, unknown>;
    }
    options.contracts.validateAgainstRef('./idea_handoff_c2_v1.schema.json', handoffPayload, `node.promote/handoff/${nodeId}`);

    const plannedCampaign = structuredClone(campaign);
    plannedCampaign.usage.steps_used = Number(plannedCampaign.usage.steps_used ?? 0) + 1;
    setCampaignRunningIfBudgetAvailable(plannedCampaign);

    const result = {
      budget_snapshot: budgetSnapshot(plannedCampaign),
      campaign_id: campaignId,
      grounding_audit_summary: {
        failures: Array.isArray(groundingAuditRecord.failures)
          ? groundingAuditRecord.failures
          : [],
        folklore_risk_score: Number(groundingAuditRecord.folklore_risk_score ?? 0),
        status: 'pass',
      },
      handoff_artifact_ref: handoffArtifactRef,
      has_reduction_report: hasReductionReport,
      idea_id: String(node.idea_id),
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      node_id: nodeId,
      reduction_audit_summary: reductionAuditSummary,
    };
    options.contracts.validateResult('node.promote', result);

    const promotedNode = structuredClone(node);
    promotedNode.revision = Number(promotedNode.revision ?? 0) + 1;
    promotedNode.updated_at = now;
    options.contracts.validateAgainstRef('./idea_node_v1.schema.json', promotedNode, `node.promote/node/${nodeId}`);
    nodes[nodeId] = promotedNode;

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.promote',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.writeArtifact(campaignId, 'handoff', handoffArtifactName, handoffPayload);
    options.store.saveNodes(campaignId, nodes);
    options.store.appendNodeLog(campaignId, promotedNode, 'promote');
    options.store.saveCampaign(plannedCampaign as Record<string, unknown> & { campaign_id: string });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.promote',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
