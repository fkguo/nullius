import { DEFAULT_CRITICAL_RESEARCH_CONFIG, getConfig } from './config.js';
import { mapConfidenceLevel } from '../../core/semantics/citationStanceHeuristics.js';
import type {
  ClaimProvenance,
  ClaimReasonCodeV1,
  ClaimSemanticGradeV1,
  ClaimStanceV1,
  ConfidenceLevel,
  EvidenceClaimAssessmentV1,
  EvidenceLevel,
} from '../../core/semantics/claimTypes.js';

export interface EvidenceGrade {
  claim: string;
  source_context?: { before: string; after: string };
  evidence_level: EvidenceLevel;
  sigma_level?: number;
  independent_confirmations: number;
  is_orphan: boolean;
  conflicting_count: number;
  confidence: ConfidenceLevel;
  confirming_papers?: Array<{ recid: string; title: string }>;
  conflicting_papers?: Array<{ recid: string; title: string }>;
  claim_id: string;
  claim_text: string;
  aggregate_stance: ClaimStanceV1;
  aggregate_confidence: number;
  reason_code: ClaimReasonCodeV1;
  provenance: ClaimProvenance;
  used_fallback: boolean;
  evidence_assessments: EvidenceClaimAssessmentV1[];
}

export interface EvidenceGradingResult {
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
  paper_abstract?: string;
  success: boolean;
  error?: string;
  claim_grades: ClaimSemanticGradeV1[];
  main_claims: EvidenceGrade[];
  overall_reliability: number;
  warnings: string[];
  claim_count: number;
  grade_distribution: Record<ClaimStanceV1, number>;
  summary: {
    total_claims: number;
    well_established: number;
    controversial: number;
    orphan: number;
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function scoreClaim(grade: EvidenceGrade): number {
  const config = getConfig().criticalResearch ?? DEFAULT_CRITICAL_RESEARCH_CONFIG;
  const base = grade.evidence_level === 'discovery'
    ? config.evidenceScoreDiscovery
    : grade.evidence_level === 'evidence'
      ? config.evidenceScoreEvidence
      : grade.evidence_level === 'hint'
        ? config.evidenceScoreHint
        : grade.evidence_level === 'theoretical'
          ? config.evidenceScoreTheoretical
          : config.evidenceScoreIndirect;
  const boost = Math.min(grade.independent_confirmations * config.evidenceBoostPerConfirmation, config.evidenceMaxConfirmationBoost);
  const conflictPenalty = Math.min(grade.conflicting_count * config.evidencePenaltyPerConflict, config.evidenceMaxConflictPenalty);
  return clamp01(base + boost - conflictPenalty - (grade.is_orphan ? config.evidenceOrphanPenalty : 0));
}

export function toLegacyGrade(grade: ClaimSemanticGradeV1, titleByRef: Map<string, { recid: string; title: string }>): EvidenceGrade {
  const confirming = grade.evidence_assessments.filter(item => item.stance === 'supported' || item.stance === 'weak_support');
  const conflicting = grade.evidence_assessments.filter(item => item.stance === 'conflicting');
  return {
    claim: grade.claim_text,
    source_context: grade.source_context,
    evidence_level: grade.evidence_level,
    sigma_level: grade.sigma_level,
    independent_confirmations: confirming.length,
    is_orphan: confirming.length === 0,
    conflicting_count: conflicting.length,
    confidence: mapConfidenceLevel(grade.aggregate_confidence, grade.aggregate_stance),
    confirming_papers: confirming.map(item => titleByRef.get(item.evidence_ref)).filter((item): item is { recid: string; title: string } => Boolean(item)),
    conflicting_papers: conflicting.map(item => titleByRef.get(item.evidence_ref)).filter((item): item is { recid: string; title: string } => Boolean(item)),
    claim_id: grade.claim_id,
    claim_text: grade.claim_text,
    aggregate_stance: grade.aggregate_stance,
    aggregate_confidence: grade.aggregate_confidence,
    reason_code: grade.reason_code,
    provenance: grade.provenance,
    used_fallback: grade.used_fallback,
    evidence_assessments: grade.evidence_assessments,
  };
}

export function emptyResult(recid: string, error?: string): EvidenceGradingResult {
  return {
    paper_recid: recid,
    paper_title: '',
    success: !error,
    error,
    claim_grades: [],
    main_claims: [],
    overall_reliability: 0,
    warnings: [],
    claim_count: 0,
    grade_distribution: { supported: 0, weak_support: 0, not_supported: 0, mixed: 0, conflicting: 0 },
    summary: { total_claims: 0, well_established: 0, controversial: 0, orphan: 0 },
  };
}
