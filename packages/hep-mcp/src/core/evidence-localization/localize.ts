import type {
  EvidenceLocalizationArtifact,
  EvidenceLocalizationHit,
  EvidenceLocalizationReasonCode,
  EvidenceLocalizationStatus,
  EvidenceLocalizationUnit,
  LatexLocatorV1,
  PdfLocatorV1,
} from '@autoresearch/shared';
import type { EvidenceType } from '@autoresearch/shared';
import {
  allowedUnits,
  AMBIGUITY_SCORE_DELTA,
  mapEvidenceTypeToLocalizationUnit,
  mapRequestedUnitReasonCode,
  MIN_PDF_SUPPORT_OVERLAP,
  overlapScore,
  rankLocalizedCandidate,
} from './scoring.js';

type Locator = LatexLocatorV1 | PdfLocatorV1;

export type LocalizationCatalogItem = {
  evidence_id: string;
  project_id: string;
  paper_id?: string;
  run_id?: string;
  type: EvidenceType;
  text: string;
  locator: Locator;
  meta?: Record<string, unknown>;
};

export type LocalizationCandidate = {
  item: LocalizationCatalogItem;
  score: number;
  semantic_score: number;
  token_overlap_ratio: number;
  importance_score?: number;
  matched_tokens?: string[];
};

export function inferRequestedLocalizationUnit(params: { query: string; types?: EvidenceType[] }): EvidenceLocalizationUnit | undefined {
  if (params.types?.length === 1) return mapEvidenceTypeToLocalizationUnit(params.types[0]!);
  const query = params.query.toLowerCase();
  if (/\b(which page|what page|page \d+)\b/.test(query) || /\bpage\b/.test(query)) return 'page';
  if (/\b(citation|cite|cited|reference context|citation context|supporting reference)\b/.test(query)) return 'citation_context';
  if (/\b(equation|formula|derivation|eq\.)\b/.test(query)) return 'equation';
  if (/\b(figure|fig\.?|diagram|plot|panel)\b/.test(query)) return 'figure';
  if (/\b(table|tabulation|results table)\b/.test(query)) return 'table';
  if (/\b(chunk|paragraph|passage|section|context)\b/.test(query)) return 'chunk';
  return undefined;
}

function reconcileSupportingSurface(item: LocalizationCatalogItem, pdfItems: LocalizationCatalogItem[]): {
  source_surfaces: EvidenceLocalizationHit['source_surfaces'];
  cross_surface_status: EvidenceLocalizationHit['cross_surface_status'];
  supporting_evidence_id?: string;
  scans: number;
  reasonCodes: EvidenceLocalizationReasonCode[];
} {
  if (item.locator.kind === 'pdf') {
    return { source_surfaces: [item.type === 'pdf_page' ? 'pdf_page' : 'pdf_region'], cross_surface_status: 'pdf_only', scans: 0, reasonCodes: ['pdf_primary_locator'] };
  }
  const candidatePdfItems = item.paper_id ? pdfItems.filter(pdf => !pdf.paper_id || pdf.paper_id === item.paper_id) : pdfItems;
  if (candidatePdfItems.length === 0) {
    return { source_surfaces: ['latex'], cross_surface_status: 'latex_only', scans: 0, reasonCodes: ['pdf_surface_unavailable'] };
  }
  const scored = candidatePdfItems.map(pdf => ({ pdf, score: overlapScore(item.text, pdf.text) })).sort((lhs, rhs) => rhs.score - lhs.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < MIN_PDF_SUPPORT_OVERLAP) {
    return { source_surfaces: ['latex'], cross_surface_status: 'latex_only', scans: candidatePdfItems.length, reasonCodes: ['pdf_support_missing'] };
  }
  if (second && Math.abs(best.score - second.score) < AMBIGUITY_SCORE_DELTA) {
    return { source_surfaces: ['latex'], cross_surface_status: 'ambiguous', scans: candidatePdfItems.length, reasonCodes: ['pdf_support_ambiguous'] };
  }
  return {
    source_surfaces: ['latex', best.pdf.type === 'pdf_page' ? 'pdf_page' : 'pdf_region'],
    cross_surface_status: 'consistent',
    supporting_evidence_id: best.pdf.evidence_id,
    scans: candidatePdfItems.length,
    reasonCodes: ['pdf_support_consistent'],
  };
}

export function buildEvidenceLocalization(params: {
  query: string;
  types?: EvidenceType[];
  candidates: LocalizationCandidate[];
  allItems: LocalizationCatalogItem[];
  limit: number;
}): { requestedUnit?: EvidenceLocalizationUnit; artifact: EvidenceLocalizationArtifact; selected: Array<{ candidate: LocalizationCandidate; localization: EvidenceLocalizationHit }> } {
  const requestedUnit = inferRequestedLocalizationUnit({ query: params.query, types: params.types });
  const existingIds = new Set(params.candidates.map(candidate => candidate.item.evidence_id));
  const supplemental = requestedUnit
    ? params.allItems
        .filter(item => mapEvidenceTypeToLocalizationUnit(item.type) === requestedUnit && !existingIds.has(item.evidence_id))
        .map(item => {
          const overlap = overlapScore(params.query, item.text);
          return overlap > 0 ? { item, score: overlap, semantic_score: overlap, token_overlap_ratio: overlap } : null;
        })
        .filter((candidate): candidate is LocalizationCandidate => candidate !== null)
    : [];
  const filtered = [...params.candidates, ...supplemental].filter(candidate => {
    const allowed = allowedUnits(requestedUnit);
    return !allowed || allowed.has(mapEvidenceTypeToLocalizationUnit(candidate.item.type));
  });
  filtered.sort((lhs, rhs) => {
    const lhsUnit = mapEvidenceTypeToLocalizationUnit(lhs.item.type);
    const rhsUnit = mapEvidenceTypeToLocalizationUnit(rhs.item.type);
    if (requestedUnit) {
      const lhsExact = lhsUnit === requestedUnit ? 0 : 1;
      const rhsExact = rhsUnit === requestedUnit ? 0 : 1;
      if (lhsExact !== rhsExact) return lhsExact - rhsExact;
    }
    return rankLocalizedCandidate({ unit: rhsUnit, score: rhs.score, requestedUnit }) - rankLocalizedCandidate({ unit: lhsUnit, score: lhs.score, requestedUnit });
  });

  const exact = requestedUnit ? filtered.filter(candidate => mapEvidenceTypeToLocalizationUnit(candidate.item.type) === requestedUnit) : [];
  const exactAmbiguous = Boolean(exact[1] && Math.abs(
    rankLocalizedCandidate({ unit: mapEvidenceTypeToLocalizationUnit(exact[0]!.item.type), score: exact[0]!.score, requestedUnit }) -
    rankLocalizedCandidate({ unit: mapEvidenceTypeToLocalizationUnit(exact[1]!.item.type), score: exact[1]!.score, requestedUnit })
  ) < AMBIGUITY_SCORE_DELTA);
  const indexedUnits = new Set(params.allItems.map(item => mapEvidenceTypeToLocalizationUnit(item.type)));
  const pdfItems = params.allItems.filter(item => item.locator.kind === 'pdf');
  let structureScans = 0;

  const selected = filtered.slice(0, params.limit).map(candidate => {
    const unit = mapEvidenceTypeToLocalizationUnit(candidate.item.type);
    const status: EvidenceLocalizationStatus = !requestedUnit || unit === requestedUnit
      ? (exactAmbiguous && unit === requestedUnit ? 'abstained' : 'localized')
      : 'fallback_available';
    const supporting = reconcileSupportingSurface(candidate.item, pdfItems);
    const firstReason: EvidenceLocalizationReasonCode = unit === requestedUnit ? 'requested_unit_exact' : requestedUnit ? 'coarse_fallback' : 'implicit_unit';
    structureScans += supporting.scans;
    return {
      candidate,
      localization: {
        evidence_id: candidate.item.evidence_id,
        unit,
        status,
        reason_codes: [firstReason, ...supporting.reasonCodes],
        source_surfaces: supporting.source_surfaces,
        cross_surface_status: supporting.cross_surface_status,
        supporting_evidence_id: supporting.supporting_evidence_id,
      },
    };
  });

  const localizedHits = selected.filter(entry => entry.localization.status === 'localized').length;
  const fallbackHits = selected.filter(entry => entry.localization.status === 'fallback_available').length;
  const unavailableHits = 0;
  const abstainedHits = selected.filter(entry => entry.localization.status === 'abstained').length;
  const availability: EvidenceLocalizationStatus = exactAmbiguous ? 'abstained' : localizedHits > 0 ? 'localized' : fallbackHits > 0 ? (requestedUnit && !indexedUnits.has(requestedUnit) ? 'unavailable' : 'fallback_available') : 'unavailable';
  const artifactReasonCodes: EvidenceLocalizationReasonCode[] = [
    mapRequestedUnitReasonCode(requestedUnit),
    ...(exactAmbiguous ? ['exact_unit_ambiguous'] as const : []),
    ...(requestedUnit && !indexedUnits.has(requestedUnit) ? ['requested_unit_missing_from_indexed_surfaces'] as const : []),
    ...(availability === 'fallback_available' ? ['coarse_fallback_returned'] as const : []),
    ...(availability === 'unavailable' ? ['localized_unit_unavailable'] as const : []),
  ];

  return {
    requestedUnit,
    selected,
    artifact: {
      version: 1,
      query: params.query,
      requested_unit: requestedUnit,
      availability,
      reason_codes: artifactReasonCodes,
      telemetry: {
        localization_passes: 1,
        structure_scans: structureScans,
        localized_hits: localizedHits,
        fallback_hits: fallbackHits,
        unavailable_hits: unavailableHits,
        abstained_hits: abstainedHits,
      },
      hits: selected.map(entry => entry.localization),
    },
  };
}

export { mapEvidenceTypeToLocalizationUnit } from './scoring.js';
