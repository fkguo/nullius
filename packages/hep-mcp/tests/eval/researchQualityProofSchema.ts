import { expect } from 'vitest';

export type ProofSurface = 'sem04' | 'sem05' | 'sem12';

export type ProofInput =
  | {
      surface: 'sem04';
      payload: {
        subject_entity: string;
        inputs?: Array<'title' | 'abstract'>;
        papers: Array<{ recid: string; title: string; year: number; abstract: string }>;
        sampling_response: Record<string, unknown>;
      };
    }
  | {
      surface: 'sem05';
      payload: {
        kind: 'critical_questions';
        recid: string;
        paper: Record<string, unknown>;
        comments_exist?: boolean;
      };
    }
  | {
      surface: 'sem12';
      payload: {
        paper: Record<string, unknown>;
        candidates: Array<Record<string, unknown>>;
        sampling_response: Record<string, unknown> | null;
      };
    };

export type ProofExpected = {
  verdict: string;
  reason_code: string | null;
  state: Record<string, unknown>;
};

export type ProofMetadata = {
  quality_dimension: 'evidence_sufficiency' | 'provenance_sufficiency' | 'fail_closed';
  why_this_is_proof: string;
  why_not_proxy: string;
  contamination_risk: 'low' | 'medium' | 'high';
  trace_expectation: 'baseline_locked_single_trace';
  rubric: {
    dimension: 'evidence_sufficiency' | 'provenance_sufficiency' | 'fail_closed';
    expected_trace: ProofExpected;
    invariants: string[];
  };
};

export type ProofNormalizedActual = {
  surface: ProofSurface;
  verdict: string;
  reason_code: string | null;
  state: Record<string, unknown>;
  state_signature: string;
};

export const PRIMARY_PROOF_TAG_BY_DIMENSION = {
  evidence_sufficiency: 'proof:evidence_sufficiency',
  provenance_sufficiency: 'proof:provenance_sufficiency',
  fail_closed: 'proof:fail_closed',
} as const;

export const ALLOWED_PROOF_TAGS = [
  'proof:evidence_sufficiency',
  'proof:fail_closed',
  'proof:provenance_sufficiency',
  'proof:trace_conformance',
] as const;

export const ALLOWED_AGGREGATE_METRICS = [
  'evidence_sufficiency',
  'fail_closed',
  'overall_gate_pass_rate',
  'provenance_sufficiency',
  'trace_conformance',
] as const;

export const EXPECTED_PROOF_TAGS_BY_CASE = {
  sem04_weak_evidence_abstains: [
    'proof:evidence_sufficiency',
    'proof:fail_closed',
    'proof:trace_conformance',
  ],
  sem05_keyword_signal_stays_fail_closed: [
    'proof:fail_closed',
    'proof:trace_conformance',
  ],
  sem12_provenance_match_is_sufficient: [
    'proof:provenance_sufficiency',
    'proof:trace_conformance',
  ],
  sem12_missing_sampling_is_visible: [
    'proof:fail_closed',
    'proof:trace_conformance',
  ],
} as const;

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stableValue(item));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function buildActual(
  surface: ProofSurface,
  verdict: string,
  reason_code: string | null,
  state: Record<string, unknown>,
): ProofNormalizedActual {
  return {
    surface,
    verdict,
    reason_code,
    state: stableValue(state) as Record<string, unknown>,
    state_signature: stableJson(state),
  };
}

export function matchesExpected(actual: ProofNormalizedActual, expected: ProofExpected): boolean {
  return actual.verdict === expected.verdict
    && actual.reason_code === expected.reason_code
    && actual.state_signature === stableJson(expected.state);
}

export function passesEvidenceSufficiency(actual: ProofNormalizedActual): boolean {
  return actual.verdict === 'abstained'
    && actual.reason_code === 'model_abstained'
    && actual.state.decision_status === 'abstained'
    && actual.state.relation === 'unclear';
}

export function passesProvenanceSufficiency(actual: ProofNormalizedActual): boolean {
  return actual.verdict === 'matched'
    && actual.reason_code === 'semantic_content_match'
    && actual.state.provenance_status === 'applied'
    && typeof actual.state.matched_recid === 'string'
    && String(actual.state.matched_recid).length > 0;
}

export function passesFailClosed(actual: ProofNormalizedActual): boolean {
  return (actual.verdict === 'unavailable' || actual.verdict === 'sampling_unavailable' || actual.verdict === 'abstained')
    && (actual.reason_code === 'sampling_required' || actual.reason_code === 'sampling_unavailable' || actual.reason_code === 'model_abstained')
    && (!('matched_recid' in actual.state) || actual.state.matched_recid === null);
}

export function evaluateInvariant(invariant: string, actual: ProofNormalizedActual): boolean {
  switch (invariant) {
    case 'weak_evidence_requires_abstention':
      return actual.verdict === 'abstained' && actual.reason_code === 'model_abstained';
    case 'decision_status_must_stay_abstained':
      return actual.state.decision_status === 'abstained';
    case 'relation_must_remain_unclear':
      return actual.state.relation === 'unclear';
    case 'missing_sampling_must_stay_unavailable':
      return actual.verdict === 'unavailable' || actual.verdict === 'sampling_unavailable';
    case 'claim_words_must_not_create_semantic_authority':
      return actual.state.provenance_status === 'unavailable' && actual.state.paper_type === 'uncertain';
    case 'matched_recid_must_be_present':
      return typeof actual.state.matched_recid === 'string' && String(actual.state.matched_recid).length > 0;
    case 'provenance_status_must_be_applied':
      return actual.state.provenance_status === 'applied';
    case 'semantic_match_cannot_be_prior_only':
      return actual.reason_code === 'semantic_content_match';
    case 'missing_sampling_must_not_guess_match':
      return !('matched_recid' in actual.state) || actual.state.matched_recid === null;
    case 'unavailable_status_must_be_explicit':
      return actual.state.provenance_status === 'unavailable';
    default:
      return false;
  }
}

export function evaluateRubric(actual: ProofNormalizedActual, metadata: ProofMetadata): boolean {
  const { dimension, expected_trace, invariants } = metadata.rubric;
  if (!matchesExpected(actual, expected_trace)) return false;
  if (dimension === 'evidence_sufficiency' && !passesEvidenceSufficiency(actual)) return false;
  if (dimension === 'provenance_sufficiency' && !passesProvenanceSufficiency(actual)) return false;
  if (dimension === 'fail_closed' && !passesFailClosed(actual)) return false;
  return invariants.every(invariant => evaluateInvariant(invariant, actual));
}

export function validateProofMetadata(metadata: unknown): asserts metadata is ProofMetadata {
  expect(metadata).toBeTruthy();
  const record = metadata as Record<string, unknown>;
  expect(record.quality_dimension === 'evidence_sufficiency'
    || record.quality_dimension === 'provenance_sufficiency'
    || record.quality_dimension === 'fail_closed').toBe(true);
  expect(typeof record.why_this_is_proof).toBe('string');
  expect(String(record.why_this_is_proof).length).toBeGreaterThan(20);
  expect(typeof record.why_not_proxy).toBe('string');
  expect(String(record.why_not_proxy).length).toBeGreaterThan(20);
  expect(record.contamination_risk).toBe('low');
  expect(record.trace_expectation).toBe('baseline_locked_single_trace');
  expect(Array.isArray(record.rubric?.invariants)).toBe(true);
  expect(record.rubric?.dimension).toBe(record.quality_dimension);
  expect(record.rubric?.expected_trace).toBeTruthy();
  expect((record.rubric?.invariants ?? []).every((invariant: unknown) => typeof invariant === 'string' && invariant.length > 0)).toBe(true);
}
