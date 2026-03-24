import type { IntegrityReport } from '../model/integrity-report.js';
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
  integrityReport: IntegrityReport | null;
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

export function evaluateRdiGate(options: EvaluateRdiGateOptions): RdiGateResult {
  const { outcome, integrityReport, scores } = options;
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };

  const checks: RdiGateCheck[] = [
    {
      name: 'integrity_report_present',
      passed: integrityReport !== null,
      message: integrityReport ? 'Integrity report is present.' : 'Integrity report is required.',
    },
    {
      name: 'integrity_report_passed',
      passed: integrityReport !== null && integrityReport.overall_status !== 'fail',
      message:
        integrityReport === null
          ? 'Integrity report is required before reuse.'
          : integrityReport.overall_status === 'fail'
            ? 'Integrity report contains blocking failures.'
            : 'Integrity report overall status permits reuse.',
    },
    {
      name: 'integrity_target_matches_outcome',
      passed: integrityReport !== null && integrityReport.target_ref.sha256 === outcome.outcome_id,
      message:
        integrityReport === null
          ? 'Integrity report is required before hash matching.'
          : integrityReport.target_ref.sha256 === outcome.outcome_id
            ? 'Integrity report targets this outcome.'
            : 'Integrity report target hash must match outcome_id.',
    },
    {
      name: 'reproducibility_complete',
      passed:
        outcome.reproducibility_status === 'verified' ||
        outcome.reproducibility_status === 'not_applicable',
      message:
        outcome.reproducibility_status === 'verified' ||
        outcome.reproducibility_status === 'not_applicable'
          ? 'Reproducibility status is complete.'
          : 'Reproducibility status must be verified or not_applicable.',
    },
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
