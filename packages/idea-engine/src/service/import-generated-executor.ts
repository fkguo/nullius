import { createHash } from 'crypto';
import { existsSync } from 'fs';
import type { IdeaEngineContractCatalog } from '../contracts/catalog.js';
import type { IdeaEngineStore } from '../store/engine-store.js';
import { payloadHash } from '../hash/payload-hash.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { RpcError } from './errors.js';
import { recordOrReplay, responseIdempotency, storeIdempotency } from './idempotency.js';
import { ensureCampaignRunning, loadCampaignOrError, setCampaignRunningIfBudgetAvailable } from './campaign-state.js';
import { nodeLifecycleState, PLACEHOLDER_EVIDENCE_URI } from './node-shared.js';
import { drawUniqueId } from './seed-node.js';
import { buildGeneratedNode, type GeneratedCandidate } from './generated-node.js';
import { IMPORT_ARTIFACT_TYPE, IMPORT_GENERATED_METHOD, refreshImportGeneratedReplay } from './import-generated-recovery.js';
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

/**
 * Families a V0 import actually accepts — same treatment as trigger kinds:
 * the rest of the taxonomy is committed vocabulary (arity table above) but
 * import-rejected (operator_family_not_enabled) until each family's evidence
 * discipline (design §5: delta claims for Mutation, bridge claims for
 * Recombination, per-edge source verification for AnalogyTransfer) lands in
 * this validator. Prose in a skill is not a gate; the engine is the authority.
 */
const ENABLED_OPERATOR_FAMILIES = ['LiteratureMining', 'FailureRouting'] as const;

const RESERVED_TRACE_INPUT_KEYS = [
  'trigger',
  'pack_artifact',
  'parent_revisions',
  'target_admission_route',
  'dedup',
  'novelty_delta',
] as const;

/**
 * The design's fixed auto-drop bound (§5.2): a dedup record claiming
 * decision=unique at or above this similarity is self-contradictory and the
 * pack is refused (dedup_inconsistent) — the engine cannot recompute the
 * similarity, but it can refuse records that contradict themselves.
 */
const DEDUP_AUTO_DROP_BOUND = 0.95;

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

/** Every string anywhere in the value tree — the "appears anywhere" scan. */
function collectStrings(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, sink);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, sink);
  }
}

function looksLikeUri(value: string): boolean {
  return value.includes('://');
}

function sha256OfText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Normalized duplicate key over the candidate's rationale draft (intra-pack backstop). */
function candidateDuplicateKey(candidate: GeneratedCandidate): string {
  const draft = candidate.rationale_draft;
  const normalize = (value: unknown): string =>
    typeof value === 'string' ? value.toLowerCase().trim().split(/\s+/).join(' ') : '';
  return `${normalize(draft.title)}|${normalize(draft.rationale)}`;
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
  ledgerRefs: Set<string>;
  parentRevisions: Record<string, number>;
  surveyPinned: boolean;
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
  if (!(ENABLED_OPERATOR_FAMILIES as readonly string[]).includes(family)) {
    throw importValidationError(
      'operator_family_not_enabled',
      campaignId,
      `${label}: operator_family '${family}' is committed vocabulary but not yet enabled for import — its evidence discipline has not landed in this validator`,
      { enabled: [...ENABLED_OPERATOR_FAMILIES] },
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
    // The recorded read-time revision must be one the parent has actually
    // had: a fabricated future revision would stamp fiction into the
    // engine-owned trace.
    const recordedRevision = Number(options.parentRevisions[parentId]);
    const currentRevision = Number((parent as Record<string, unknown>).revision ?? 0);
    if (!Number.isInteger(recordedRevision) || recordedRevision < 1 || recordedRevision > currentRevision) {
      throw importValidationError(
        'parent_revision_invalid',
        campaignId,
        `${label}: recorded parent revision ${recordedRevision} for ${parentId} is not a revision the parent has had (current: ${currentRevision})`,
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

  // "Appears anywhere" means anywhere: scan every string in the candidate.
  const allStrings: string[] = [];
  collectStrings(candidate, allStrings);
  if (allStrings.includes(PLACEHOLDER_EVIDENCE_URI)) {
    throw importValidationError(
      'placeholder_evidence_forbidden',
      campaignId,
      `${label}: the seed placeholder evidence URI is forbidden anywhere in a generated candidate — real anchors or claims typed llm_inference/assumption`,
    );
  }

  const evidenceUsed = (provenance.evidence_uris_used as string[] | undefined) ?? [];
  const claimUris = claimEvidenceUris(candidate.card_fields);
  const draftReferences = (Array.isArray(candidate.rationale_draft.references)
    ? candidate.rationale_draft.references
    : []).filter((uri): uri is string => typeof uri === 'string');
  const closestPrior = String(candidate.novelty_delta.closest_prior ?? '');
  const uriShapedClosestPrior = looksLikeUri(closestPrior) ? [closestPrior] : [];

  const receipts = receiptUris(traceInputs);
  for (const uri of [...claimUris, ...draftReferences, ...uriShapedClosestPrior]) {
    if (!evidenceUsed.includes(uri)) {
      throw importValidationError(
        'evidence_receipt_missing',
        campaignId,
        `${label}: evidence URI (claim, rationale_draft.references, or URI-shaped novelty_delta.closest_prior) is not listed in provenance.evidence_uris_used`,
        { uri },
      );
    }
  }
  for (const uri of new Set([...evidenceUsed, ...claimUris, ...draftReferences, ...uriShapedClosestPrior])) {
    if (!receipts.has(uri)) {
      throw importValidationError(
        'evidence_receipt_missing',
        campaignId,
        `${label}: evidence URI has no retrieval receipt in trace_inputs.retrieval_receipts ({uri, source} pairs) — no retrieval receipt, no URI`,
        { uri },
      );
    }
  }

  // A self-contradictory dedup record is refused: the engine cannot recompute
  // similarity, but decision=unique at/above the fixed auto-drop bound cannot
  // both be true.
  const dedup = candidate.dedup;
  const nearestSimilarity = typeof dedup.nearest_similarity === 'number' ? dedup.nearest_similarity : null;
  if (dedup.decision === 'unique' && nearestSimilarity !== null && nearestSimilarity >= DEDUP_AUTO_DROP_BOUND) {
    throw importValidationError(
      'dedup_inconsistent',
      campaignId,
      `${label}: dedup.decision=unique contradicts nearest_similarity ${nearestSimilarity} >= ${DEDUP_AUTO_DROP_BOUND} (the fixed auto-drop bound)`,
    );
  }

  if (family === 'LiteratureMining') {
    // Tension/gap anchors come FROM a survey; an unpinned snapshot would
    // leave the anchor's ref_keys pointing into nothing reconstructable.
    if (!options.surveyPinned) {
      throw importValidationError(
        'evidence_snapshot_missing',
        campaignId,
        `${label}: LiteratureMining requires evidence_snapshot.survey_artifact_ref (and survey_content_hash) pinning the survey the anchor was mined from`,
      );
    }
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

  if (family === 'FailureRouting') {
    if (parents.length === 0) {
      const refs = traceInputs.failed_approach_refs;
      if (!Array.isArray(refs) || refs.length === 0 || !refs.every(isNonEmptyString)) {
        throw importValidationError(
          'anchor_missing',
          campaignId,
          `${label}: a parentless FailureRouting candidate requires non-empty trace_inputs.failed_approach_refs (the ledger entries it reroutes around)`,
        );
      }
      // The refs must be pinned at pack level: an invented free string is not
      // a failure anchor. evidence_snapshot.failed_approach_refs is the
      // burst's declared ledger reading, like survey pinning for tensions.
      for (const ref of refs) {
        if (!options.ledgerRefs.has(String(ref))) {
          throw importValidationError(
            'anchor_missing',
            campaignId,
            `${label}: failed_approach_ref is not pinned in evidence_snapshot.failed_approach_refs (declare the ledger entries the burst actually read)`,
            { uri: String(ref) },
          );
        }
      }
    } else {
      // Rerouting an existing node's recorded failure only makes sense for a
      // node that actually DIED: the parent must be archived.
      const parent = options.existingNodes[parents[0]!]!;
      if (nodeLifecycleState(parent) !== 'archived') {
        throw importValidationError(
          'anchor_missing',
          campaignId,
          `${label}: a parented FailureRouting candidate must reroute an ARCHIVED parent (its recorded kill criteria are the failure anchor); the parent is ${nodeLifecycleState(parent)}`,
          { node_id: parents[0] },
        );
      }
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
      return refreshImportGeneratedReplay(options.store, idempotencyKeyValue, replay.payload);
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
    const surveyPinned = isNonEmptyString(evidenceSnapshot.survey_artifact_ref)
      && isNonEmptyString(evidenceSnapshot.survey_content_hash);
    const ledgerRefs = new Set<string>(
      (Array.isArray(evidenceSnapshot.failed_approach_refs) ? evidenceSnapshot.failed_approach_refs : [])
        .filter(isNonEmptyString),
    );
    const candidates = pack.candidates as GeneratedCandidate[];
    candidates.forEach((candidate, index) => validateCandidateSemantics({
      campaignId,
      candidate,
      existingNodes: nodes as Record<string, Record<string, unknown>>,
      index,
      ledgerRefs,
      parentRevisions,
      surveyPinned,
    }));

    // Intra-pack duplicate backstop: the vector dedup lives in the skill, but
    // the engine refuses the degenerate case it can check exactly — two
    // candidates in one burst with the same normalized rationale draft.
    const seenDuplicateKeys = new Map<string, number>();
    candidates.forEach((candidate, index) => {
      const key = candidateDuplicateKey(candidate);
      const earlier = seenDuplicateKeys.get(key);
      if (earlier !== undefined) {
        throw importValidationError(
          'intra_pack_duplicate',
          campaignId,
          `candidates[${index}] duplicates candidates[${earlier}] (same normalized rationale draft) — one burst must not import near-identical twins`,
          { duplicate_of: earlier, index },
        );
      }
      seenDuplicateKeys.set(key, index);
    });

    // Prompt-snapshot verification (MANDATORY): every candidate must declare
    // prompt_snapshot_hash, backed by a snapshot archived with this pack whose
    // content hashes to exactly that value — otherwise the design's
    // reproducibility statement ("a third party can reconstruct exactly what
    // the generator saw") is unverifiable by construction. origin.prompt_hash
    // hashes the same rendered prompt, so the two must agree.
    const snapshotsRaw = Array.isArray(pack.prompt_snapshots) ? pack.prompt_snapshots as Array<Record<string, unknown>> : [];
    const snapshotHashes = new Set<string>();
    snapshotsRaw.forEach((snapshot, index) => {
      const hash = String(snapshot.hash ?? '');
      const content = String(snapshot.content ?? '');
      if (sha256OfText(content) !== hash) {
        throw importValidationError(
          'prompt_snapshot_missing',
          campaignId,
          `prompt_snapshots[${index}].content does not hash to its declared hash`,
        );
      }
      snapshotHashes.add(hash);
    });
    candidates.forEach((candidate, index) => {
      const declared = candidate.provenance.prompt_snapshot_hash;
      if (typeof declared !== 'string' || declared.length === 0) {
        throw importValidationError(
          'prompt_snapshot_missing',
          campaignId,
          `candidates[${index}] must declare provenance.prompt_snapshot_hash — prompt provenance is mandatory for imported candidates`,
        );
      }
      if (!snapshotHashes.has(declared)) {
        throw importValidationError(
          'prompt_snapshot_missing',
          campaignId,
          `candidates[${index}] declares prompt_snapshot_hash but no pack.prompt_snapshots entry carries that content`,
          { prompt_snapshot_hash: declared },
        );
      }
      const origin = candidate.provenance.origin as Record<string, unknown>;
      if (String(origin.prompt_hash) !== declared) {
        throw importValidationError(
          'prompt_snapshot_missing',
          campaignId,
          `candidates[${index}]: origin.prompt_hash must equal prompt_snapshot_hash — both hash the same rendered prompt`,
          { origin_prompt_hash: String(origin.prompt_hash), prompt_snapshot_hash: declared },
        );
      }
    });

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
    // The archived pack is the burst's audit unit: the id draw must also
    // avoid every pack artifact already on disk, and writeArtifact would
    // overwrite silently otherwise.
    const packId = drawUniqueId(options.createId, id =>
      usedHandleIds.has(id)
      || existsSync(options.store.artifactPath(campaignId, IMPORT_ARTIFACT_TYPE, `pack-${id}.json`)));
    usedHandleIds.add(packId);
    const packArtifactName = `pack-${packId}.json`;
    const packHash = payloadHash(pack);
    const packArtifactRef = options.store.portableArtifactRef(
      options.store.artifactPath(campaignId, IMPORT_ARTIFACT_TYPE, packArtifactName),
      packHash,
    );

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

    const archive: Record<string, unknown> = {
      engine_assembled: {
        imported_at: now,
        method: IMPORT_GENERATED_METHOD,
        nodes: assembledNodes,
      },
      pack: structuredClone(pack),
      pack_hash: packHash,
    };
    // archive_hash pins the WHOLE archived artifact — including the
    // engine-assembled node payloads recovery may later re-write. pack_hash
    // alone would leave engine_assembled.nodes an unpinned completion source.
    const archiveHash = payloadHash(archive);

    const result: Record<string, unknown> = {
      archive_hash: archiveHash,
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
