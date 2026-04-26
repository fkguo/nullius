import { sha256Hex } from './sha256-hex.js';

interface SeedNodeOptions {
  campaignId: string;
  createId: () => string;
  index: number;
  islandId: string;
  now: string;
  seed: Record<string, unknown>;
}

function sanitizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const compact = value.trim().split(/\s+/).join(' ');
  return compact ? compact : fallback;
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
  return cleaned.length > 0 ? cleaned : ['https://example.org/reference'];
}

function rationaleHashForTrace(rationaleDraft: Record<string, unknown>): string {
  const title = sanitizeText(rationaleDraft.title, 'Untitled rationale');
  const rationale = sanitizeText(rationaleDraft.rationale, 'No rationale provided.');
  return `sha256:${sha256Hex(`${title}|${rationale}`)}`;
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
  const nodeId = options.createId();
  const ideaId = options.createId();
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
    island_id: options.islandId,
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
    eval_info: null,
    grounding_audit: null,
    reduction_report: null,
    reduction_audit: null,
    created_at: options.now,
  };
}
