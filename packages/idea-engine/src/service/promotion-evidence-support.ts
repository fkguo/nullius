import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { RpcError } from './errors.js';

export const PLACEHOLDER_EVIDENCE_URI = 'https://example.org/reference';

const DISQUALIFYING_FAILURE_MODES = new Set(['missing_evidence', 'formalization_trace_invalid']);

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

export function loadPromotionEvidenceSupport(options: {
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
