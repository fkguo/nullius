import { PLACEHOLDER_EVIDENCE_URI, rationaleHashForTrace, sanitizeText } from './node-shared.js';
import { sha256Hex } from './sha256-hex.js';

interface SeedNodeOptions {
  campaignId: string;
  createId: () => string;
  existsId?: (id: string) => boolean;
  index: number;
  now: string;
  seed: Record<string, unknown>;
}

/**
 * Draw a fresh handle id from `createId`, skipping any that already exist per
 * `existsId`. This gives short-id collision safety for the production generator
 * while preserving deterministic injected id sequences (which never collide).
 */
export function drawUniqueId(createId: () => string, existsId?: (id: string) => boolean): string {
  if (!existsId) return createId();
  for (let i = 0; i < 16; i += 1) {
    const id = createId();
    if (!existsId(id)) return id;
  }
  throw new Error('seed-node: no free handle id after 16 tries (id space exhausted?)');
}

function sanitizeTextList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const cleaned = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().split(/\s+/).join(' '))
    .filter(item => item.length > 0);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function sanitizeEvidenceUris(value: unknown): string[] {
  const cleaned = sanitizeTextList(value, []);
  return cleaned.length > 0 ? cleaned : [PLACEHOLDER_EVIDENCE_URI];
}

export function buildIdeaCardFromRationaleDraft(options: {
  claimText: unknown;
  computeMethod: string;
  computeStep: string;
  evidenceUris: unknown;
  hypothesis: unknown;
  rationaleDraft: Record<string, unknown>,
  supportType: string;
}): { formalizationTrace: Record<string, unknown>; ideaCard: Record<string, unknown> } {
  const title = sanitizeText(options.rationaleDraft.title, 'Untitled rationale');
  const rationale = sanitizeText(options.rationaleDraft.rationale, 'No rationale provided.');
  const risks = sanitizeTextList(options.rationaleDraft.risks, ['risk not specified']);
  const killCriteria = sanitizeTextList(options.rationaleDraft.kill_criteria, ['kill criterion not specified']);
  let thesisStatement = `${title}: ${rationale}`;
  if (thesisStatement.length < 20) {
    thesisStatement = `${thesisStatement} This rationale requires formal validation before promotion.`;
  }
  const cleanedHypothesis = sanitizeText(options.hypothesis, `${title} should be testable with observable-1.`);
  const cleanedClaim = sanitizeText(
    options.claimText,
    `${title} provides a falsifiable claim that can be checked against observable-1.`,
  );

  return {
    ideaCard: {
      thesis_statement: thesisStatement,
      testable_hypotheses: [cleanedHypothesis],
      required_observables: ['observable-1'],
      minimal_compute_plan: [
        {
          step: options.computeStep,
          method: options.computeMethod,
          estimated_difficulty: 'moderate',
        },
      ],
      claims: [
        {
          claim_text: cleanedClaim,
          support_type: options.supportType,
          evidence_uris: sanitizeEvidenceUris(options.evidenceUris),
        },
      ],
    },
    formalizationTrace: {
      mode: 'explain_then_formalize_deterministic_v1',
      source_artifact: 'rationale_draft',
      rationale_hash: rationaleHashForTrace(options.rationaleDraft),
      input_fields: ['title', 'rationale', 'risks', 'kill_criteria'],
      risk_count: risks.length,
      kill_criteria_count: killCriteria.length,
    },
  };
}

export function buildSeedNode(options: SeedNodeOptions): Record<string, unknown> {
  const content = String(options.seed.content);
  const nodeId = drawUniqueId(options.createId, options.existsId);
  // idea_id must differ from this seed's node_id too (caller adds both to the used
  // set only after buildSeedNode returns).
  const ideaId = drawUniqueId(options.createId, (id) => id === nodeId || (options.existsId?.(id) ?? false));
  const rationaleDraft = {
    title: `Seed ${options.index + 1}`,
    rationale: content,
    risks: ['unverified hypothesis'],
    kill_criteria: ['fails basic consistency checks'],
  };
  const { ideaCard, formalizationTrace } = buildIdeaCardFromRationaleDraft({
    rationaleDraft,
    evidenceUris: options.seed.source_uris,
    hypothesis: `Hypothesis from seed ${options.index + 1}`,
    claimText: `Seed-derived claim: ${content}`,
    supportType: 'literature',
    computeStep: 'construct toy estimate',
    computeMethod: 'toy estimate',
  });
  return {
    campaign_id: options.campaignId,
    idea_id: ideaId,
    node_id: nodeId,
    revision: 1,
    parent_node_ids: [],
    operator_id: 'seed.import',
    operator_family: 'Seed',
    origin: {
      model: 'seed_pack',
      temperature: 0,
      prompt_hash: `sha256:${sha256Hex(content)}`,
      timestamp: options.now,
      role: 'SeedImporter',
    },
    operator_trace: {
      inputs: { seed_type: options.seed.seed_type, seed_index: options.index },
      params: { formalization: formalizationTrace },
      evidence_uris_used: sanitizeEvidenceUris(options.seed.source_uris),
    },
    rationale_draft: rationaleDraft,
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
