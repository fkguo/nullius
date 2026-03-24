import { createHash } from 'crypto';
import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_GRADE_EVIDENCE } from '@autoresearch/shared';
import { adjudicateClaimBundle } from './claimBundleAdjudicator.js';
import { buildClaimAssessmentPrompt, extractSamplingText, parseClaimAssessmentResponse } from './claimSampling.js';
import { buildToolSamplingMetadata } from '../sampling-metadata.js';
import type {
  ClaimEvidenceItem,
  ClaimReasonCodeV1,
  ClaimSemanticGradeV1,
  ClaimStanceV1,
  EvidenceClaimAssessmentV1,
  ExtractedClaimV1,
} from './claimTypes.js';

export type ClaimAssessmentContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function aggregateAssessments(claim: ExtractedClaimV1, assessments: EvidenceClaimAssessmentV1[], promptVersion: string, inputHash: string): ClaimSemanticGradeV1 {
  const support = assessments.filter(item => item.stance === 'supported' || item.stance === 'weak_support');
  const conflict = assessments.filter(item => item.stance === 'conflicting');
  const confidences = assessments.map(item => item.confidence);
  const aggregateConfidence = confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0.2;
  const aggregateStance: ClaimStanceV1 = conflict.length > 0 && support.length > 0
    ? 'mixed'
    : conflict.length > 0
      ? 'conflicting'
      : support.some(item => item.stance === 'supported')
        ? 'supported'
        : support.length > 0
          ? 'weak_support'
          : 'not_supported';
  const reasonCode: ClaimReasonCodeV1 = aggregateStance === 'mixed' || aggregateStance === 'conflicting'
    ? 'conflicting_evidence'
    : aggregateStance === 'weak_support'
      ? 'hedged_support'
      : aggregateStance === 'supported'
        ? 'direct_support'
        : assessments.some(item => item.reason_code === 'same_topic_different_claim')
          ? 'same_topic_different_claim'
          : 'no_relevant_evidence';
  const primary = assessments[0];
  return {
    claim_id: claim.claim_id,
    claim_text: claim.claim_text,
    source_context: claim.source_context,
    evidence_level: claim.evidence_level,
    sigma_level: claim.sigma_level,
    evidence_assessments: assessments,
    aggregate_stance: aggregateStance,
    aggregate_confidence: aggregateConfidence,
    reason_code: reasonCode,
    provenance: primary?.provenance ?? {
      backend: 'mcp_sampling',
      used_fallback: false,
      prompt_version: promptVersion,
      input_hash: inputHash,
    },
    used_fallback: false,
  };
}

export async function gradeClaimAgainstEvidenceBundle(
  claim: ExtractedClaimV1,
  evidenceItems: ClaimEvidenceItem[],
  ctx: ClaimAssessmentContext = {},
  options: { prompt_version?: string; bundle_prompt_version?: string } = {},
): Promise<ClaimSemanticGradeV1> {
  const promptVersion = options.prompt_version ?? 'sem02_claim_evidence_v1';
  const inputHash = sha256Hex(JSON.stringify({ claim, evidenceItems, promptVersion }));
  if (evidenceItems.length === 0) {
    return aggregateAssessments(claim, [], promptVersion, inputHash);
  }
  if (!ctx.createMessage) {
    throw new Error('Semantic evidence grading requires MCP client sampling support.');
  }
  const createMessage = ctx.createMessage;

  const assessments: EvidenceClaimAssessmentV1[] = await Promise.all(evidenceItems.map(async evidence => {
    try {
      const response = await createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: buildClaimAssessmentPrompt({ prompt_version: promptVersion, claim_text: claim.claim_text, evidence_ref: evidence.evidence_ref, evidence_text: evidence.evidence_text }) } }],
        maxTokens: 500,
        metadata: buildToolSamplingMetadata({
          tool: INSPIRE_GRADE_EVIDENCE,
          module: 'sem02_claim_evidence_grading',
          promptVersion,
          costClass: 'high',
          context: { evidence_ref: evidence.evidence_ref },
        }),
      });
      const parsed = parseClaimAssessmentResponse(extractSamplingText(response.content));
      if (!parsed) {
        throw new Error(`Semantic evidence grading returned an invalid response for ${evidence.evidence_ref}.`);
      }
      return {
        claim_id: claim.claim_id,
        claim_text: claim.claim_text,
        evidence_ref: evidence.evidence_ref,
        stance: parsed.stance,
        confidence: parsed.confidence,
        reason_code: parsed.reason_code,
        provenance: {
          backend: 'mcp_sampling' as const,
          used_fallback: false,
          prompt_version: promptVersion,
          input_hash: inputHash,
          model: response.model,
        },
        used_fallback: false,
      };
    } catch (error) {
      throw new Error(`Semantic evidence grading failed for ${evidence.evidence_ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  const aggregate = aggregateAssessments(claim, assessments, promptVersion, inputHash);
  const bundlePromptVersion = options.bundle_prompt_version ?? 'sem03_claim_bundle_v1';
  const bundleInputHash = sha256Hex(JSON.stringify({ claim, evidenceItems, assessments, promptVersion: bundlePromptVersion }));
  return await adjudicateClaimBundle({
    claim,
    evidenceItems,
    assessments,
    ctx,
    prompt_version: bundlePromptVersion,
    input_hash: bundleInputHash,
  }) ?? aggregate;
}
