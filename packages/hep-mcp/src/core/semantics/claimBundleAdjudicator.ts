import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_CRITICAL_RESEARCH } from '@autoresearch/shared';

import { buildClaimBundleAssessmentPrompt, parseClaimBundleAssessmentResponse } from './claimBundleSampling.js';
import { extractSamplingText } from './claimSampling.js';
import { buildToolSamplingMetadata } from '../sampling-metadata.js';
import type {
  ClaimEvidenceItem,
  ClaimSemanticGradeV1,
  EvidenceClaimAssessmentV1,
  ExtractedClaimV1,
} from './claimTypes.js';

type ClaimAssessmentContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

function needsBundleAdjudication(assessments: EvidenceClaimAssessmentV1[]): boolean {
  return assessments.length > 1 || assessments.some(item => (
    item.used_fallback
    || item.stance === 'weak_support'
    || item.reason_code === 'same_topic_different_claim'
    || item.reason_code === 'conflicting_evidence'
  ));
}

export async function adjudicateClaimBundle(params: {
  claim: ExtractedClaimV1;
  evidenceItems: ClaimEvidenceItem[];
  assessments: EvidenceClaimAssessmentV1[];
  ctx: ClaimAssessmentContext;
  prompt_version: string;
  input_hash: string;
  fallback_grade: ClaimSemanticGradeV1;
}): Promise<ClaimSemanticGradeV1 | null> {
  if (!params.ctx.createMessage || !needsBundleAdjudication(params.assessments)) {
    return null;
  }

  try {
    const response = await params.ctx.createMessage({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: buildClaimBundleAssessmentPrompt({
            prompt_version: params.prompt_version,
            claim: params.claim,
            evidence_items: params.evidenceItems,
            assessments: params.assessments,
          }),
        },
      }],
      maxTokens: 700,
      metadata: buildToolSamplingMetadata({
        tool: INSPIRE_CRITICAL_RESEARCH,
        module: 'sem03_stance_engine',
        promptVersion: params.prompt_version,
        costClass: 'medium',
        context: { claim_id: params.claim.claim_id, evidence_count: params.evidenceItems.length },
      }),
    });
    const parsed = parseClaimBundleAssessmentResponse(extractSamplingText(response.content));
    if (!parsed) {
      return {
        ...params.fallback_grade,
        provenance: { ...params.fallback_grade.provenance, used_fallback: true, prompt_version: params.prompt_version, input_hash: params.input_hash, model: response.model },
        used_fallback: true,
      };
    }
    const assessmentFallback = params.assessments.some(item => item.used_fallback);
    return {
      ...params.fallback_grade,
      aggregate_stance: parsed.aggregate_stance,
      aggregate_confidence: parsed.abstain && parsed.aggregate_stance === 'not_supported'
        ? Math.min(parsed.aggregate_confidence, 0.3)
        : parsed.aggregate_confidence,
      reason_code: parsed.reason_code,
      provenance: {
        backend: 'mcp_sampling',
        used_fallback: assessmentFallback,
        prompt_version: params.prompt_version,
        input_hash: params.input_hash,
        model: response.model,
      },
      used_fallback: assessmentFallback,
    };
  } catch {
    return {
      ...params.fallback_grade,
      provenance: { ...params.fallback_grade.provenance, used_fallback: true, prompt_version: params.prompt_version, input_hash: params.input_hash },
      used_fallback: true,
    };
  }
}
