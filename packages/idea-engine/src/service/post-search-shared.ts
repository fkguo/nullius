import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import { sha256Hex } from './sha256-hex.js';
import { RpcError, schemaValidationError } from './errors.js';

const DIMENSION_ORDER = ['novelty', 'feasibility', 'impact', 'tractability', 'grounding'];

function sanitizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const compact = value.trim().split(/\s+/).join(' ');
  return compact || fallback;
}

function rationaleHashForTrace(rationaleDraft: Record<string, unknown>): string {
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

export function deterministicScore(nodeId: string, dimension: string): number {
  const token = `${nodeId}:${dimension}`;
  const value = Number.parseInt(sha256Hex(token).slice(0, 8), 16);
  return Math.round(((value % 1000) / 1000) * 1_000_000) / 1_000_000;
}

export function orderedDimensions(items: Iterable<string>): string[] {
  const itemSet = new Set(items);
  return DIMENSION_ORDER.filter(dimension => itemSet.has(dimension));
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
