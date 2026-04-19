import { createHash } from 'crypto';
import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { HEP_PROJECT_COMPARE_MEASUREMENTS } from '../../tool-names.js';
import { canonicalQuantityKey } from './quantityCanonical.js';
import { normalizeUnitsForPair, unitPairIncompatible } from './quantityUnits.js';
import {
  buildQuantityAdjudicationPrompt,
  clamp01,
  extractSamplingText,
  parseQuantityAdjudicationResponse,
} from './quantitySampling.js';
import type { QuantityDecisionV1, QuantityMentionV1, QuantityReasonCodeV1, UnitNormalizationV1 } from './quantityTypes.js';
import { buildToolSamplingMetadata } from '../sampling-metadata.js';

export type QuantityAdjudicationV1 = {
  version: 1;
  decision: QuantityDecisionV1;
  canonical_quantity: string;
  unit_normalization: UnitNormalizationV1;
  confidence: number;
  reason_code: QuantityReasonCodeV1;
  provenance: {
    backend: 'mcp_sampling' | 'diagnostic';
    used_fallback: boolean;
    prompt_version: string;
    input_hash: string;
    model?: string;
  };
};

export type QuantitySamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const cache = new Map<string, QuantityAdjudicationV1>();

function unavailableAdjudication(params: {
  inputHash: string;
  promptVersion: string;
  unitNormalization: UnitNormalizationV1;
  backend: QuantityAdjudicationV1['provenance']['backend'];
  model?: string;
}): QuantityAdjudicationV1 {
  return {
    version: 1,
    decision: 'uncertain',
    canonical_quantity: 'unknown',
    unit_normalization: params.unitNormalization,
    confidence: 0,
    reason_code: 'sampling_unavailable',
    provenance: {
      backend: params.backend,
      used_fallback: false,
      prompt_version: params.promptVersion,
      input_hash: params.inputHash,
      model: params.model,
    },
  };
}

export async function adjudicateQuantityPair(
  left: QuantityMentionV1,
  right: QuantityMentionV1,
  ctx: QuantitySamplingContext = {},
  options: { prompt_version?: string } = {},
): Promise<QuantityAdjudicationV1> {
  const promptVersion = options.prompt_version ?? 'v1';
  const unitNormalization = normalizeUnitsForPair(left, right);
  const inputHash = sha256Hex(JSON.stringify({ left, right, prompt_version: promptVersion, unit_normalization: unitNormalization }));

  const cached = cache.get(inputHash);
  if (cached) return cached;

  if (unitPairIncompatible(left, right)) {
    const payload: QuantityAdjudicationV1 = {
      version: 1,
      decision: 'split',
      canonical_quantity: canonicalQuantityKey(left),
      unit_normalization: unitNormalization,
      confidence: 0.99,
      reason_code: 'unit_incompatible',
      provenance: {
        backend: 'diagnostic',
        used_fallback: false,
        prompt_version: promptVersion,
        input_hash: inputHash,
      },
    };
    cache.set(inputHash, payload);
    return payload;
  }

  if (!ctx.createMessage) {
    return unavailableAdjudication({
      inputHash,
      promptVersion,
      unitNormalization,
      backend: 'diagnostic',
    });
  }

  const prompt = buildQuantityAdjudicationPrompt({
    prompt_version: promptVersion,
    left,
    right,
    unit_normalization: unitNormalization,
  });

  try {
    const response = await ctx.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
      maxTokens: 400,
      metadata: buildToolSamplingMetadata({
        tool: HEP_PROJECT_COMPARE_MEASUREMENTS,
        module: 'sem01_quantity_adjudicator',
        promptVersion,
        costClass: 'medium',
      }),
    });

    const rawText = extractSamplingText(response.content);
    const parsed = parseQuantityAdjudicationResponse(rawText);
    if (!parsed) {
      const payload: QuantityAdjudicationV1 = {
        version: 1,
        decision: 'uncertain',
        canonical_quantity: 'unknown',
        unit_normalization: unitNormalization,
        confidence: 0.2,
        reason_code: 'invalid_response',
        provenance: {
          backend: 'mcp_sampling',
          used_fallback: false,
          prompt_version: promptVersion,
          input_hash: inputHash,
          model: response.model,
        },
      };
      cache.set(inputHash, payload);
      return payload;
    }

    const conflict = unitPairIncompatible(left, right);
    const finalDecision: QuantityDecisionV1 = conflict && parsed.decision === 'match' ? 'split' : parsed.decision;
    const finalReason: QuantityReasonCodeV1 = conflict && parsed.decision === 'match' ? 'unit_incompatible' : parsed.reason_code;

    const canonical = parsed.canonical_quantity && parsed.canonical_quantity !== 'unknown'
      ? parsed.canonical_quantity
      : canonicalQuantityKey(left);

    const payload: QuantityAdjudicationV1 = {
      version: 1,
      decision: finalDecision,
      canonical_quantity: canonical || 'unknown',
      unit_normalization: unitNormalization,
      confidence: clamp01(parsed.confidence),
      reason_code: finalReason,
      provenance: {
        backend: 'mcp_sampling',
        used_fallback: false,
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
    };
    cache.set(inputHash, payload);
    return payload;
  } catch {
    return unavailableAdjudication({
      inputHash,
      promptVersion,
      unitNormalization,
      backend: 'mcp_sampling',
    });
  }
}
