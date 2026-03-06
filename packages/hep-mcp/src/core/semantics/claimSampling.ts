import { z } from 'zod';
import { clamp01, extractSamplingText } from './quantitySampling.js';
import type { ClaimReasonCodeV1, ClaimStanceV1, EvidenceLevel, ExtractedClaimV1 } from './claimTypes.js';

const ClaimSchema = z.object({
  claim_id: z.string().min(1).optional(),
  claim_text: z.string().min(1),
  context_before: z.string().optional().default(''),
  context_after: z.string().optional().default(''),
  evidence_level: z.enum(['discovery', 'evidence', 'hint', 'indirect', 'theoretical']),
  sigma_level: z.number().optional(),
});

const ClaimExtractionResponseSchema = z.object({
  claims: z.array(ClaimSchema).default([]),
});

const ClaimAssessmentResponseSchema = z.object({
  stance: z.enum(['supported', 'weak_support', 'not_supported', 'mixed', 'conflicting']),
  confidence: z.number(),
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

export function buildClaimExtractionPrompt(params: { prompt_version: string; abstract: string; max_claims: number }): string {
  return [
    'You extract claim records from physics-paper abstracts.',
    'Return STRICT JSON ONLY with shape: {"claims":[{"claim_id":"c1","claim_text":"...","context_before":"...","context_after":"...","evidence_level":"discovery|evidence|hint|indirect|theoretical","sigma_level":number|null}]}',
    'Extract only concrete scientific claims; skip boilerplate and future-work statements.',
    'Use conservative evidence_level labels. If a claim is hedged or speculative, prefer "hint" or "theoretical".',
    `prompt_version=${params.prompt_version}`,
    `max_claims=${params.max_claims}`,
    'ABSTRACT:',
    params.abstract,
  ].join('\n');
}

export function parseClaimExtractionResponse(input: unknown): Array<Pick<ExtractedClaimV1, 'claim_id' | 'claim_text' | 'source_context' | 'evidence_level' | 'sigma_level'>> | null {
  const parsed = ClaimExtractionResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return parsed.data.claims.map((claim, index) => ({
    claim_id: claim.claim_id ?? `c${index + 1}`,
    claim_text: claim.claim_text.trim(),
    source_context: { before: claim.context_before, after: claim.context_after },
    evidence_level: claim.evidence_level as EvidenceLevel,
    sigma_level: claim.sigma_level,
  }));
}

export function buildClaimAssessmentPrompt(params: { prompt_version: string; claim_text: string; evidence_ref: string; evidence_text: string }): string {
  return [
    'You judge whether a piece of evidence supports a physics claim.',
    'Return STRICT JSON ONLY with keys: stance, confidence, reason_code.',
    'stance must be one of: supported | weak_support | not_supported | mixed | conflicting.',
    'reason_code must be one of: direct_support | hedged_support | negated_claim | no_relevant_evidence | conflicting_evidence | same_topic_different_claim | invalid_response | sampling_unavailable | other.',
    'Use "weak_support" for hedged or partial support, "not_supported" for neutral or irrelevant evidence, and "conflicting" for direct disagreement.',
    `prompt_version=${params.prompt_version}`,
    `claim_text=${JSON.stringify(params.claim_text)}`,
    `evidence_ref=${JSON.stringify(params.evidence_ref)}`,
    'EVIDENCE:',
    params.evidence_text,
  ].join('\n');
}

export function parseClaimAssessmentResponse(input: unknown): { stance: ClaimStanceV1; confidence: number; reason_code: ClaimReasonCodeV1 } | null {
  const parsed = ClaimAssessmentResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return {
    stance: parsed.data.stance as ClaimStanceV1,
    confidence: clamp01(parsed.data.confidence),
    reason_code: parsed.data.reason_code as ClaimReasonCodeV1,
  };
}

export { extractSamplingText };
