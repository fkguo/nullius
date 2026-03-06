export type EvidenceLevel = 'discovery' | 'evidence' | 'hint' | 'indirect' | 'theoretical';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'controversial';
export type CitationStance = 'confirming' | 'contradicting' | 'neutral';
export type ClaimStanceV1 = 'supported' | 'weak_support' | 'not_supported' | 'mixed' | 'conflicting';
export type ClaimReasonCodeV1 =
  | 'direct_support'
  | 'hedged_support'
  | 'negated_claim'
  | 'no_relevant_evidence'
  | 'conflicting_evidence'
  | 'same_topic_different_claim'
  | 'invalid_response'
  | 'sampling_unavailable'
  | 'other';

export type ClaimProvenance = {
  backend: 'mcp_sampling' | 'heuristic';
  used_fallback: boolean;
  prompt_version: string;
  input_hash: string;
  model?: string;
};

export type ExtractedClaimV1 = {
  claim_id: string;
  claim_text: string;
  source_context: { before: string; after: string };
  evidence_level: EvidenceLevel;
  sigma_level?: number;
  provenance: ClaimProvenance;
  used_fallback: boolean;
};

export type ClaimEvidenceItem = {
  evidence_ref: string;
  evidence_text: string;
  recid?: string;
  title?: string;
  source: 'confirmation_search' | 'comment_search';
};

export type EvidenceClaimAssessmentV1 = {
  claim_id: string;
  claim_text: string;
  evidence_ref: string;
  stance: ClaimStanceV1;
  confidence: number;
  reason_code: ClaimReasonCodeV1;
  provenance: ClaimProvenance;
  used_fallback: boolean;
};

export type ClaimSemanticGradeV1 = {
  claim_id: string;
  claim_text: string;
  source_context: { before: string; after: string };
  evidence_level: EvidenceLevel;
  sigma_level?: number;
  evidence_assessments: EvidenceClaimAssessmentV1[];
  aggregate_stance: ClaimStanceV1;
  aggregate_confidence: number;
  reason_code: ClaimReasonCodeV1;
  provenance: ClaimProvenance;
  used_fallback: boolean;
};
