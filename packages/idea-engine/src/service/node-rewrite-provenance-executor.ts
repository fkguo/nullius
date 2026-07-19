import { SHORT_ID_JSON_PATTERN } from '@nullius/shared';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { ensureNodeInCampaign } from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

/** An engine short id (8 base32 chars): a closest_prior must never be a bare handle. */
const SHORT_ID_RE = new RegExp(SHORT_ID_JSON_PATTERN);

function rewriteValidationError(
  reason: string,
  campaignId: string,
  nodeId: string,
  message: string,
  details: Record<string, unknown> = {},
): RpcError {
  return new RpcError(-32002, 'schema_validation_failed', {
    reason,
    campaign_id: campaignId,
    node_id: nodeId,
    details: { message, ...details },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Retrieval-receipt URIs recorded in the node's own operator trace. */
function traceReceiptUris(traceInputs: Record<string, unknown>): Set<string> {
  const receipts = new Set<string>();
  const raw = traceInputs.retrieval_receipts;
  if (!Array.isArray(raw)) {
    return receipts;
  }
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record && isNonEmptyString(record.uri) && isNonEmptyString(record.source)) {
      receipts.add(record.uri);
    }
  }
  return receipts;
}

/**
 * node.rewrite_provenance: scoped correction path for generated nodes whose
 * recorded provenance violates the contract's documented semantics —
 * currently only operator_trace.inputs.novelty_delta.closest_prior, which
 * must be a URI or survey ref_key of the closest prior work, never a
 * campaign node id. The rewrite also updates the engine-assembled
 * novelty-delta claim on the idea card (so card and trace cannot diverge)
 * and appends the correction to the engine-owned
 * operator_trace.inputs.provenance_rewrites history. The archived generation
 * pack keeps the original value untouched: the provenance chain is original
 * (pack, content-pinned) -> rewrite history -> current node value. Legal in
 * any lifecycle state (record maintenance, not portfolio progression). Does
 * not consume step budget. Allowed in any campaign state except completed.
 */
export function executeNodeRewriteProvenance(options: {
  contracts: IdeaEngineContractCatalog;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const nodeId = String(options.params.node_id);
  const field = String(options.params.field);
  const newValue = String(options.params.new_value);
  const reasonText = String(options.params.reason);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'node.rewrite_provenance',
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
    ensureCampaignNotCompleted(campaign);

    const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
    const node = ensureNodeInCampaign({
      campaignId,
      contracts: options.contracts,
      nodeId,
      nodes,
    });

    // The params schema enforces minLength 1, but it does not reject surrounding
    // whitespace: a blank value ("   ") or a padded one (" refA") slips through
    // and would be stored verbatim — and embedded into the card claim prefix,
    // where an auditor comparing against the pinned survey key sees a mismatch
    // that is invisible in most UIs. A URI or survey ref key never carries
    // leading/trailing whitespace.
    if (newValue !== newValue.trim()) {
      throw rewriteValidationError(
        'schema_invalid',
        campaignId,
        nodeId,
        'new_value has leading/trailing whitespace (or is blank) — closest_prior must be a trimmed URI or survey reference key',
      );
    }
    if (reasonText.trim().length === 0) {
      throw rewriteValidationError(
        'schema_invalid',
        campaignId,
        nodeId,
        'reason is blank (whitespace only) — a provenance correction must record why it was made',
      );
    }

    const operatorTrace = asRecord(node.operator_trace);
    const traceInputs = operatorTrace ? asRecord(operatorTrace.inputs) : null;
    const noveltyDelta = traceInputs ? asRecord(traceInputs.novelty_delta) : null;
    const previousValue = noveltyDelta?.closest_prior;
    if (!noveltyDelta || !isNonEmptyString(previousValue)) {
      throw rewriteValidationError(
        'provenance_field_missing',
        campaignId,
        nodeId,
        'the node carries no operator_trace.inputs.novelty_delta.closest_prior string — only generated nodes with a recorded novelty delta are rewritable',
      );
    }
    if (newValue === previousValue) {
      throw rewriteValidationError(
        'rewrite_value_unchanged',
        campaignId,
        nodeId,
        'new_value equals the stored closest_prior — a rewrite must change the record (replaying the SAME correction is idempotency_key territory)',
      );
    }
    const handleIds = new Set<string>();
    for (const [existingNodeId, existingNode] of Object.entries(nodes)) {
      handleIds.add(existingNodeId);
      const ideaId = (existingNode as Record<string, unknown>).idea_id;
      if (typeof ideaId === 'string') {
        handleIds.add(ideaId);
      }
    }
    if (handleIds.has(newValue) || SHORT_ID_RE.test(newValue)) {
      throw rewriteValidationError(
        'closest_prior_node_reference',
        campaignId,
        nodeId,
        handleIds.has(newValue)
          ? 'new_value is a campaign node or idea id — closest_prior must reference the prior WORK (URI or survey ref_key), which is exactly the defect this method removes'
          : 'new_value has the shape of an engine short id (8 base32 chars) — closest_prior must reference the prior WORK (URI or survey ref_key), never a bare handle (rejected regardless of which campaign minted it, since a foreign-campaign id is the same defect class)',
      );
    }
    if (newValue.includes('://')) {
      const evidenceUris = Array.isArray(operatorTrace?.evidence_uris_used)
        ? (operatorTrace.evidence_uris_used as unknown[]).filter(isNonEmptyString)
        : [];
      const receipts = traceReceiptUris(traceInputs ?? {});
      if (!evidenceUris.includes(newValue) || !receipts.has(newValue)) {
        throw rewriteValidationError(
          'evidence_receipt_missing',
          campaignId,
          nodeId,
          'a URI-shaped new_value must be listed in the node\'s operator_trace.evidence_uris_used and carry a retrieval receipt in operator_trace.inputs.retrieval_receipts — no retrieval receipt, no URI',
          { uri: newValue },
        );
      }
    }

    const now = options.now();
    const updatedNode = structuredClone(node);
    const updatedTrace = updatedNode.operator_trace as Record<string, unknown>;
    const updatedInputs = updatedTrace.inputs as Record<string, unknown>;
    const updatedNovelty = updatedInputs.novelty_delta as Record<string, unknown>;
    updatedNovelty.closest_prior = newValue;

    // The import-time Formalize stage placed the novelty delta on the idea card
    // as a claim with a deterministic prefix. Syncing it is MANDATORY: a node
    // carrying a closest_prior is a generated node, which always holds exactly
    // that claim (generated-node.ts). If no claim carries the expected prefix
    // the node is malformed/tampered — fail closed rather than move the trace
    // while the card keeps citing the retracted reference. A half-correction
    // that still reports success is exactly the silent card/trace divergence
    // this method exists to remove. More than one match is equally malformed.
    const expectedPrefix = `Novelty delta vs closest prior (${previousValue}): `;
    const ideaCard = asRecord(updatedNode.idea_card);
    const claims = ideaCard && Array.isArray(ideaCard.claims) ? ideaCard.claims : [];
    const matchingClaims = claims
      .map(asRecord)
      .filter((claim): claim is Record<string, unknown> =>
        !!claim && typeof claim.claim_text === 'string' && claim.claim_text.startsWith(expectedPrefix));
    if (matchingClaims.length !== 1) {
      throw rewriteValidationError(
        'delta_claim_missing',
        campaignId,
        nodeId,
        matchingClaims.length === 0
          ? 'the idea card carries no novelty-delta claim with the expected prefix — a well-formed generated node always does; refusing rather than leaving the card citing the retracted reference while the trace moves'
          : 'the idea card carries multiple novelty-delta claims with the expected prefix — ambiguous to synchronize; the node is malformed',
        { matching_claim_count: matchingClaims.length },
      );
    }
    const claimRecord = matchingClaims[0]!;
    claimRecord.claim_text = `Novelty delta vs closest prior (${newValue}): ${(claimRecord.claim_text as string).slice(expectedPrefix.length)}`;
    claimRecord.evidence_uris = newValue.includes('://') ? [newValue] : [];

    // The novelty-delta claim just changed. Any grounding_audit certified the
    // PRIOR claim text and no longer covers the current card, so a stale pass
    // must not ride the changed claim into a promotion handoff. Reset it (null
    // fails node.promote's status=pass gate); the node must be re-grounded via
    // node.set_grounding_audit after the correction.
    const groundingAuditReset = updatedNode.grounding_audit != null;
    if (groundingAuditReset) {
      updatedNode.grounding_audit = null;
    }

    // Each entry records the idempotency_key of the request that produced it so
    // the committed effect is identified UNIQUELY during crash recovery. The
    // pair (rewritten_at, new_value) is NOT unique: repeated identical
    // corrections at the same clock tick (e.g. an A->B, B->A, A->B oscillation
    // in a scripted batch) collide, and a probe keyed on them would replay a
    // rewrite whose store effect never landed.
    const rewriteEntry = {
      field,
      previous_value: previousValue,
      new_value: newValue,
      reason: reasonText,
      rewritten_at: now,
      idempotency_key: idempotencyKeyValue,
    };
    const rewriteHistory = Array.isArray(updatedInputs.provenance_rewrites)
      ? updatedInputs.provenance_rewrites as unknown[]
      : [];
    updatedInputs.provenance_rewrites = [...rewriteHistory, rewriteEntry];

    updatedNode.revision = Number(updatedNode.revision ?? 0) + 1;
    updatedNode.updated_at = now;
    options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.rewrite_provenance/node/${nodeId}`);
    nodes[nodeId] = updatedNode;

    const result = {
      budget_snapshot: budgetSnapshot(campaign),
      campaign_id: campaignId,
      delta_claim_updated: true,
      field,
      grounding_audit_reset: groundingAuditReset,
      idea_id: String(updatedNode.idea_id),
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      new_value: newValue,
      node_id: nodeId,
      previous_value: previousValue,
      revision: Number(updatedNode.revision),
      updated_at: now,
    };
    options.contracts.validateResult('node.rewrite_provenance', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.rewrite_provenance',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.saveNodes(campaignId, nodes);
    options.store.appendNodeLog(campaignId, updatedNode, 'rewrite_provenance', {
      field,
      grounding_audit_reset: groundingAuditReset,
      new_value: newValue,
      previous_value: previousValue,
      reason: reasonText,
    });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.rewrite_provenance',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
