import { z } from 'zod';
import { extractSamplingText } from '../../../core/semantics/quantitySampling.js';

const RefSchema = z.object({
  recid: z.string().min(1),
  title: z.string().min(1),
});

const AssumptionSchema = z.object({
  assumption: z.string().min(1),
  type: z.enum(['explicit', 'implicit']),
  source: z.enum(['original', 'inherited']),
  category_label: z.string().nullable().optional(),
  inherited_from: z.array(RefSchema).optional().default([]),
});

const AssumptionResponseSchema = z.object({
  assumptions: z.array(AssumptionSchema).default([]),
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

export interface ParsedAssumptionResponse {
  assumptions: Array<{
    assumption: string;
    type: 'explicit' | 'implicit';
    source: 'original' | 'inherited';
    category_label: string | null;
    inherited_from: Array<{ recid: string; title: string }>;
  }>;
  abstain: boolean;
  reason: string;
}

export function buildAssumptionExtractionPrompt(params: {
  prompt_version: string;
  title: string;
  abstract: string;
  references: Array<{ recid: string; title: string; abstract?: string }>;
  max_assumptions: number;
}): string {
  const refs = params.references.map(ref => ({
    recid: ref.recid,
    title: ref.title,
    abstract: ref.abstract ?? '',
  }));

  return [
    'You extract scientific assumptions from a paper abstract and a small supporting reference context.',
    'Return STRICT JSON ONLY with keys: assumptions, abstain, reason.',
    'Each assumption must include: assumption, type, source, category_label, inherited_from.',
    'Use source="inherited" only when the assumption clearly comes from the supplied references.',
    'category_label must be a short free-text label or null. Do not invent a closed taxonomy.',
    `prompt_version=${params.prompt_version}`,
    `max_assumptions=${params.max_assumptions}`,
    `title=${JSON.stringify(params.title)}`,
    `references=${JSON.stringify(refs)}`,
    'ABSTRACT:',
    params.abstract || '(missing abstract)',
  ].join('\n');
}

export function parseAssumptionExtractionResponse(input: unknown): ParsedAssumptionResponse | null {
  const parsed = AssumptionResponseSchema.safeParse(parseJsonPayload(input));
  if (!parsed.success) return null;
  return {
    assumptions: parsed.data.assumptions.map(item => ({
      assumption: item.assumption.trim(),
      type: item.type,
      source: item.source,
      category_label: item.category_label?.trim() || null,
      inherited_from: item.inherited_from,
    })).filter(item => item.assumption.length > 0),
    abstain: parsed.data.abstain,
    reason: parsed.data.reason.trim(),
  };
}

export { extractSamplingText };
