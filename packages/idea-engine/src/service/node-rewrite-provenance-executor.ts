import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { NOVELTY_DELTA_CLAIM_PREFIX, ensureNodeInCampaign } from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

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
 * campaign node id. When the current idea card still carries the reserved
 * novelty-delta claim, the rewrite updates its closest-prior identity too. A
 * reviewed card revision may already have withdrawn that scientific claim; in
 * that case the provenance trace is corrected without reintroducing it. Every
 * correction is appended to the engine-owned
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
    if (handleIds.has(newValue)) {
      throw rewriteValidationError(
        'closest_prior_node_reference',
        campaignId,
        nodeId,
        'new_value is a campaign node or idea id — closest_prior must reference the prior WORK (URI or survey ref_key), which is exactly the defect this method removes',
      );
    }
    // A non-URI new_value that is not a handle in THIS campaign is recorded as a
    // survey ref key and resolved project-side (see the method contract). We do
    // not reject on short-id SHAPE: an id from a different campaign is opaque to
    // this store, and a shape filter would also false-reject a legitimate ref
    // key that happens to be eight base32 characters — a hard failure on valid
    // input is worse than the documented project-side-audit boundary.
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

    // Import creates one reserved novelty-delta claim. A later reviewed
    // node.revise_card may remove or replace that scientific claim while the
    // generation-time record remains pinned in the archived pack. In that state
    // a provenance correction updates the current trace only and must not
    // resurrect the withdrawn claim. If a reserved claim is still present, it
    // must be unique and bound to the trace's previous closest-prior identity.
    const expectedPrefix = `${NOVELTY_DELTA_CLAIM_PREFIX}${previousValue}): `;
    const ideaCard = asRecord(updatedNode.idea_card);
    const claims = ideaCard && Array.isArray(ideaCard.claims) ? ideaCard.claims : [];
    const reservedClaims = claims
      .map(asRecord)
      .filter((claim): claim is Record<string, unknown> =>
        !!claim && typeof claim.claim_text === 'string' && claim.claim_text.startsWith(NOVELTY_DELTA_CLAIM_PREFIX));
    const matchingClaims = reservedClaims.filter((claim) => String(claim.claim_text).startsWith(expectedPrefix));
    if (reservedClaims.length > 1 || (reservedClaims.length === 1 && matchingClaims.length !== 1)) {
      throw rewriteValidationError(
        'delta_claim_missing',
        campaignId,
        nodeId,
        reservedClaims.length > 1
          ? 'the idea card carries multiple engine-reserved novelty-delta claims — ambiguous to synchronize; revise the card to one or zero reserved claims first'
          : 'the retained engine-reserved novelty-delta claim does not use the closest_prior identity stored in operator_trace; withdraw or correct the claim through node.revise_card before correcting provenance',
        {
          matching_claim_count: matchingClaims.length,
          reserved_claim_count: reservedClaims.length,
        },
      );
    }
    const deltaClaimUpdated = matchingClaims.length === 1;
    if (deltaClaimUpdated) {
      const claimRecord = matchingClaims[0]!;
      claimRecord.claim_text = `${NOVELTY_DELTA_CLAIM_PREFIX}${newValue}): ${(claimRecord.claim_text as string).slice(expectedPrefix.length)}`;
      const currentEvidenceUris = Array.isArray(claimRecord.evidence_uris)
        ? claimRecord.evidence_uris.filter(isNonEmptyString)
        : [];
      const preservedEvidenceUris = currentEvidenceUris.filter((uri) => uri !== previousValue && uri !== newValue);
      claimRecord.evidence_uris = newValue.includes('://')
        ? [newValue, ...preservedEvidenceUris]
        : preservedEvidenceUris;
    }

    // When the active novelty-delta claim changes, any grounding_audit covered
    // the prior text and must be reset. If the reviewed card had already
    // withdrawn that claim, only the current provenance trace changes and the
    // card-grounding result remains about the same scientific claims.
    const groundingAuditReset = deltaClaimUpdated && updatedNode.grounding_audit != null;
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
      delta_claim_updated: deltaClaimUpdated,
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
      delta_claim_updated: deltaClaimUpdated,
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
