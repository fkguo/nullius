import type { ReproducibilityProjection } from '../model/verification-projection.js';
import type { ResearchOutcome, RdiScores } from '../model/research-outcome.js';

export interface RdiWeights {
  novelty: number;
  generality: number;
  significance: number;
  citation_impact: number;
}

export interface RdiGateCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface EvaluateRdiGateOptions {
  outcome: ResearchOutcome;
  // This projection must come from a verification_kernel_v1 structural read.
  reproducibilityProjection: ReproducibilityProjection | null;
  scores?: Omit<RdiScores, 'gate_passed' | 'rank_score'>;
  weights?: Partial<RdiWeights>;
}

export interface RdiGateResult {
  passed: boolean;
  checks: RdiGateCheck[];
  ranking: RdiScores | null;
}

const DEFAULT_WEIGHTS: RdiWeights = {
  novelty: 0.4,
  generality: 0.2,
  significance: 0.2,
  citation_impact: 0.2,
};

function assertUnitInterval(name: string, value: number): void {
  if (value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
}

function evaluateReproducibilityCheck(
  outcome: ResearchOutcome,
  projection: ReproducibilityProjection | null,
): RdiGateCheck {
  if (projection === null) {
    return {
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Verification projection is required before gate evaluation.',
    };
  }

  if (projection.source !== 'verification_kernel_v1') {
    return {
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Integrity gate cannot evaluate until the verification projection derives from verification_kernel_v1 artifacts.',
    };
  }

  if (outcome.produced_by.run_id && projection.run_id !== outcome.produced_by.run_id) {
    return {
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Integrity gate cannot evaluate until the verification projection matches outcome provenance.',
    };
  }

  if (projection.integrity.gate_decision === 'pass') {
    return {
      name: 'integrity_gate_ready',
      passed: true,
      message: `Integrity gate is satisfied by verification truth: ${projection.integrity.summary}`,
    };
  }

  return {
    name: 'integrity_gate_ready',
    passed: false,
    message:
      projection.integrity.gate_decision === 'block'
        ? `Integrity gate is blocked: ${projection.integrity.summary}`
        : `Integrity gate is pending decisive verification: ${projection.integrity.summary}`,
  };
}

export function evaluateRdiGate(options: EvaluateRdiGateOptions): RdiGateResult {
  const { outcome, reproducibilityProjection, scores } = options;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const checks: RdiGateCheck[] = [
    {
      name: 'verification_projection_present',
      passed: reproducibilityProjection !== null,
      message:
        reproducibilityProjection !== null
          ? 'Verification projection is present.'
          : 'Verification projection is required before RDI reuse.',
    },
    {
      name: 'verification_projection_source',
      passed:
        reproducibilityProjection !== null
          && reproducibilityProjection.source === 'verification_kernel_v1',
      message:
        reproducibilityProjection === null
          ? 'Verification projection is required before source validation.'
          : reproducibilityProjection.source === 'verification_kernel_v1'
            ? 'Verification projection source is verification_kernel_v1.'
            : 'Verification projection must derive from verification_kernel_v1 artifacts.',
    },
    {
      name: 'verification_projection_matches_outcome',
      passed:
        reproducibilityProjection !== null
        && (!outcome.produced_by.run_id || reproducibilityProjection.run_id === outcome.produced_by.run_id),
      message:
        reproducibilityProjection === null
          ? 'Verification projection is required before provenance matching.'
          : !outcome.produced_by.run_id || reproducibilityProjection.run_id === outcome.produced_by.run_id
            ? 'Verification projection matches outcome provenance.'
            : 'Verification projection run_id must match outcome provenance.',
    },
    evaluateReproducibilityCheck(outcome, reproducibilityProjection),
  ];

  const passed = checks.every((check) => check.passed);
  if (!passed || !scores) {
    return { passed, checks, ranking: null };
  }

  assertUnitInterval('novelty', scores.novelty);
  assertUnitInterval('generality', scores.generality);
  assertUnitInterval('significance', scores.significance);
  assertUnitInterval('citation_impact', scores.citation_impact);

  const rank_score =
    scores.novelty * weights.novelty +
    scores.generality * weights.generality +
    scores.significance * weights.significance +
    scores.citation_impact * weights.citation_impact;

  return {
    passed,
    checks,
    ranking: {
      gate_passed: true,
      novelty: scores.novelty,
      generality: scores.generality,
      significance: scores.significance,
      citation_impact: scores.citation_impact,
      rank_score,
    },
  };
}
