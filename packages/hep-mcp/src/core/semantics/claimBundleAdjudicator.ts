import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_GRADE_EVIDENCE } from '@autoresearch/shared';

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
    item.stance === 'weak_support'
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
}): Promise<ClaimSemanticGradeV1 | null> {
  if (!needsBundleAdjudication(params.assessments)) {
    return null;
  }
  if (!params.ctx.createMessage) {
    throw new Error('Bundle adjudication requires MCP client sampling support.');
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
        tool: INSPIRE_GRADE_EVIDENCE,
        module: 'sem03_stance_engine',
        promptVersion: params.prompt_version,
        costClass: 'high',
        context: { claim_id: params.claim.claim_id, evidence_count: params.evidenceItems.length },
      }),
    });
    const parsed = parseClaimBundleAssessmentResponse(extractSamplingText(response.content));
    if (!parsed) {
      throw new Error('Bundle adjudication returned an invalid response.');
    }
    return {
      claim_id: params.claim.claim_id,
      claim_text: params.claim.claim_text,
      source_context: params.claim.source_context,
      evidence_level: params.claim.evidence_level,
      sigma_level: params.claim.sigma_level,
      evidence_assessments: params.assessments,
      aggregate_stance: parsed.aggregate_stance,
      aggregate_confidence: parsed.abstain && parsed.aggregate_stance === 'not_supported'
        ? Math.min(parsed.aggregate_confidence, 0.3)
        : parsed.aggregate_confidence,
      reason_code: parsed.reason_code,
      provenance: {
        backend: 'mcp_sampling',
        used_fallback: false,
        prompt_version: params.prompt_version,
        input_hash: params.input_hash,
        model: response.model,
      },
      used_fallback: false,
    };
  } catch (error) {
    throw new Error(`Bundle adjudication failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
