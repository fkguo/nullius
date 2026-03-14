import type { SearchOperatorOutput } from './search-operator.js';
import { buildIdeaCardFromRationaleDraft, sanitizeEvidenceUris } from './seed-node.js';
import { sha256Hex } from './sha256-hex.js';

export function buildOperatorNode(options: {
  campaignId: string;
  createId: () => string;
  evidenceUris: string[] | undefined;
  islandId: string;
  now: string;
  operatorOutput: SearchOperatorOutput;
  parentNodeId: string;
}): Record<string, unknown> {
  const rationaleDraft = {
    title: options.operatorOutput.rationaleTitle,
    rationale: options.operatorOutput.rationale,
    risks: ['dummy_operator_unverified'],
    kill_criteria: ['fails deterministic consistency check', 'fails eval.run grounding gate'],
  };
  const ideaId = options.createId();
  const nodeId = options.createId();
  const normalizedEvidenceUris = sanitizeEvidenceUris(options.evidenceUris ?? options.operatorOutput.evidenceUrisUsed);
  const { formalizationTrace, ideaCard } = buildIdeaCardFromRationaleDraft({
    rationaleDraft,
    evidenceUris: normalizedEvidenceUris,
    hypothesis: options.operatorOutput.hypothesis,
    claimText: options.operatorOutput.claimText,
    supportType: 'calculation',
    computeStep: 'run deterministic operator smoke check',
    computeMethod: options.operatorOutput.operatorId,
  });
  return {
    campaign_id: options.campaignId,
    idea_id: ideaId,
    node_id: nodeId,
    revision: 1,
    parent_node_ids: [options.parentNodeId],
    island_id: options.islandId,
    operator_id: options.operatorOutput.operatorId,
    operator_family: options.operatorOutput.operatorFamily,
    origin: {
      model: options.operatorOutput.backendId,
      temperature: 0.0,
      prompt_hash: `sha256:${sha256Hex([options.operatorOutput.operatorId, options.campaignId, options.islandId, options.parentNodeId, options.operatorOutput.hypothesis].join('|'))}`,
      timestamp: options.now,
      role: 'OperatorRunner',
    },
    operator_trace: {
      inputs: structuredClone(options.operatorOutput.traceInputs),
      params: { ...structuredClone(options.operatorOutput.traceParams), formalization: formalizationTrace },
      evidence_uris_used: normalizedEvidenceUris,
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
