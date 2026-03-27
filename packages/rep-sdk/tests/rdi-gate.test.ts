import { describe, expect, it } from 'vitest';
import { deriveReproducibilityProjection, evaluateRdiGate } from '../src/validation/index.js';
import { createIntegrityReport, createOutcome, createStrategy } from './fixtures.js';
import { createVerificationProjectionFixture } from './verification-fixtures.js';

describe('RDI gate', () => {
  it('passes only fully validated outcomes and computes a rank for passed assets', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    const report = createIntegrityReport(outcome, 'advisory_only');

    const gateResult = evaluateRdiGate({
      outcome,
      integrityReport: report,
      scores: {
        novelty: 0.5,
        generality: 0.25,
        significance: 0.75,
        citation_impact: 1,
      },
    });

    expect(gateResult.passed).toBe(true);
    expect(gateResult.ranking?.rank_score).toBeCloseTo(0.6);
    expect(gateResult.ranking?.gate_passed).toBe(true);
  });

  it('fails closed when reproducibility or integrity is incomplete', () => {
    const strategy = createStrategy();
    const pendingOutcome = createOutcome(strategy, { reproducibility_status: 'pending' });
    const failedReport = createIntegrityReport(pendingOutcome, 'fail');

    const gateResult = evaluateRdiGate({
      outcome: pendingOutcome,
      integrityReport: failedReport,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks.some((check) => check.name === 'reproducibility_complete' && !check.passed)).toBe(
      true,
    );
  });

  it('fails closed when the integrity report is missing', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });

    const gateResult = evaluateRdiGate({
      outcome,
      integrityReport: null,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'integrity_report_present',
          passed: false,
          message: 'Integrity report is required.',
        }),
        expect.objectContaining({
          name: 'integrity_report_passed',
          passed: false,
          message: 'Integrity report is required before reuse.',
        }),
        expect.objectContaining({
          name: 'integrity_target_matches_outcome',
          passed: false,
          message: 'Integrity report is required before hash matching.',
        }),
      ]),
    );
  });

  it('prefers the verification projection when reproducibility is blocked', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    const report = createIntegrityReport(outcome, 'advisory_only');
    const projection = deriveReproducibilityProjection(createVerificationProjectionFixture('blocked'));

    const gateResult = evaluateRdiGate({
      outcome,
      integrityReport: report,
      reproducibilityProjection: projection,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks).toContainEqual({
      name: 'reproducibility_complete',
      passed: false,
      message: 'Reproducibility is blocked: Execution failed before decisive verification completed.',
    });
  });
});
