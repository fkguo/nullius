import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { sha256Hex } from './sha256-hex.js';
import { RpcError, schemaValidationError } from './errors.js';

/**
 * Placeholder URI written by seed normalization when a seed carries no real
 * source references. Promotion strips it from claim evidence lists; a claim
 * left with no non-placeholder evidence then fails the promoted idea_card
 * schema check (evidence-backed support types require at least one URI).
 */
export const PLACEHOLDER_EVIDENCE_URI = 'https://example.org/reference';

/**
 * Single authority for the text sanitization that feeds the formalization
 * trace. Seed import, generated-node import, and promote-time validation must
 * all use THIS implementation: a byte-level divergence anywhere yields nodes
 * whose rationale_hash can never satisfy validateFormalizationTrace.
 */
export function sanitizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const compact = value.trim().split(/\s+/).join(' ');
  return compact || fallback;
}

/** Formalization-trace hash over the sanitized rationale draft (see sanitizeText). */
export function rationaleHashForTrace(rationaleDraft: Record<string, unknown>): string {
  const title = sanitizeText(rationaleDraft.title, 'Untitled rationale');
  const rationale = sanitizeText(rationaleDraft.rationale, 'No rationale provided.');
  return `sha256:${sha256Hex(`${title}|${rationale}`)}`;
}

export function validateFormalizationTrace(options: {
  campaignId: string;
  node: Record<string, unknown>;
  nodeId: string;
}): void {
  const { campaignId, node, nodeId } = options;
  const operatorTrace = node.operator_trace;
  if (!operatorTrace || typeof operatorTrace !== 'object' || Array.isArray(operatorTrace)) {
    throw schemaValidationError('formalization trace missing: operator_trace is not an object', {
      campaign_id: campaignId,
      node_id: nodeId,
    });
  }
  const params = (operatorTrace as Record<string, unknown>).params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw schemaValidationError('formalization trace missing: operator_trace.params is not an object', {
      campaign_id: campaignId,
      node_id: nodeId,
    });
  }
  const formalization = (params as Record<string, unknown>).formalization;
  if (!formalization || typeof formalization !== 'object' || Array.isArray(formalization)) {
    throw schemaValidationError('formalization trace missing: operator_trace.params.formalization is not an object', {
      campaign_id: campaignId,
      node_id: nodeId,
    });
  }
  const trace = formalization as Record<string, unknown>;
  if (trace.mode !== 'explain_then_formalize_deterministic_v1') {
    throw schemaValidationError(`formalization trace invalid: unsupported mode ${String(trace.mode)}`, {
      campaign_id: campaignId,
      node_id: nodeId,
    });
  }
  if (trace.source_artifact !== 'rationale_draft') {
    throw schemaValidationError('formalization trace invalid: source_artifact must be rationale_draft', {
      campaign_id: campaignId,
      node_id: nodeId,
    });
  }
  const rationaleDraft = node.rationale_draft;
  const expectedHash = rationaleHashForTrace(
    rationaleDraft && typeof rationaleDraft === 'object' && !Array.isArray(rationaleDraft)
      ? rationaleDraft as Record<string, unknown>
      : {},
  );
  if (trace.rationale_hash !== expectedHash) {
    throw schemaValidationError(
      `formalization trace invalid: rationale_hash mismatch (recorded=${String(trace.rationale_hash)}, expected=${expectedHash})`,
      {
        campaign_id: campaignId,
        node_id: nodeId,
      },
    );
  }
}

export function ensureNodeInCampaign(options: {
  campaignId: string;
  contracts: IdeaEngineContractCatalog;
  nodeId: string;
  nodes: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  const { campaignId, contracts, nodeId, nodes } = options;
  const node = nodes[nodeId];
  if (!node) {
    const data = { reason: 'node_not_found', campaign_id: campaignId, node_id: nodeId };
    contracts.validateErrorData(data);
    throw new RpcError(-32004, 'node_not_found', data);
  }
  if (node.campaign_id !== campaignId) {
    const data = { reason: 'node_not_in_campaign', campaign_id: campaignId, node_id: nodeId };
    contracts.validateErrorData(data);
    throw new RpcError(-32014, 'node_not_in_campaign', data);
  }
  return node;
}

export type NodeLifecycleState = 'active' | 'waiting_activation' | 'archived';

/** lifecycle_state defaults to "active" when the field is absent (validator-side default). */
export function nodeLifecycleState(node: Record<string, unknown>): NodeLifecycleState {
  const state = node.lifecycle_state;
  if (state === 'waiting_activation' || state === 'archived') {
    return state;
  }
  return 'active';
}

export interface NodePosterior {
  value: number;
  evidence_count: number;
  updated_at: string;
  gaia_package_ref?: string;
  status?: 'current' | 'provisional' | 'stale';
}

/** Returns the node posterior when present and well-formed, else null. */
export function nodePosterior(node: Record<string, unknown>): NodePosterior | null {
  const posterior = node.posterior;
  if (!posterior || typeof posterior !== 'object' || Array.isArray(posterior)) {
    return null;
  }
  const record = posterior as Record<string, unknown>;
  if (typeof record.value !== 'number' || typeof record.evidence_count !== 'number') {
    return null;
  }
  return record as unknown as NodePosterior;
}

export type LiteratureCoverageStatus = 'saturated' | 'coverage_incomplete' | 'metadata_only';

export interface LiteratureCoverage {
  status: LiteratureCoverageStatus;
  survey_ref?: string;
  close_prior_matrix_ref?: string;
  exploratory_allocation?: boolean;
}

export function nodeLiteratureCoverage(node: Record<string, unknown>): LiteratureCoverage {
  const coverage = node.literature_coverage;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return { status: 'metadata_only' };
  }
  const record = coverage as Record<string, unknown>;
  const status = record.status === 'saturated' || record.status === 'coverage_incomplete'
    ? record.status
    : 'metadata_only';
  return {
    status,
    ...(typeof record.survey_ref === 'string' ? { survey_ref: record.survey_ref } : {}),
    ...(typeof record.close_prior_matrix_ref === 'string' ? { close_prior_matrix_ref: record.close_prior_matrix_ref } : {}),
    ...(typeof record.exploratory_allocation === 'boolean' ? { exploratory_allocation: record.exploratory_allocation } : {}),
  };
}

export function hasClosePriorRefs(coverage: LiteratureCoverage): boolean {
  return typeof coverage.survey_ref === 'string' && coverage.survey_ref.trim().length > 0
    && typeof coverage.close_prior_matrix_ref === 'string' && coverage.close_prior_matrix_ref.trim().length > 0;
}

export function isPortfolioScoringEligible(coverage: LiteratureCoverage): boolean {
  if (!hasClosePriorRefs(coverage)) {
    return false;
  }
  return coverage.status === 'saturated'
    || (coverage.status === 'coverage_incomplete' && coverage.exploratory_allocation === true);
}
