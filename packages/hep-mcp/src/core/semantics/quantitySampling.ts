import type { CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { areUnitsCompatible, canonicalizeUnit } from '../../tools/research/config.js';
import type {
  QuantityDecisionV1,
  QuantityMentionV1,
  QuantityReasonCodeV1,
  UnitNormalizationV1,
} from './quantityTypes.js';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function extractSamplingText(content: CreateMessageResult['content']): string {
  const chunks: string[] = [];
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    if (typeof (block as { text?: unknown }).text === 'string') {
      chunks.push((block as { text: string }).text);
    }
  }
  return chunks.join('\n').trim();
}

function parseClientJsonResponse(input: unknown): unknown {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          return input;
        }
      }
      return input;
    }
  }
  return input;
}

function isDecision(value: string): value is QuantityDecisionV1 {
  return value === 'match' || value === 'split' || value === 'uncertain';
}

function isReasonCode(value: string): value is QuantityReasonCodeV1 {
  return (
    value === 'same_quantity' ||
    value === 'different_quantity' ||
    value === 'unit_incompatible' ||
    value === 'ambiguous_symbol' ||
    value === 'insufficient_context' ||
    value === 'invalid_response' ||
    value === 'sampling_unavailable' ||
    value === 'other'
  );
}

export type ParsedQuantityAdjudication = {
  decision: QuantityDecisionV1;
  canonical_quantity: string;
  confidence: number;
  reason_code: QuantityReasonCodeV1;
};

export function parseQuantityAdjudicationResponse(input: unknown): ParsedQuantityAdjudication | null {
  const parsed = parseClientJsonResponse(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const decisionRaw = String(obj.decision ?? '').trim();
  if (!isDecision(decisionRaw)) return null;

  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const canonicalQuantity = String(obj.canonical_quantity ?? '').trim() || 'unknown';

  const reasonCodeRaw = String(obj.reason_code ?? '').trim();
  if (!isReasonCode(reasonCodeRaw)) return null;

  return {
    decision: decisionRaw,
    canonical_quantity: canonicalQuantity,
    confidence,
    reason_code: reasonCodeRaw,
  };
}

export function buildQuantityAdjudicationPrompt(params: {
  prompt_version: string;
  left: QuantityMentionV1;
  right: QuantityMentionV1;
  unit_normalization: UnitNormalizationV1;
}): string {
  const leftUnit = params.unit_normalization.a_unit ?? '';
  const rightUnit = params.unit_normalization.b_unit ?? '';
  const unitCompat =
    leftUnit && rightUnit
      ? areUnitsCompatible(canonicalizeUnit(leftUnit) ?? leftUnit, canonicalizeUnit(rightUnit) ?? rightUnit)
      : null;

  return [
    'You are a semantic adjudicator for physical quantity mentions extracted from physics papers.',
    'Task: decide whether two mentions refer to the same underlying quantity (match), different quantities (split), or insufficient information (uncertain).',
    '',
    'Return STRICT JSON ONLY with keys:',
    '- decision: "match" | "split" | "uncertain"',
    '- canonical_quantity: stable identifier string. Prefer "<kind>:<entity>" in snake_case (e.g. "mass:X3872", "branching_ratio:B->K*mu+mu-"). Use "unknown" when uncertain.',
    '- confidence: number in [0,1]',
    '- reason_code: one of ["same_quantity","different_quantity","unit_incompatible","ambiguous_symbol","insufficient_context","invalid_response","sampling_unavailable","other"]',
    '',
    'Guidance:',
    '- Use both quantity surface form and context.',
    '- Units are helpful for incompatibility checks, but unit compatibility alone does not imply match.',
    '- If the mention is a single symbol with generic context, prefer "uncertain".',
    '',
    `prompt_version=${params.prompt_version}`,
    '',
    'Left mention:',
    `quantity: ${JSON.stringify(params.left.quantity)}`,
    `context: ${JSON.stringify(params.left.context)}`,
    `unit: ${JSON.stringify(leftUnit)}`,
    '',
    'Right mention:',
    `quantity: ${JSON.stringify(params.right.quantity)}`,
    `context: ${JSON.stringify(params.right.context)}`,
    `unit: ${JSON.stringify(rightUnit)}`,
    '',
    `unit_compatible: ${unitCompat === null ? 'unknown' : unitCompat ? 'true' : 'false'}`,
  ].join('\n');
}
