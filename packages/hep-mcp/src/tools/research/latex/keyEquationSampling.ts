import { z } from 'zod';

export type KeyEquationSelectionStatus = 'selected' | 'uncertain' | 'abstained' | 'unavailable';
export type KeyEquationImportanceBand = 'high' | 'medium' | 'low';

const KeyEquationEvaluationSchema = z.object({
  candidate_key: z.string().min(1),
  selection_status: z.enum(['selected', 'uncertain', 'abstained']),
  importance_band: z.enum(['high', 'medium', 'low']).optional(),
  confidence: z.number().min(0).max(1),
  reason_code: z.string().min(1),
  reason: z.string().optional().default(''),
});

const KeyEquationResponseSchema = z.object({
  overall_status: z.enum(['selected', 'uncertain', 'abstained']),
  evaluations: z.array(KeyEquationEvaluationSchema).default([]),
});

type KeyEquationCandidatePrompt = {
  candidate_key: string;
  label?: string;
  latex: string;
  reference_count: number;
  section?: string;
  context_text?: string;
  signal_summary: string[];
};

const MAX_PROMPT_TITLE_CHARS = 300;
const MAX_PROMPT_ABSTRACT_CHARS = 2500;
const MAX_PROMPT_LATEX_CHARS = 1200;
const MAX_PROMPT_CONTEXT_CHARS = 800;
const MAX_PROMPT_SIGNAL_COUNT = 6;
const TRUNCATION_MARKER = '...[truncated]';

function truncatePromptText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars);
  return `${value.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

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

export type ParsedKeyEquationResponse = z.infer<typeof KeyEquationResponseSchema>;

export function parseKeyEquationSamplingResponse(input: unknown): ParsedKeyEquationResponse | null {
  const parsed = KeyEquationResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return parsed.data;
}

export function buildKeyEquationAssessmentPrompt(params: {
  prompt_version: string;
  document_title?: string;
  abstract?: string;
  candidates: KeyEquationCandidatePrompt[];
}): string {
  const promptCandidates = params.candidates.map(candidate => ({
    ...candidate,
    latex: truncatePromptText(candidate.latex, MAX_PROMPT_LATEX_CHARS) ?? '',
    context_text: truncatePromptText(candidate.context_text, MAX_PROMPT_CONTEXT_CHARS),
    signal_summary: candidate.signal_summary.slice(0, MAX_PROMPT_SIGNAL_COUNT),
  }));

  return [
    'You rank candidate equations for scientific-paper centrality.',
    'Task: decide which candidate equations are genuinely central to the paper, not merely definitions, notation, or generic formalism.',
    'Return STRICT JSON ONLY with keys: overall_status, evaluations.',
    'overall_status must be one of: selected | uncertain | abstained.',
    'Each evaluations item must contain: candidate_key, selection_status, importance_band, confidence, reason_code, reason.',
    'selection_status must be one of: selected | uncertain | abstained.',
    'importance_band must be one of: high | medium | low.',
    'Use selected only when the equation is central to the paper contribution or final reported result.',
    'Use uncertain for supporting equations, ambiguous evidence, or when multiple candidates are plausible.',
    'Use abstained when the provided context is insufficient.',
    'Do not reward equations only because they are in conclusions, frequently referenced, or contain domain-specific formulas.',
    `prompt_version=${params.prompt_version}`,
    `document_title=${JSON.stringify(truncatePromptText(params.document_title, MAX_PROMPT_TITLE_CHARS) ?? '')}`,
    'ABSTRACT:',
    truncatePromptText(params.abstract, MAX_PROMPT_ABSTRACT_CHARS) || '(missing abstract)',
    'CANDIDATES:',
    JSON.stringify(promptCandidates, null, 2),
  ].join('\n');
}
