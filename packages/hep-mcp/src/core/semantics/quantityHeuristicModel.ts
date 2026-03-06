import { createHash } from 'crypto';
import type { QuantityDecisionV1, QuantityMentionV1, QuantityReasonCodeV1, UnitNormalizationV1 } from './quantityTypes.js';
import { canonicalQuantityKey } from './quantityCanonical.js';
import { hasDescriptiveContext, looksLikeSingleSymbol, tokenOverlapRatio, tokenizeQuantityText } from './quantityText.js';
import { normalizeUnitsForPair, unitPairIncompatible } from './quantityUnits.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function heuristicAdjudicateQuantityPair(
  left: QuantityMentionV1,
  right: QuantityMentionV1,
): {
  decision: QuantityDecisionV1;
  confidence: number;
  reason_code: QuantityReasonCodeV1;
  canonical_quantity: string;
  unit_normalization: UnitNormalizationV1;
  input_hash: string;
} {
  const inputHash = sha256Hex(JSON.stringify({ left, right }));
  const unitNormalization = normalizeUnitsForPair(left, right);

  if (unitPairIncompatible(left, right)) {
    return {
      decision: 'split',
      confidence: 0.98,
      reason_code: 'unit_incompatible',
      canonical_quantity: canonicalQuantityKey(left),
      unit_normalization: unitNormalization,
      input_hash: inputHash,
    };
  }

  const leftText = `${left.quantity} ${left.context}`.trim();
  const rightText = `${right.quantity} ${right.context}`.trim();
  const leftTokens = tokenizeQuantityText(leftText);
  const rightTokens = tokenizeQuantityText(rightText);
  const overlap = tokenOverlapRatio(leftTokens, rightTokens);

  if (
    looksLikeSingleSymbol(left.quantity) &&
    looksLikeSingleSymbol(right.quantity) &&
    !hasDescriptiveContext(left.context) &&
    !hasDescriptiveContext(right.context)
  ) {
    return {
      decision: 'uncertain',
      confidence: 0.35,
      reason_code: 'ambiguous_symbol',
      canonical_quantity: 'unknown',
      unit_normalization: unitNormalization,
      input_hash: inputHash,
    };
  }

  const leftKey = canonicalQuantityKey(left);
  const rightKey = canonicalQuantityKey(right);

  if (leftKey !== 'unknown' && rightKey !== 'unknown' && leftKey === rightKey && overlap >= 0.18) {
    return {
      decision: 'match',
      confidence: Math.min(0.95, 0.75 + overlap * 0.4),
      reason_code: 'same_quantity',
      canonical_quantity: leftKey,
      unit_normalization: unitNormalization,
      input_hash: inputHash,
    };
  }

  if (leftKey !== 'unknown' && rightKey !== 'unknown' && leftKey !== rightKey) {
    return {
      decision: 'split',
      confidence: Math.min(0.92, 0.75 + (1 - overlap) * 0.2),
      reason_code: 'different_quantity',
      canonical_quantity: leftKey,
      unit_normalization: unitNormalization,
      input_hash: inputHash,
    };
  }

  if (overlap >= 0.55) {
    const canonical = leftKey !== 'unknown' ? leftKey : rightKey !== 'unknown' ? rightKey : 'unknown';
    const decision: QuantityDecisionV1 = canonical === 'unknown' ? 'uncertain' : 'match';
    return {
      decision,
      confidence: canonical === 'unknown' ? 0.45 : Math.min(0.9, 0.7 + overlap * 0.3),
      reason_code: canonical === 'unknown' ? 'insufficient_context' : 'same_quantity',
      canonical_quantity: canonical === 'unknown' ? 'unknown' : canonical,
      unit_normalization: unitNormalization,
      input_hash: inputHash,
    };
  }

  if (overlap <= 0.14) {
    return {
      decision: 'split',
      confidence: Math.min(0.9, 0.7 + (0.14 - overlap) * 1.5),
      reason_code: 'different_quantity',
      canonical_quantity: leftKey !== 'unknown' ? leftKey : 'unknown',
      unit_normalization: unitNormalization,
      input_hash: inputHash,
    };
  }

  return {
    decision: 'uncertain',
    confidence: 0.45,
    reason_code: 'insufficient_context',
    canonical_quantity: 'unknown',
    unit_normalization: unitNormalization,
    input_hash: inputHash,
  };
}
