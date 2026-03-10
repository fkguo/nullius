import { z } from 'zod';
import { clamp01, extractSamplingText } from '../../../core/semantics/quantitySampling.js';

const RedFlagSchema = z.object({
  type: z.enum([
    'high_self_citation',
    'no_confirmation',
    'comment_exists',
    'single_author',
    'no_experimental_basis',
    'excessive_claims',
    'methodology_unclear',
    'low_citations_old_paper',
  ]),
  description: z.string().min(1),
  severity: z.enum(['warning', 'concern']),
  details: z.string().optional(),
});

const QuestionGroupsSchema = z.object({
  methodology: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  alternatives: z.array(z.string().min(1)).default([]),
  reproducibility: z.array(z.string().min(1)).default([]),
  implications: z.array(z.string().min(1)).default([]),
});

const QuestionResponseSchema = z.object({
  paper_type: z.enum(['experimental', 'theoretical', 'phenomenological', 'review', 'lattice', 'instrumentation', 'mixed', 'uncertain']),
  reliability_score: z.number().nullable().optional(),
  questions: QuestionGroupsSchema,
  red_flags: z.array(RedFlagSchema).optional().default([]),
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

export interface ParsedQuestionResponse {
  paper_type: 'experimental' | 'theoretical' | 'phenomenological' | 'review' | 'lattice' | 'instrumentation' | 'mixed' | 'uncertain';
  reliability_score: number | null;
  questions: z.infer<typeof QuestionGroupsSchema>;
  red_flags: z.infer<typeof RedFlagSchema>[];
  abstain: boolean;
  reason: string;
}

export function buildCriticalQuestionPrompt(params: {
  prompt_version: string;
  title: string;
  abstract: string;
  publication_summary?: string;
  publication_type?: string[];
  document_type?: string[];
  author_count: number;
  citation_count: number;
  paper_age_years: number;
  has_comments: boolean;
  self_citation_rate?: number;
  content_hint?: string;
}): string {
  return [
    'You generate reviewer-style critical questions for a scientific paper.',
    'Return STRICT JSON ONLY with keys: paper_type, reliability_score, questions, red_flags, abstain, reason.',
    'paper_type must be one of: experimental | theoretical | phenomenological | review | lattice | instrumentation | mixed | uncertain.',
    'reliability_score must be null when the information is insufficient for a calibrated score.',
    'red_flags must use only the provided enum values and stay grounded in the supplied metadata/abstract.',
    `prompt_version=${params.prompt_version}`,
    `title=${JSON.stringify(params.title)}`,
    `publication_summary=${JSON.stringify(params.publication_summary ?? '')}`,
    `publication_type=${JSON.stringify(params.publication_type ?? [])}`,
    `document_type=${JSON.stringify(params.document_type ?? [])}`,
    `author_count=${params.author_count}`,
    `citation_count=${params.citation_count}`,
    `paper_age_years=${params.paper_age_years}`,
    `has_comments=${params.has_comments}`,
    `self_citation_rate=${JSON.stringify(params.self_citation_rate ?? null)}`,
    `content_hint=${JSON.stringify(params.content_hint ?? 'uncertain')}`,
    'ABSTRACT:',
    params.abstract || '(missing abstract)',
  ].join('\n');
}

export function parseCriticalQuestionResponse(input: unknown): ParsedQuestionResponse | null {
  const parsed = QuestionResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return {
    paper_type: parsed.data.paper_type,
    reliability_score: parsed.data.reliability_score === null || parsed.data.reliability_score === undefined
      ? null
      : clamp01(parsed.data.reliability_score),
    questions: parsed.data.questions,
    red_flags: parsed.data.red_flags.slice(0, 5),
    abstain: parsed.data.abstain,
    reason: parsed.data.reason.trim(),
  };
}

export { extractSamplingText };
