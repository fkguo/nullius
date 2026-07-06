import { payloadHash } from '../hash/payload-hash.js';
import { rationaleHashForTrace, sanitizeText } from './node-shared.js';

/** One schema-validated generation_pack_v1 candidate (see the contract file). */
export interface GeneratedCandidate {
  card_fields: Record<string, unknown>;
  dedup: Record<string, unknown>;
  novelty_delta: Record<string, unknown>;
  provenance: Record<string, unknown>;
  rationale_draft: Record<string, unknown>;
  target_admission_route: string;
}

/**
 * Deterministic Formalize stage for generated candidates (Explain stays with
 * the generation skill). The generator authors rationale_draft + card_fields;
 * the engine derives thesis_statement from the rationale draft with EXACTLY
 * the seed-import rule, passes the schema-validated card fields through
 * verbatim, and computes the formalization trace itself — so a generated node
 * satisfies validateFormalizationTrace (node.promote) by construction and the
 * hash can never drift against a skill-side reimplementation.
 */
export function buildGeneratedNode(options: {
  campaignId: string;
  candidate: GeneratedCandidate;
  ideaId: string;
  nodeId: string;
  now: string;
  packArtifactRef: string;
  parentRevisions: Record<string, number>;
  trigger: Record<string, unknown>;
}): Record<string, unknown> {
  const draft = options.candidate.rationale_draft;
  const provenance = options.candidate.provenance;
  const cardFields = options.candidate.card_fields;

  // Thesis derivation: identical to seed import (buildIdeaCardFromRationaleDraft).
  const title = sanitizeText(draft.title, 'Untitled rationale');
  const rationale = sanitizeText(draft.rationale, 'No rationale provided.');
  let thesisStatement = `${title}: ${rationale}`;
  if (thesisStatement.length < 20) {
    thesisStatement = `${thesisStatement} This rationale requires formal validation before promotion.`;
  }

  const ideaCard: Record<string, unknown> = {
    thesis_statement: thesisStatement,
    testable_hypotheses: structuredClone(cardFields.testable_hypotheses),
    required_observables: structuredClone(cardFields.required_observables),
    minimal_compute_plan: structuredClone(cardFields.minimal_compute_plan),
    claims: structuredClone(cardFields.claims),
  };
  if (cardFields.candidate_formalisms !== undefined) {
    ideaCard.candidate_formalisms = structuredClone(cardFields.candidate_formalisms);
  }

  // Engine-owned trace keys; validateCandidateSemantics has already rejected
  // packs that try to supply trigger/pack_artifact/parent_revisions or
  // params.formalization themselves (trace_key_reserved).
  const traceInputs: Record<string, unknown> = {
    ...structuredClone(provenance.trace_inputs as Record<string, unknown>),
    trigger: structuredClone(options.trigger),
    pack_artifact: options.packArtifactRef,
  };
  const parentIds = (provenance.parent_node_ids as string[] | undefined) ?? [];
  if (parentIds.length > 0) {
    traceInputs.parent_revisions = Object.fromEntries(
      parentIds.map(id => [id, options.parentRevisions[id]]),
    );
  }

  const traceParams: Record<string, unknown> = {
    ...structuredClone(provenance.trace_params as Record<string, unknown>),
    formalization: {
      mode: 'explain_then_formalize_deterministic_v1',
      source_artifact: 'rationale_draft',
      rationale_hash: rationaleHashForTrace(draft),
      // Pins the exact card input the engine assembled from; audit aid only
      // (validateFormalizationTrace checks mode/source/rationale_hash).
      card_fields_hash: payloadHash(cardFields),
    },
  };

  const operatorTrace: Record<string, unknown> = {
    inputs: traceInputs,
    params: traceParams,
    evidence_uris_used: structuredClone(provenance.evidence_uris_used),
  };
  if (typeof provenance.random_seed === 'number') {
    operatorTrace.random_seed = provenance.random_seed;
  }
  if (typeof provenance.prompt_snapshot_hash === 'string') {
    operatorTrace.prompt_snapshot_hash = provenance.prompt_snapshot_hash;
  }

  return {
    campaign_id: options.campaignId,
    idea_id: options.ideaId,
    node_id: options.nodeId,
    revision: 1,
    parent_node_ids: structuredClone(parentIds),
    operator_id: String(provenance.operator_id),
    operator_family: String(provenance.operator_family),
    origin: structuredClone(provenance.origin),
    operator_trace: operatorTrace,
    rationale_draft: structuredClone(draft),
    idea_card: ideaCard,
    lifecycle_state: 'active',
    posterior: null,
    activation_condition: null,
    grounding_audit: null,
    reduction_report: null,
    reduction_audit: null,
    created_at: options.now,
  };
}
