import type { EvidenceLocalizationUnit, EvidenceType } from '@autoresearch/shared';
import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';

export const EXACT_UNIT_BOOST = 0.2;
export const PAGE_CHUNK_CROSS_BOOST = 0.03;
export const COARSE_SURFACE_BOOST = 0.01;
export const NON_TARGET_UNIT_PENALTY = 0.05;
export const MIN_PDF_SUPPORT_OVERLAP = 0.12;
export const AMBIGUITY_SCORE_DELTA = 0.03;

function tokenize(text: string): string[] {
  return normalizeTextPreserveUnits(text)
    .replace(/[^a-zA-Z0-9_:+-]+/g, ' ')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function tokensMatch(lhs: string, rhs: string): boolean {
  if (lhs === rhs) return true;
  if (lhs.length < 4 || rhs.length < 4) return false;
  return lhs.includes(rhs) || rhs.includes(lhs);
}

export function overlapScore(query: string, candidateText: string): number {
  const lhs = Array.from(new Set(tokenize(query)));
  const rhs = Array.from(new Set(tokenize(candidateText)));
  if (lhs.length === 0 || rhs.length === 0) return 0;
  let overlap = 0;
  for (const token of lhs) {
    if (rhs.some(other => tokensMatch(token, other))) overlap += 1;
  }
  return overlap / Math.max(lhs.length, 1);
}

export function allowedUnits(requestedUnit: EvidenceLocalizationUnit | undefined): Set<EvidenceLocalizationUnit> | null {
  if (!requestedUnit) return null;
  if (requestedUnit === 'page') return new Set(['page', 'chunk']);
  if (requestedUnit === 'chunk') return new Set(['chunk', 'page']);
  return new Set([requestedUnit, 'chunk', 'page']);
}

export function rankLocalizedCandidate(params: {
  unit: EvidenceLocalizationUnit;
  score: number;
  requestedUnit: EvidenceLocalizationUnit | undefined;
}): number {
  const { unit, score, requestedUnit } = params;
  if (!requestedUnit) return score;
  if (unit === requestedUnit) return score + EXACT_UNIT_BOOST;
  if ((requestedUnit === 'page' && unit === 'chunk') || (requestedUnit === 'chunk' && unit === 'page')) {
    return score + PAGE_CHUNK_CROSS_BOOST;
  }
  if (unit === 'chunk' || unit === 'page') return score + COARSE_SURFACE_BOOST;
  return score - NON_TARGET_UNIT_PENALTY;
}

export function mapRequestedUnitReasonCode(requestedUnit: EvidenceLocalizationUnit | undefined):
  | 'requested_page'
  | 'requested_chunk'
  | 'requested_table'
  | 'requested_figure'
  | 'requested_equation'
  | 'requested_citation_context'
  | 'requested_unspecified' {
  switch (requestedUnit) {
    case 'page': return 'requested_page';
    case 'chunk': return 'requested_chunk';
    case 'table': return 'requested_table';
    case 'figure': return 'requested_figure';
    case 'equation': return 'requested_equation';
    case 'citation_context': return 'requested_citation_context';
    default: return 'requested_unspecified';
  }
}

export function mapEvidenceTypeToLocalizationUnit(type: EvidenceType): EvidenceLocalizationUnit {
  if (type === 'pdf_page') return 'page';
  if (type === 'table' || type === 'figure' || type === 'equation' || type === 'citation_context') return type;
  return 'chunk';
}
