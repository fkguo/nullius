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

export type NodeLifecycleState =
  | 'candidate'
  | 'admission_review'
  | 'admitted'
  | 'needs_refresh'
  | 'admission_blocked'
  | 'waiting_activation'
  | 'archived';

export const NODE_LIFECYCLE_STATES: readonly NodeLifecycleState[] = [
  'candidate',
  'admission_review',
  'admitted',
  'needs_refresh',
  'admission_blocked',
  'waiting_activation',
  'archived',
];

/**
 * Enforced transition table for node.set_lifecycle. Self-transitions exist
 * only for the two condition-carrying states (condition update); revival from
 * archived is re-intake (candidate / needs_refresh), never a shortcut back to
 * admitted. node.set_posterior enters admitted / needs_refresh through its own
 * derivation, not through this table.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<NodeLifecycleState, readonly NodeLifecycleState[]>> = {
  candidate: ['admission_review', 'admission_blocked', 'waiting_activation', 'archived'],
  admission_review: ['candidate', 'admitted', 'needs_refresh', 'admission_blocked', 'waiting_activation', 'archived'],
  admitted: ['needs_refresh', 'admission_blocked', 'waiting_activation', 'archived'],
  needs_refresh: ['admitted', 'admission_blocked', 'waiting_activation', 'archived'],
  admission_blocked: ['admission_review', 'admission_blocked', 'waiting_activation', 'archived'],
  waiting_activation: ['candidate', 'admission_review', 'admitted', 'needs_refresh', 'admission_blocked', 'waiting_activation', 'archived'],
  archived: ['candidate', 'needs_refresh'],
};

/** States whose nodes must carry an activation_condition (all others must not). */
export const CONDITION_CARRYING_STATES: readonly NodeLifecycleState[] = ['waiting_activation', 'admission_blocked'];

/** The only lifecycle states in which node.set_posterior may write. */
export const POSTERIOR_WRITE_STATES: readonly NodeLifecycleState[] = ['admission_review', 'admitted', 'needs_refresh'];

function isNodeLifecycleState(value: unknown): value is NodeLifecycleState {
  return typeof value === 'string' && (NODE_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * Strict reader: lifecycle_state is required and must be one of the machine's
 * states. A value outside the machine (typically an unmigrated store) fails
 * loudly with a migration hint instead of being silently defaulted.
 */
export function nodeLifecycleState(node: Record<string, unknown>): NodeLifecycleState {
  const state = node.lifecycle_state;
  if (isNodeLifecycleState(state)) {
    return state;
  }
  throw new RpcError(-32018, 'lifecycle_transition_invalid', {
    reason: 'unknown_lifecycle_state',
    ...(typeof node.campaign_id === 'string' ? { campaign_id: node.campaign_id } : {}),
    ...(typeof node.node_id === 'string' ? { node_id: node.node_id } : {}),
    details: {
      found: node.lifecycle_state === undefined ? null : node.lifecycle_state,
      allowed_states: [...NODE_LIFECYCLE_STATES],
      message: 'stored lifecycle_state is outside the lifecycle state machine; migrate the store (map legacy active/absent by data: no posterior -> candidate, posterior.status=current with scoring-eligible coverage -> admitted, otherwise -> needs_refresh)',
    },
  });
}

/** Node lifecycle_reason (last transition's reason), null when absent. */
export function nodeLifecycleReason(node: Record<string, unknown>): string | null {
  return typeof node.lifecycle_reason === 'string' ? node.lifecycle_reason : null;
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

export interface LifecyclePreconditionFailure {
  requirement: string;
  message: string;
}

/**
 * Data-backed entry preconditions of the lifecycle machine. Only preconditions
 * the store can check live here (posterior presence/status, coverage
 * eligibility); the request-shaped requirements (activation_condition for the
 * condition-carrying states, reason for archived) are validated by the
 * set_lifecycle executor against the params.
 */
export function lifecycleEntryPreconditionFailure(
  target: NodeLifecycleState,
  node: Record<string, unknown>,
): LifecyclePreconditionFailure | null {
  const posterior = nodePosterior(node);
  if (target === 'candidate' && posterior !== null) {
    return {
      requirement: 'posterior_must_be_null',
      message: 'candidate means no posterior has been written; a node with a posterior history re-enters as needs_refresh instead',
    };
  }
  if (target === 'needs_refresh' && posterior === null) {
    return {
      requirement: 'posterior_required',
      message: 'needs_refresh means an existing posterior is not current guidance; a node without any posterior is a candidate instead',
    };
  }
  if (target === 'admitted') {
    if (posterior === null) {
      return {
        requirement: 'posterior_required',
        message: 'admitted requires a store-backed posterior; write one via node.set_posterior (which derives admitted itself on status=current)',
      };
    }
    if (posterior.status !== 'current') {
      return {
        requirement: 'posterior_status_current_required',
        message: `admitted requires posterior.status=current, found ${posterior.status === undefined ? 'none' : String(posterior.status)}`,
      };
    }
    if (!isPortfolioScoringEligible(nodeLiteratureCoverage(node))) {
      return {
        requirement: 'coverage_not_scoring_eligible',
        message: 'admitted requires scoring-eligible close-prior coverage: survey_ref + close_prior_matrix_ref with status saturated, or coverage_incomplete with the explicit exploratory waiver',
      };
    }
  }
  return null;
}
