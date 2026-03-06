import { z } from 'zod';

import { clamp01 } from './quantitySampling.js';
import type {
  ClaimEvidenceItem,
  ClaimReasonCodeV1,
  ClaimStanceV1,
  EvidenceClaimAssessmentV1,
  ExtractedClaimV1,
} from './claimTypes.js';

const BundleResponseSchema = z.object({
  aggregate_stance: z.enum(['supported', 'weak_support', 'not_supported', 'mixed', 'conflicting']),
  aggregate_confidence: z.number(),
  reason_code: z.enum([
    'direct_support',
    'hedged_support',
    'negated_claim',
    'no_relevant_evidence',
    'conflicting_evidence',
    'same_topic_different_claim',
    'invalid_response',
    'sampling_unavailable',
    'other',
  ]),
  abstain: z.boolean().optional().default(false),
});

function parseJsonPayload(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return input;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return input;
    }
  }
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function buildClaimBundleAssessmentPrompt(params: {
  prompt_version: string;
  claim: ExtractedClaimV1;
  evidence_items: ClaimEvidenceItem[];
  assessments: EvidenceClaimAssessmentV1[];
}): string {
  const evidenceLines = params.evidence_items.map((item, index) => {
    const assessment = params.assessments[index];
    return [
      `- evidence_ref=${JSON.stringify(item.evidence_ref)}`,
      `  preliminary_stance=${assessment?.stance ?? 'not_supported'}`,
      `  preliminary_confidence=${assessment?.confidence ?? 0}`,
      `  preliminary_reason_code=${assessment?.reason_code ?? 'other'}`,
      `  evidence_text=${JSON.stringify(truncateText(item.evidence_text, 320))}`,
    ].join('\n');
  }).join('\n');

  return [
    'You adjudicate the final stance of a bundle of evidence against a physics claim.',
    'Return STRICT JSON ONLY with keys: aggregate_stance, aggregate_confidence, reason_code, abstain.',
    'aggregate_stance must be one of: supported | weak_support | not_supported | mixed | conflicting.',
    'reason_code must be one of: direct_support | hedged_support | negated_claim | no_relevant_evidence | conflicting_evidence | same_topic_different_claim | invalid_response | sampling_unavailable | other.',
    'Hard requirements:',
    '- handle scoped negation locally; do not flip on distant negation words.',
    '- distinguish hedged/partial support from strong support.',
    '- treat mixed support+conflict bundles as mixed unless one side is clearly irrelevant.',
    '- treat same-topic but different-claim evidence as not_supported rather than support/conflict.',
    '- if the bundle is insufficiently relevant, return aggregate_stance=not_supported with abstain=true and aggregate_confidence <= 0.3.',
    `prompt_version=${params.prompt_version}`,
    `claim_id=${JSON.stringify(params.claim.claim_id)}`,
    `claim_text=${JSON.stringify(params.claim.claim_text)}`,
    'EVIDENCE_BUNDLE:',
    evidenceLines,
  ].join('\n');
}

export function parseClaimBundleAssessmentResponse(input: unknown): {
  aggregate_stance: ClaimStanceV1;
  aggregate_confidence: number;
  reason_code: ClaimReasonCodeV1;
  abstain: boolean;
} | null {
  const parsed = BundleResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return {
    aggregate_stance: parsed.data.aggregate_stance as ClaimStanceV1,
    aggregate_confidence: clamp01(parsed.data.aggregate_confidence),
    reason_code: parsed.data.reason_code as ClaimReasonCodeV1,
    abstain: parsed.data.abstain,
  };
}
