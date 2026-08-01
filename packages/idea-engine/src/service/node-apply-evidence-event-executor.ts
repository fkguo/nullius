import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { RpcError } from './errors.js';
import { sha256Hex } from './sha256-hex.js';
import {
  CONDITION_CARRYING_STATES,
  DEMOTING_LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  lifecycleEntryPreconditionFailure,
  nodeLifecycleState,
  nodePosterior,
  type NodeLifecycleState,
} from './node-shared.js';
import { ensureCampaignNotCompleted, loadCampaignOrError } from './campaign-state.js';

interface Disposition {
  node_id: string;
  lifecycle_state: NodeLifecycleState;
  reason?: string;
  activation_condition?: Record<string, unknown> | null;
}

interface DispositionFailure {
  node_id: string;
  check: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * node.apply_evidence_event: one evidence artifact caused lifecycle
 * dispositions on several nodes — record that as ONE event instead of N
 * unrelated single-node calls. The field pattern this serves: a single lane
 * report demotes or archives half the portfolio in seconds, and the only
 * thing tying the writes together is a caller-side idempotency-key naming
 * convention the ledger never stores.
 *
 * Semantics:
 * - every disposition is validated against the SAME rules as
 *   node.set_lifecycle (transition table, entry preconditions,
 *   activation-condition shape, archived-reason requirement) — nothing this
 *   method accepts would be rejected one call at a time;
 * - validate-then-commit is batch-atomic: ALL failures are reported in one
 *   error (batch_dispositions_invalid, details.failures lists every failing
 *   disposition) and nothing is applied on any failure — a partial sweep
 *   cannot happen, and a resubmission fixes the whole batch in one round;
 * - demotion marks a current posterior stale exactly as node.set_lifecycle
 *   does;
 * - each node's mutation-log entry carries the shared event_group (derived
 *   from the idempotency key AND the payload hash: stable under replay of
 *   the same key+payload, and distinct across keys up to the accepted
 *   truncated-48-bit-hash collision odds — deterministic collisions are
 *   eliminated), the evidence_ref, and the shared event_reason — the group
 *   binding is engine-recorded;
 * - evidence_ref is stored verbatim (report_ref / survey_ref precedent):
 *   shape is contract-checked (project-portable, hash-bound), whether the
 *   artifact supports the dispositions stays a project-side audit concern.
 * Does not consume step budget. Allowed in any campaign state except
 * completed.
 */
export function executeNodeApplyEvidenceEvent(options: {
  contracts: IdeaEngineContractCatalog;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const idempotencyKeyValue = String(options.params.idempotency_key);
  const evidenceRef = String(options.params.evidence_ref);
  const eventReason = String(options.params.event_reason);
  const dispositions = options.params.dispositions as Disposition[];

  // The params-schema pattern already rejects a machine-absolute form
  // (leading '/'); segment rules need code: no empty / '.' / '..' segments
  // and valid percent-encoding — the same path rules the store's
  // project-reference parser enforces, minus its store-root checks (evidence
  // artifacts legitimately live outside the idea store, so the reference is
  // stored verbatim, never resolved here).
  const refBody = evidenceRef.slice('project://'.length, evidenceRef.indexOf('#'));
  const segments = refBody.split('/');
  const segmentsInvalid = segments.some(segment => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    // Judge the DECODED segment: %2e%2e is '..', %5C is a backslash. A drive
    // prefix (':') or a backslash would re-anchor the path on some platforms;
    // dot segments traverse.
    return decoded === ''
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || decoded.includes(':');
  });
  if (segmentsInvalid) {
    const data = {
      reason: 'schema_invalid',
      campaign_id: campaignId,
      details: {
        message: `evidence_ref path is not a safe project-relative reference (empty, '.', '..', or badly percent-encoded segment): ${evidenceRef}`,
      },
    };
    options.contracts.validateErrorData(data);
    throw new RpcError(-32002, 'schema_validation_failed', data);
  }

  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: 'node.apply_evidence_event',
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

    // Validation pass: collect EVERY failure before applying anything.
    const failures: DispositionFailure[] = [];
    const seenNodeIds = new Set<string>();
    for (const disposition of dispositions) {
      const nodeId = String(disposition.node_id);
      const targetState = disposition.lifecycle_state;
      if (seenNodeIds.has(nodeId)) {
        failures.push({
          node_id: nodeId,
          check: 'duplicate_disposition_node',
          message: 'a node may appear at most once per evidence event',
        });
        continue;
      }
      seenNodeIds.add(nodeId);

      const node = nodes[nodeId];
      if (!node) {
        failures.push({ node_id: nodeId, check: 'node_not_found', message: 'no such node in this campaign' });
        continue;
      }
      if (node.campaign_id !== campaignId) {
        failures.push({ node_id: nodeId, check: 'node_not_in_campaign', message: 'node belongs to another campaign' });
        continue;
      }

      const activationCondition = disposition.activation_condition;
      const hasActivationCondition = activationCondition !== undefined && activationCondition !== null;
      const targetCarriesCondition = (CONDITION_CARRYING_STATES as readonly string[]).includes(targetState);
      if (targetCarriesCondition && !hasActivationCondition) {
        failures.push({
          node_id: nodeId,
          check: 'activation_condition_required',
          message: `lifecycle_state=${targetState} requires activation_condition`,
        });
        continue;
      }
      if (!targetCarriesCondition && hasActivationCondition) {
        failures.push({
          node_id: nodeId,
          check: 'activation_condition_unexpected',
          message: `lifecycle_state=${targetState} must not carry activation_condition`,
        });
        continue;
      }
      const dispositionReason = typeof disposition.reason === 'string' && disposition.reason.length > 0
        ? disposition.reason
        : null;
      if (targetState === 'archived' && dispositionReason === null) {
        failures.push({
          node_id: nodeId,
          check: 'archived_reason_required',
          message: 'lifecycle_state=archived requires a non-empty per-node reason',
        });
        continue;
      }

      const currentState = nodeLifecycleState(node);
      const allowedNext = LIFECYCLE_TRANSITIONS[currentState];
      if (!allowedNext.includes(targetState)) {
        failures.push({
          node_id: nodeId,
          check: 'illegal_transition',
          message: `no transition ${currentState} -> ${targetState}`,
          details: { current_state: currentState, requested_state: targetState, allowed_next: [...allowedNext] },
        });
        continue;
      }
      const preconditionFailure = lifecycleEntryPreconditionFailure(targetState, node);
      if (preconditionFailure) {
        failures.push({
          node_id: nodeId,
          check: 'entry_precondition_failed',
          message: preconditionFailure.message,
          details: { current_state: currentState, requested_state: targetState, requirement: preconditionFailure.requirement },
        });
      }
    }

    if (failures.length > 0) {
      const data = {
        reason: 'batch_dispositions_invalid',
        campaign_id: campaignId,
        details: {
          failures,
          message: `${failures.length} of ${dispositions.length} disposition(s) invalid; nothing was applied — fix the whole batch in one resubmission`,
        },
      };
      options.contracts.validateErrorData(data);
      throw new RpcError(-32018, 'lifecycle_transition_invalid', data);
    }

    // Apply pass: every disposition validated; mutate the loaded node map,
    // then persist once.
    const now = options.now();
    // The group id must be unique PER OPERATION, not per payload: two
    // operators applying the identical payload under different idempotency
    // keys are two distinct events, and crash recovery tells their ledger
    // lines apart by this id (the payload hash alone would collide them).
    // Same key + same payload still derives the same id — stable under
    // replay.
    const eventGroup = `evt-${sha256Hex(`${idempotencyKeyValue}:${options.payloadHash}`).slice(0, 12)}`;
    const resultNodes: Array<Record<string, unknown>> = [];
    const logExtras: Array<{ node: Record<string, unknown>; extra: Record<string, unknown> }> = [];
    for (const disposition of dispositions) {
      const nodeId = String(disposition.node_id);
      const targetState = disposition.lifecycle_state;
      const node = nodes[nodeId]!;
      const previousState = nodeLifecycleState(node);
      const dispositionReason = typeof disposition.reason === 'string' && disposition.reason.length > 0
        ? disposition.reason
        : null;
      const targetCarriesCondition = (CONDITION_CARRYING_STATES as readonly string[]).includes(targetState);

      const storedPosterior = nodePosterior(node);
      const posteriorMarkedStale = (DEMOTING_LIFECYCLE_STATES as readonly string[]).includes(targetState)
        && storedPosterior !== null
        && storedPosterior.status === 'current';

      const updatedNode = structuredClone(node);
      updatedNode.lifecycle_state = targetState;
      updatedNode.lifecycle_reason = dispositionReason ?? eventReason;
      updatedNode.activation_condition = targetCarriesCondition
        ? structuredClone(disposition.activation_condition ?? null)
        : null;
      if (posteriorMarkedStale) {
        updatedNode.posterior = {
          ...(node.posterior as Record<string, unknown>),
          status: 'stale',
        };
      }
      updatedNode.revision = Number(updatedNode.revision ?? 0) + 1;
      updatedNode.updated_at = now;
      options.contracts.validateAgainstRef('./idea_node_v1.schema.json', updatedNode, `node.apply_evidence_event/node/${nodeId}`);
      nodes[nodeId] = updatedNode;

      resultNodes.push({
        node_id: nodeId,
        previous_state: previousState,
        lifecycle_state: targetState,
        lifecycle_reason: String(updatedNode.lifecycle_reason),
        // The complete written state, so crash recovery can witness it: the
        // activation condition distinguishes same-tuple twins that differ
        // only in the condition they recorded.
        activation_condition: (updatedNode.activation_condition as Record<string, unknown> | null) ?? null,
        revision: Number(updatedNode.revision),
        updated_at: now,
        posterior_marked_stale: posteriorMarkedStale,
      });
      // The extra's shape must be exactly reproducible from the recorded
      // result rows: crash recovery (idempotency.ts) rebuilds missing
      // ledger lines from them, so `reason` is always the APPLIED
      // lifecycle_reason, never conditional.
      logExtras.push({
        node: updatedNode,
        extra: {
          event_group: eventGroup,
          evidence_ref: evidenceRef,
          event_reason: eventReason,
          reason: String(updatedNode.lifecycle_reason),
          ...(posteriorMarkedStale ? { posterior_marked_stale: true } : {}),
        },
      });
    }

    const result = {
      budget_snapshot: budgetSnapshot(campaign),
      campaign_id: campaignId,
      event_group: eventGroup,
      event_reason: eventReason,
      evidence_ref: evidenceRef,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      nodes: resultNodes,
    };
    options.contracts.validateResult('node.apply_evidence_event', result);

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.apply_evidence_event',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.saveNodes(campaignId, nodes);
    for (const { node, extra } of logExtras) {
      options.store.appendNodeLog(campaignId, node, 'apply_evidence_event', extra);
    }

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: 'node.apply_evidence_event',
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
