import type { EvidenceLocalizationUnit, EvidenceMultimodalArtifact } from '@autoresearch/shared';

import type { LocalizationCandidate, LocalizationCatalogItem } from '../evidence-localization/localize.js';
import { inferCatalogItemLocalizationUnit } from '../evidence-localization/units.js';
import { overlapScore } from '../evidence-localization/scoring.js';

const MIN_VISUAL_SIGNAL = 0.18;
const VISUAL_AMBIGUITY_DELTA = 0.03;
const UNIT_MATCH_BOOST = 0.2;
const PAGE_ARTIFACT_BOOST = 0.06;
const REGION_ARTIFACT_BOOST = 0.08;
const SUPPLEMENTAL_SCORE_FACTOR = 0.7;
const BLENDED_SCORE_FACTOR = 0.3;

type VisualScoreEntry = { item: LocalizationCatalogItem; score: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function artifactBoost(item: LocalizationCatalogItem): number {
  if (item.type === 'pdf_page') return PAGE_ARTIFACT_BOOST;
  if (item.type === 'pdf_region') return REGION_ARTIFACT_BOOST;
  return 0;
}

function scoreVisualItem(query: string, item: LocalizationCatalogItem, requestedUnit: EvidenceLocalizationUnit): number {
  const textOverlap = overlapScore(query, item.text);
  const unit = inferCatalogItemLocalizationUnit(item);
  const exactMatch = unit === requestedUnit ? UNIT_MATCH_BOOST : 0;
  return clamp01(textOverlap + exactMatch + artifactBoost(item));
}

function sortCandidates(candidates: LocalizationCandidate[]): LocalizationCandidate[] {
  return [...candidates].sort((left, right) =>
    right.score - left.score
    || right.semantic_score - left.semantic_score
    || right.token_overlap_ratio - left.token_overlap_ratio
    || left.item.evidence_id.localeCompare(right.item.evidence_id));
}

function mergeVisualCandidates(params: {
  candidates: LocalizationCandidate[];
  exactVisuals: VisualScoreEntry[];
  query: string;
  requestedUnit: EvidenceLocalizationUnit;
  blendScores: boolean;
}): { candidates: LocalizationCandidate[]; supplementedCandidates: number; boostedHits: number } {
  const candidateById = new Map(params.candidates.map(candidate => [candidate.item.evidence_id, { ...candidate }]));
  let supplementedCandidates = 0;
  let boostedHits = 0;

  for (const entry of params.exactVisuals) {
    const existing = candidateById.get(entry.item.evidence_id);
    const tokenOverlapRatio = overlapScore(params.query, entry.item.text);
    const supplementalScore = clamp01(entry.score * SUPPLEMENTAL_SCORE_FACTOR);
    if (existing) {
      const previousScore = existing.score;
      existing.score = params.blendScores
        ? clamp01(existing.score + (entry.score * BLENDED_SCORE_FACTOR))
        : Math.max(existing.score, supplementalScore);
      existing.semantic_score = Math.max(existing.semantic_score, entry.score);
      existing.token_overlap_ratio = Math.max(existing.token_overlap_ratio, tokenOverlapRatio);
      existing.preferred_unit = params.requestedUnit;
      candidateById.set(entry.item.evidence_id, existing);
      if (params.blendScores && existing.score > previousScore) boostedHits += 1;
      continue;
    }

    candidateById.set(entry.item.evidence_id, {
      item: entry.item,
      score: supplementalScore,
      semantic_score: entry.score,
      token_overlap_ratio: tokenOverlapRatio,
      importance_score: entry.item.type === 'pdf_region' ? 0.8 : 0.5,
      preferred_unit: params.requestedUnit,
    });
    supplementedCandidates += 1;
  }

  return {
    candidates: sortCandidates(Array.from(candidateById.values())),
    supplementedCandidates,
    boostedHits,
  };
}

export function applyMultimodalFusion(params: {
  query: string;
  requestedUnit: EvidenceLocalizationUnit;
  visualItems: LocalizationCatalogItem[];
  candidates: LocalizationCandidate[];
}): { candidates: LocalizationCandidate[]; artifact: EvidenceMultimodalArtifact } {
  const startedAt = Date.now();
  const exactVisuals = params.visualItems
    .map(item => ({ item, score: scoreVisualItem(params.query, item, params.requestedUnit) }))
    .filter(entry => inferCatalogItemLocalizationUnit(entry.item) === params.requestedUnit)
    .sort((left, right) => right.score - left.score || left.item.evidence_id.localeCompare(right.item.evidence_id));

  if (exactVisuals.length === 0) {
    return {
      candidates: params.candidates,
      artifact: {
        version: 1,
        status: 'unsupported',
        requested_unit: params.requestedUnit,
        reason_codes: ['requested_visual_label_missing'],
        promoted_evidence_ids: [],
        telemetry: {
          fusion_passes: 1,
          visual_candidates_scanned: params.visualItems.length,
          supplemented_candidates: 0,
          boosted_hits: 0,
          latency_ms: Date.now() - startedAt,
        },
      },
    };
  }

  const top = exactVisuals[0]!;
  const second = exactVisuals[1];
  if (top.score < MIN_VISUAL_SIGNAL) {
    return {
      candidates: params.candidates,
      artifact: {
        version: 1,
        status: 'unsupported',
        requested_unit: params.requestedUnit,
        reason_codes: ['visual_signal_insufficient'],
        promoted_evidence_ids: [],
        telemetry: {
          fusion_passes: 1,
          visual_candidates_scanned: params.visualItems.length,
          supplemented_candidates: 0,
          boosted_hits: 0,
          latency_ms: Date.now() - startedAt,
        },
      },
    };
  }

  if (second && Math.abs(top.score - second.score) < VISUAL_AMBIGUITY_DELTA) {
    const merged = mergeVisualCandidates({
      candidates: params.candidates,
      exactVisuals,
      query: params.query,
      requestedUnit: params.requestedUnit,
      blendScores: false,
    });
    return {
      candidates: merged.candidates,
      artifact: {
        version: 1,
        status: 'abstained',
        requested_unit: params.requestedUnit,
        reason_codes: ['visual_candidates_ambiguous'],
        promoted_evidence_ids: [],
        telemetry: {
          fusion_passes: 1,
          visual_candidates_scanned: params.visualItems.length,
          supplemented_candidates: merged.supplementedCandidates,
          boosted_hits: 0,
          latency_ms: Date.now() - startedAt,
        },
      },
    };
  }

  const merged = mergeVisualCandidates({
    candidates: params.candidates,
    exactVisuals,
    query: params.query,
    requestedUnit: params.requestedUnit,
    blendScores: true,
  });
  return {
    candidates: merged.candidates,
    artifact: {
      version: 1,
      status: 'applied',
      requested_unit: params.requestedUnit,
      reason_codes: ['visual_signal_applied'],
      promoted_evidence_ids: exactVisuals.map(entry => entry.item.evidence_id),
      telemetry: {
        fusion_passes: 1,
        visual_candidates_scanned: params.visualItems.length,
        supplemented_candidates: merged.supplementedCandidates,
        boosted_hits: merged.boostedHits,
        latency_ms: Date.now() - startedAt,
      },
    },
  };
}
