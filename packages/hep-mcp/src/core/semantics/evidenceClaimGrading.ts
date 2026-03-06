import { createHash } from 'crypto';
import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { buildClaimAssessmentPrompt, extractSamplingText, parseClaimAssessmentResponse } from './claimSampling.js';
import { analyzeCitationStance, extractTopicWords } from './citationStanceHeuristics.js';
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

function heuristicAssessment(claim: ExtractedClaimV1, evidence: ClaimEvidenceItem, promptVersion: string, inputHash: string): EvidenceClaimAssessmentV1 {
  const stance = analyzeCitationStance(evidence.evidence_text, extractTopicWords(claim.claim_text));
  const mappedStance: ClaimStanceV1 = stance.stance === 'confirming'
    ? stance.confidence === 'high' ? 'supported' : 'weak_support'
    : stance.stance === 'contradicting'
      ? 'conflicting'
      : 'not_supported';
  const reasonCode: ClaimReasonCodeV1 = mappedStance === 'conflicting'
    ? 'conflicting_evidence'
    : mappedStance === 'not_supported'
      ? 'same_topic_different_claim'
      : mappedStance === 'weak_support'
        ? 'hedged_support'
        : 'direct_support';
  const confidence = mappedStance === 'supported' ? 0.75 : mappedStance === 'weak_support' ? 0.55 : 0.25;
  return {
    claim_id: claim.claim_id,
    claim_text: claim.claim_text,
    evidence_ref: evidence.evidence_ref,
    stance: mappedStance,
    confidence,
    reason_code: reasonCode,
    provenance: {
      backend: 'heuristic',
      used_fallback: true,
      prompt_version: promptVersion,
      input_hash: inputHash,
    },
    used_fallback: true,
  };
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
  const primary = assessments.find(item => !item.used_fallback);
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
      backend: 'heuristic',
      used_fallback: true,
      prompt_version: promptVersion,
      input_hash: inputHash,
    },
    used_fallback: assessments.every(item => item.used_fallback),
  };
}

export async function gradeClaimAgainstEvidenceBundle(
  claim: ExtractedClaimV1,
  evidenceItems: ClaimEvidenceItem[],
  ctx: ClaimAssessmentContext = {},
  options: { prompt_version?: string } = {},
): Promise<ClaimSemanticGradeV1> {
  const promptVersion = options.prompt_version ?? 'sem02_claim_evidence_v1';
  const inputHash = sha256Hex(JSON.stringify({ claim, evidenceItems, promptVersion }));
  if (evidenceItems.length === 0) {
    return aggregateAssessments(claim, [], promptVersion, inputHash);
  }

  const assessments: EvidenceClaimAssessmentV1[] = await Promise.all(evidenceItems.map(async evidence => {
    if (!ctx.createMessage) {
      return heuristicAssessment(claim, evidence, promptVersion, inputHash);
    }
    try {
      const response = await ctx.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: buildClaimAssessmentPrompt({ prompt_version: promptVersion, claim_text: claim.claim_text, evidence_ref: evidence.evidence_ref, evidence_text: evidence.evidence_text }) } }],
        maxTokens: 500,
        metadata: {
          module: 'sem02_claim_evidence_grading',
          prompt_version: promptVersion,
          evidence_ref: evidence.evidence_ref,
        },
      });
      const parsed = parseClaimAssessmentResponse(extractSamplingText(response.content));
      if (!parsed) {
        const fallback = heuristicAssessment(claim, evidence, promptVersion, inputHash);
        return { ...fallback, reason_code: 'invalid_response' as const, provenance: { ...fallback.provenance, backend: 'mcp_sampling' as const, model: response.model } };
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
    } catch {
      const fallback = heuristicAssessment(claim, evidence, promptVersion, inputHash);
      return { ...fallback, reason_code: 'sampling_unavailable' as const };
    }
  }));

  return aggregateAssessments(claim, assessments, promptVersion, inputHash);
}
