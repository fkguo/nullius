import { z } from 'zod';

const ProvenanceResponseSchema = z.object({
  status: z.enum(['matched', 'uncertain', 'no_match', 'input_not_traceable']),
  selected_candidate_key: z.string().nullable(),
  relationship: z.enum(['same_content', 'extended', 'preliminary', 'unknown']),
  confidence: z.number().min(0).max(1),
  reason_code: z.string().min(1),
  reason: z.string().optional().default(''),
});

type ProvenanceCandidatePrompt = {
  candidate_key: string;
  recid?: string;
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  publication_summary?: string;
  publication_type?: string[];
  document_type?: string[];
  prior_signals: string[];
};

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

export type ParsedProvenanceResponse = z.infer<typeof ProvenanceResponseSchema>;

export function parseProvenanceMatchingResponse(input: unknown): ParsedProvenanceResponse | null {
  const parsed = ProvenanceResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return parsed.data;
}

export function buildProvenanceMatchingPrompt(params: {
  prompt_version: string;
  input_paper: {
    recid?: string;
    title: string;
    abstract?: string;
    authors: string[];
    year?: number;
    publication_summary?: string;
    publication_type?: string[];
    document_type?: string[];
    review_hint?: string;
    conference_hint?: string;
  };
  candidates: ProvenanceCandidatePrompt[];
}): string {
  return [
    'You match a conference/preliminary scientific paper to a likely journal/original version.',
    'Return STRICT JSON ONLY with keys: status, selected_candidate_key, relationship, confidence, reason_code, reason.',
    'status must be one of: matched | uncertain | no_match | input_not_traceable.',
    'relationship must be one of: same_content | extended | preliminary | unknown.',
    'Use matched only when one candidate is clearly the best semantic continuation/publication of the input paper.',
    'Use uncertain when multiple candidates remain plausible or evidence is weak.',
    'Use no_match when none of the candidates are a responsible provenance match.',
    'Use input_not_traceable when the input is itself a review/full article or otherwise not the kind of preliminary paper that should be traced.',
    'Do not decide based only on first-author overlap, title token overlap, publication type, or year order.',
    `prompt_version=${params.prompt_version}`,
    'INPUT_PAPER:',
    JSON.stringify(params.input_paper, null, 2),
    'CANDIDATES:',
    JSON.stringify(params.candidates, null, 2),
  ].join('\n');
}
