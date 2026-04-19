import { z } from 'zod';
import { extractSamplingText } from '../../../core/semantics/quantitySampling.js';

const ReviewResponseSchema = z.object({
  review_type: z.enum(['catalog', 'critical', 'consensus', 'uncertain']),
  scope: z.enum(['narrow', 'moderate', 'comprehensive', 'uncertain']).optional().default('uncertain'),
  potential_biases: z.array(z.string().min(1)).optional().default([]),
  classification_confidence: z.enum(['high', 'medium', 'low']).optional().default('low'),
  abstain: z.boolean().optional().default(false),
  reason: z.string().optional().default(''),
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

export interface ParsedReviewSemanticResponse {
  review_type: 'catalog' | 'critical' | 'consensus' | 'uncertain';
  scope: 'narrow' | 'moderate' | 'comprehensive' | 'uncertain';
  potential_biases: string[];
  classification_confidence: 'high' | 'medium' | 'low';
  abstain: boolean;
  reason: string;
}

export function buildReviewAssessmentPrompt(params: {
  prompt_version: string;
  title: string;
  abstract: string;
  year?: number;
  citation_count?: number;
  author_count: number;
  reference_count: number;
  publication_summary?: string;
  publication_type?: string[];
  document_type?: string[];
  collaborations?: string[];
}): string {
  return [
    'You classify the document role and coverage pattern of a scientific review or survey paper.',
    'Return STRICT JSON ONLY with keys: review_type, scope, potential_biases, classification_confidence, abstain, reason.',
    'review_type must be one of: catalog | critical | consensus | uncertain.',
    'scope must be one of: narrow | moderate | comprehensive | uncertain.',
    'Use abstain=true when you cannot responsibly classify the paper from the provided information.',
    `prompt_version=${params.prompt_version}`,
    `title=${JSON.stringify(params.title)}`,
    `year=${JSON.stringify(params.year ?? null)}`,
    `citation_count=${JSON.stringify(params.citation_count ?? null)}`,
    `author_count=${params.author_count}`,
    `reference_count=${params.reference_count}`,
    `publication_summary=${JSON.stringify(params.publication_summary ?? '')}`,
    `publication_type=${JSON.stringify(params.publication_type ?? [])}`,
    `document_type=${JSON.stringify(params.document_type ?? [])}`,
    `collaborations=${JSON.stringify(params.collaborations ?? [])}`,
    'ABSTRACT:',
    params.abstract || '(missing abstract)',
  ].join('\n');
}

export function parseReviewAssessmentResponse(input: unknown): ParsedReviewSemanticResponse | null {
  const parsed = ReviewResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return {
    review_type: parsed.data.review_type,
    scope: parsed.data.scope,
    potential_biases: parsed.data.potential_biases.map(bias => bias.trim()).filter(Boolean).slice(0, 5),
    classification_confidence: parsed.data.classification_confidence,
    abstain: parsed.data.abstain,
    reason: parsed.data.reason.trim(),
  };
}

export { extractSamplingText };
