import { areUnitsCompatible, canonicalizeUnit, detectUnitCategory } from '../../tools/research/config.js';
import type { QuantityMentionV1, UnitNormalizationV1 } from './quantityTypes.js';

function normalizeUnitRaw(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function normalizeUnitsForPair(left: QuantityMentionV1, right: QuantityMentionV1): UnitNormalizationV1 {
  const leftUnit = normalizeUnitRaw(left.unit);
  const rightUnit = normalizeUnitRaw(right.unit);

  const leftCanonical = leftUnit ? (canonicalizeUnit(leftUnit) ?? leftUnit) : undefined;
  const rightCanonical = rightUnit ? (canonicalizeUnit(rightUnit) ?? rightUnit) : undefined;

  const unitCategory = leftCanonical
    ? detectUnitCategory(leftCanonical)
    : rightCanonical
      ? detectUnitCategory(rightCanonical)
      : null;

  const canonicalUnit =
    leftCanonical && rightCanonical && areUnitsCompatible(leftCanonical, rightCanonical)
      ? leftCanonical
      : leftCanonical ?? rightCanonical;

  return {
    a_unit: leftCanonical,
    b_unit: rightCanonical,
    canonical_unit: canonicalUnit ?? undefined,
    unit_category: unitCategory ?? undefined,
  };
}

export function unitPairIncompatible(left: QuantityMentionV1, right: QuantityMentionV1): boolean {
  const leftUnit = normalizeUnitRaw(left.unit);
  const rightUnit = normalizeUnitRaw(right.unit);
  if (!leftUnit || !rightUnit) return false;
  const leftCanonical = canonicalizeUnit(leftUnit) ?? leftUnit;
  const rightCanonical = canonicalizeUnit(rightUnit) ?? rightUnit;
  const leftCategory = detectUnitCategory(leftCanonical);
  const rightCategory = detectUnitCategory(rightCanonical);
  if (!leftCategory || !rightCategory) return false;
  return !areUnitsCompatible(leftCanonical, rightCanonical);
}
