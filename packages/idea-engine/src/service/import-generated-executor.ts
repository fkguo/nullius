import { pathToFileURL } from 'url';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { payloadHash } from '../hash/payload-hash.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { RpcError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './campaign-state.js';
import { PLACEHOLDER_EVIDENCE_URI } from './node-shared.js';
import { drawUniqueId } from './seed-node.js';
import { buildGeneratedNode, type GeneratedCandidate } from './generated-node.js';
import { IMPORT_ARTIFACT_TYPE, IMPORT_GENERATED_METHOD } from './import-generated-recovery.js';
import { toSchemaError } from './service-contract-error.js';

/**
 * Trigger kinds a V0 import accepts. The remaining vocabulary kinds are
 * reserved (schema-legal, import-rejected) until their seam is exercised end
 * to end — e.g. match_concluded waits for a real-campaign tournament run.
 */
const ENABLED_TRIGGER_KINDS = ['manual', 'survey_updated', 'failure_recorded'] as const;

interface ArityRule {
  exact?: number;
  max?: number;
  min?: number;
}

/**
 * The committed operator-family taxonomy and its parent arity. This table is
 * the design-level authority (operator_family stays a free string in the node
 * schema); adding a family is a deliberate validator change, never schema
 * drift. Seed is deliberately absent: seed nodes are only creatable through
 * campaign.init seed import.
 */
const OPERATOR_FAMILY_ARITY: Record<string, ArityRule> = {
  AnalogyTransfer: { max: 1, min: 0 },
  FailureRouting: { max: 1, min: 0 },
  LiteratureMining: { exact: 0 },
  Mutation: { exact: 1 },
  Recombination: { min: 2 },
};

const RESERVED_TRACE_INPUT_KEYS = ['trigger', 'pack_artifact', 'parent_revisions'] as const;

/** delta_type values declared non-novel by construction (design §5.3). */
const NON_NOVEL_DELTA_TYPES = new Set(['parameter_tweak', 'rewording']);

function importValidationError(
  reason: string,
  campaignId: string,
  message: string,
  details: Record<string, unknown> = {},
): RpcError {
  return new RpcError(-32002, 'schema_validation_failed', {
    reason,
    campaign_id: campaignId,
    details: { message, ...details },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function claimEvidenceUris(cardFields: Record<string, unknown>): string[] {
  const uris: string[] = [];
  const claims = Array.isArray(cardFields.claims) ? cardFields.claims : [];
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) continue;
    const claimUris = (claim as Record<string, unknown>).evidence_uris;
    if (!Array.isArray(claimUris)) continue;
    for (const uri of claimUris) {
      if (typeof uri === 'string') uris.push(uri);
    }
  }
  return uris;
}

function receiptUris(traceInputs: Record<string, unknown>): Set<string> {
  const receipts = new Set<string>();
  const raw = traceInputs.retrieval_receipts;
  if (!Array.isArray(raw)) {
    return receipts;
  }
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (isNonEmptyString(record.uri) && isNonEmptyString(record.source)) {
      receipts.add(record.uri);
    }
  }
  return receipts;
}

/**
 * Semantic validation of one candidate beyond the generation_pack_v1 schema:
 * the arity table, engine-reserved trace keys, retrieval-receipt coverage of
 * every evidence URI, the placeholder ban, per-family anchor rules (tension /
 * re-anchored gap / failure refs), the non-novel delta_type rejection, and
 * parent existence + parent_revisions coverage.
 */
function validateCandidateSemantics(options: {
  campaignId: string;
  candidate: GeneratedCandidate;
  existingNodes: Record<string, Record<string, unknown>>;
  index: number;
  parentRevisions: Record<string, number>;
}): void {
  const { campaignId, candidate, index } = options;
  const label = `candidates[${index}]`;
  const provenance = candidate.provenance;
  const family = String(provenance.operator_family);

  const rule = OPERATOR_FAMILY_ARITY[family];
  if (!rule) {
    const known = Object.keys(OPERATOR_FAMILY_ARITY).sort().join(', ');
    const seedHint = family === 'Seed' ? ' (Seed nodes are only creatable via campaign.init seed import)' : '';
    throw importValidationError(
      'operator_family_unknown',
      campaignId,
      `${label}: operator_family '${family}' is not in the committed taxonomy${seedHint}; known families: ${known}`,
    );
  }

  const parents = (provenance.parent_node_ids as string[] | undefined) ?? [];
  if (new Set(parents).size !== parents.length) {
    throw importValidationError('operator_arity_invalid', campaignId, `${label}: parent_node_ids contains duplicates`);
  }
  const arityViolated = (rule.exact !== undefined && parents.length !== rule.exact)
    || (rule.min !== undefined && parents.length < rule.min)
    || (rule.max !== undefined && parents.length > rule.max);
  if (arityViolated) {
    throw importValidationError('operator_arity_invalid', campaignId, `${label}: operator_family ${family} requires ${
      rule.exact !== undefined
        ? `exactly ${rule.exact}`
        : rule.min !== undefined && rule.max !== undefined
          ? `between ${rule.min} and ${rule.max}`
          : rule.min !== undefined
            ? `at least ${rule.min}`
            : `at most ${rule.max}`
    } parent_node_ids, got ${parents.length}`);
  }
  if (family === 'AnalogyTransfer') {
    const mapping = candidate.rationale_draft.analogy_mapping;
    if (!Array.isArray(mapping) || mapping.length === 0) {
      throw importValidationError(
        'operator_arity_invalid',
        campaignId,
        `${label}: AnalogyTransfer requires a non-empty rationale_draft.analogy_mapping`,
      );
    }
  }

  for (const parentId of parents) {
    const parent = options.existingNodes[parentId];
    if (!parent) {
      throw new RpcError(-32004, 'node_not_found', {
        reason: 'node_not_found',
        campaign_id: campaignId,
        node_id: parentId,
      });
    }
    if (!(parentId in options.parentRevisions)) {
      throw importValidationError(
        'parent_revisions_missing',
        campaignId,
        `${label}: parent ${parentId} has no entry in evidence_snapshot.parent_revisions (record the revision read at generation time)`,
        { node_id: parentId },
      );
    }
  }

  const traceInputs = provenance.trace_inputs as Record<string, unknown>;
  for (const key of RESERVED_TRACE_INPUT_KEYS) {
    if (key in traceInputs) {
      throw importValidationError(
        'trace_key_reserved',
        campaignId,
        `${label}: trace_inputs.${key} is engine-owned and must not be supplied by the generator`,
      );
    }
  }
  const traceParams = provenance.trace_params as Record<string, unknown>;
  if ('formalization' in traceParams) {
    throw importValidationError(
      'trace_key_reserved',
      campaignId,
      `${label}: trace_params.formalization is engine-owned (explain_then_formalize is computed at import)`,
    );
  }

  const evidenceUsed = (provenance.evidence_uris_used as string[] | undefined) ?? [];
  const claimUris = claimEvidenceUris(candidate.card_fields);
  for (const uri of [...evidenceUsed, ...claimUris]) {
    if (uri === PLACEHOLDER_EVIDENCE_URI) {
      throw importValidationError(
        'placeholder_evidence_forbidden',
        campaignId,
        `${label}: the seed placeholder evidence URI is forbidden in generated candidates — real anchors or claims typed llm_inference/assumption`,
      );
    }
  }
  const receipts = receiptUris(traceInputs);
  for (const uri of claimUris) {
    if (!evidenceUsed.includes(uri)) {
      throw importValidationError(
        'evidence_receipt_missing',
        campaignId,
        `${label}: claim evidence URI is not listed in provenance.evidence_uris_used`,
        { uri },
      );
    }
  }
  for (const uri of new Set([...evidenceUsed, ...claimUris])) {
    if (!receipts.has(uri)) {
      throw importValidationError(
        'evidence_receipt_missing',
        campaignId,
        `${label}: evidence URI has no retrieval receipt in trace_inputs.retrieval_receipts ({uri, source} pairs) — no retrieval receipt, no URI`,
        { uri },
      );
    }
  }

  if (family === 'LiteratureMining') {
    const anchor = traceInputs.anchor;
    const anchorRecord = anchor && typeof anchor === 'object' && !Array.isArray(anchor)
      ? anchor as Record<string, unknown>
      : null;
    if (!anchorRecord) {
      throw importValidationError(
        'anchor_missing',
        campaignId,
        `${label}: LiteratureMining requires trace_inputs.anchor ({kind: tension|gap, ...})`,
      );
    }
    if (anchorRecord.kind === 'tension') {
      const refKeys = anchorRecord.ref_keys;
      if (!isNonEmptyString(anchorRecord.statement) || !Array.isArray(refKeys) || refKeys.length === 0
        || !refKeys.every(isNonEmptyString)) {
        throw importValidationError(
          'anchor_missing',
          campaignId,
          `${label}: a tension anchor requires a statement and non-empty ref_keys (the survey tension entry)`,
        );
      }
    } else if (anchorRecord.kind === 'gap') {
      const resolvedRefs = anchorRecord.resolved_refs;
      const refs = Array.isArray(resolvedRefs) ? resolvedRefs.filter(isNonEmptyString) : [];
      if (refs.length === 0 || !Array.isArray(resolvedRefs) || refs.length !== resolvedRefs.length) {
        throw importValidationError(
          'gap_unanchored',
          campaignId,
          `${label}: survey gaps are bare strings — a gap-derived candidate must first resolve the gap to real references (anchor.resolved_refs); no resolved references, no gap idea`,
        );
      }
      for (const ref of refs) {
        if (!receipts.has(ref)) {
          throw importValidationError(
            'gap_unanchored',
            campaignId,
            `${label}: gap anchor.resolved_refs entry has no retrieval receipt`,
            { uri: ref },
          );
        }
      }
    } else {
      throw importValidationError(
        'anchor_missing',
        campaignId,
        `${label}: trace_inputs.anchor.kind must be 'tension' or 'gap'`,
      );
    }
  }

  if (family === 'FailureRouting' && parents.length === 0) {
    const refs = traceInputs.failed_approach_refs;
    if (!Array.isArray(refs) || refs.length === 0 || !refs.every(isNonEmptyString)) {
      throw importValidationError(
        'anchor_missing',
        campaignId,
        `${label}: a parentless FailureRouting candidate requires non-empty trace_inputs.failed_approach_refs (the ledger entries it reroutes around)`,
      );
    }
  }

  const deltaType = String(candidate.novelty_delta.delta_type);
  if (NON_NOVEL_DELTA_TYPES.has(deltaType)) {
    throw importValidationError(
      'novelty_delta_non_novel',
      campaignId,
      `${label}: delta_type '${deltaType}' is declared non-novel by construction — a parameter tweak or rewording is not an importable idea`,
    );
  }
}

/**
 * node.import_generated: the only entry point for derived (non-seed) nodes.
 * See the OpenRPC method description for the full contract. Write order is
 * load-bearing for crash recovery (import-generated-recovery.ts):
 * prepared idempotency record → pack artifact → nodes → node-log entries →
 * campaign usage → committed idempotency record.
 */
export function executeImportGenerated(options: {
  contracts: IdeaEngineContractCatalog;
  createId: () => string;
  now: () => string;
  params: Record<string, unknown>;
  payloadHash: string;
  store: IdeaEngineStore;
}): Record<string, unknown> {
  const campaignId = String(options.params.campaign_id);
  const pack = options.params.pack as Record<string, unknown>;
  const idempotencyKeyValue = String(options.params.idempotency_key);
  return options.store.withMutationLock(campaignId, () => {
    const replay = recordOrReplay({
      campaignId,
      idempotencyKeyValue,
      method: IMPORT_GENERATED_METHOD,
      payloadHash: options.payloadHash,
      store: options.store,
    });
    if (replay) {
      if (replay.kind === 'error') {
        throw new RpcError(-32603, 'internal_error', replay.payload);
      }
      return replay.payload;
    }

    if (String(pack.campaign_id) !== campaignId) {
      throw importValidationError(
        'pack_campaign_mismatch',
        campaignId,
        `pack.campaign_id '${String(pack.campaign_id)}' does not match the campaign_id param`,
      );
    }

    const campaign = loadCampaignOrError(options.store, campaignId);
    ensureCampaignRunning(campaign);

    const trigger = pack.trigger as Record<string, unknown>;
    const triggerKind = String(trigger.kind);
    if (!(ENABLED_TRIGGER_KINDS as readonly string[]).includes(triggerKind)) {
      throw importValidationError(
        'trigger_not_enabled',
        campaignId,
        `trigger.kind '${triggerKind}' is reserved vocabulary, not yet enabled for import`,
        { enabled: [...ENABLED_TRIGGER_KINDS] },
      );
    }
    if (triggerKind !== 'manual' && !isNonEmptyString(trigger.artifact_ref)) {
      throw importValidationError(
        'trigger_not_enabled',
        campaignId,
        `trigger.kind '${triggerKind}' requires trigger.artifact_ref (the evidence-delta artifact)`,
      );
    }

    const nodes = options.store.loadNodes<Record<string, unknown>>(campaignId);
    const evidenceSnapshot = (pack.evidence_snapshot ?? {}) as Record<string, unknown>;
    const parentRevisions = (evidenceSnapshot.parent_revisions ?? {}) as Record<string, number>;
    const candidates = pack.candidates as GeneratedCandidate[];
    candidates.forEach((candidate, index) => validateCandidateSemantics({
      campaignId,
      candidate,
      existingNodes: nodes as Record<string, Record<string, unknown>>,
      index,
      parentRevisions,
    }));

    const currentCount = Object.keys(nodes).length;
    const maxNodes = campaign.budget.max_nodes;
    if (maxNodes !== null && maxNodes !== undefined && currentCount + candidates.length > Number(maxNodes)) {
      throw new RpcError(-32001, 'budget_exhausted', {
        reason: 'dimension_exhausted',
        campaign_id: campaignId,
        details: {
          exhausted_dimensions: ['nodes'],
          max_nodes: Number(maxNodes),
          nodes_used: currentCount,
          requested: candidates.length,
        },
      });
    }

    const now = options.now();
    const usedHandleIds = new Set<string>([campaignId]);
    for (const [nodeId, node] of Object.entries(nodes)) {
      usedHandleIds.add(nodeId);
      usedHandleIds.add(String((node as Record<string, unknown>).idea_id));
    }
    const packId = drawUniqueId(options.createId, id => usedHandleIds.has(id));
    usedHandleIds.add(packId);
    const packArtifactName = `pack-${packId}.json`;
    const packArtifactRef = pathToFileURL(
      options.store.artifactPath(campaignId, IMPORT_ARTIFACT_TYPE, packArtifactName),
    ).href;
    const packHash = payloadHash(pack);

    const assembledNodes: Record<string, Record<string, unknown>> = {};
    const imported: Array<Record<string, unknown>> = [];
    candidates.forEach((candidate, index) => {
      const nodeId = drawUniqueId(options.createId, id => usedHandleIds.has(id));
      usedHandleIds.add(nodeId);
      const ideaId = drawUniqueId(options.createId, id => usedHandleIds.has(id));
      usedHandleIds.add(ideaId);
      const node = buildGeneratedNode({
        campaignId,
        candidate,
        ideaId,
        nodeId,
        now,
        packArtifactRef,
        parentRevisions,
        trigger,
      });
      try {
        options.contracts.validateAgainstRef('./idea_node_v1.schema.json', node, `import_generated/node/${index}`);
      } catch (error) {
        throw toSchemaError(error, `generated node ${index} invalid: `);
      }
      assembledNodes[nodeId] = node;
      imported.push({
        idea_id: ideaId,
        node_id: nodeId,
        operator_family: String(candidate.provenance.operator_family),
        operator_id: String(candidate.provenance.operator_id),
      });
    });

    const plannedCampaign = structuredClone(campaign);
    plannedCampaign.usage.nodes_used = currentCount + candidates.length;
    // Import consumes the nodes dimension only (analogous to set_posterior's
    // "does not consume step budget"): steps stay untouched, which also keeps
    // crash recovery free of unrecoverable counter arithmetic.
    setCampaignRunningIfBudgetAvailable(plannedCampaign);

    const result: Record<string, unknown> = {
      budget_snapshot: budgetSnapshot(plannedCampaign),
      campaign_id: campaignId,
      created_at: now,
      idempotency: responseIdempotency(idempotencyKeyValue, options.payloadHash),
      imported,
      imported_count: imported.length,
      pack_artifact_ref: packArtifactRef,
      pack_hash: packHash,
      rejected_count: (pack.rejected_candidates as unknown[]).length,
    };
    options.contracts.validateResult(IMPORT_GENERATED_METHOD, result);

    const archive: Record<string, unknown> = {
      engine_assembled: {
        imported_at: now,
        method: IMPORT_GENERATED_METHOD,
        nodes: assembledNodes,
      },
      pack: structuredClone(pack),
      pack_hash: packHash,
    };

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: IMPORT_GENERATED_METHOD,
      payload: result,
      payloadHash: options.payloadHash,
      state: 'prepared',
      store: options.store,
    });

    options.store.writeArtifact(campaignId, IMPORT_ARTIFACT_TYPE, packArtifactName, archive);
    for (const [nodeId, node] of Object.entries(assembledNodes)) {
      nodes[nodeId] = node;
    }
    options.store.saveNodes(campaignId, nodes);
    for (const node of Object.values(assembledNodes)) {
      options.store.appendNodeLog(campaignId, node, 'create', {
        method: IMPORT_GENERATED_METHOD,
        pack_artifact_ref: packArtifactRef,
      });
    }
    options.store.saveCampaign(plannedCampaign as Record<string, unknown> & { campaign_id: string });

    storeIdempotency({
      campaignId,
      createdAt: now,
      idempotencyKeyValue,
      kind: 'result',
      method: IMPORT_GENERATED_METHOD,
      payload: result,
      payloadHash: options.payloadHash,
      state: 'committed',
      store: options.store,
    });
    return result;
  });
}
