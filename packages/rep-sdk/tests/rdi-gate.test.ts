import { describe, expect, it } from 'vitest';
import { deriveReproducibilityProjection, evaluateRdiGate } from '../src/validation/index.js';
import { createOutcome, createStrategy } from './fixtures.js';
import { createVerificationProjectionFixture } from './verification-fixtures.js';

describe('RDI gate', () => {
  it('passes only structurally backed decisive verification truth and computes a rank for passed assets', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    const projection = deriveReproducibilityProjection(createVerificationProjectionFixture('verified', {
      checkRunRefs: [{
        uri: 'rep://run-1/artifacts/verification_check_run_result.json',
        kind: 'verification_check_run',
        sha256: 'a'.repeat(64),
      }],
      missingDecisiveChecks: [],
      verdictSummary: 'Decisive verification completed successfully.',
    }));

    const gateResult = evaluateRdiGate({
      outcome,
      reproducibilityProjection: projection,
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
    expect(gateResult.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'verification_projection_present', passed: true }),
      expect.objectContaining({ name: 'verification_projection_source', passed: true }),
      expect.objectContaining({ name: 'verification_projection_matches_outcome', passed: true }),
      expect.objectContaining({ name: 'integrity_gate_ready', passed: true }),
    ]));
  });

  it('fails closed when the verification projection is missing', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });

    const gateResult = evaluateRdiGate({
      outcome,
      reproducibilityProjection: null,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'verification_projection_present',
        passed: false,
        message: 'Verification projection is required before RDI reuse.',
      }),
      expect.objectContaining({
        name: 'verification_projection_source',
        passed: false,
      }),
      expect.objectContaining({
        name: 'verification_projection_matches_outcome',
        passed: false,
      }),
      expect.objectContaining({
        name: 'integrity_gate_ready',
        passed: false,
        message: 'Verification projection is required before gate evaluation.',
      }),
    ]));
  });

  it('fails closed when decisive verification is still pending', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    const projection = deriveReproducibilityProjection(createVerificationProjectionFixture('not_attempted'));

    const gateResult = evaluateRdiGate({
      outcome,
      reproducibilityProjection: projection,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks).toContainEqual({
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Integrity gate is pending decisive verification: Decisive verification is still pending.',
    });
  });

  it('fails closed when verification is blocked by execution failure', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    const projection = deriveReproducibilityProjection(createVerificationProjectionFixture('blocked'));

    const gateResult = evaluateRdiGate({
      outcome,
      reproducibilityProjection: projection,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks).toContainEqual({
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Integrity gate is blocked: Execution failed before decisive verification completed.',
    });
  });

  it('fails closed when decisive verification completed with a failed verdict', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    const projection = deriveReproducibilityProjection(createVerificationProjectionFixture('failed', {
      checkRunRefs: [{
        uri: 'rep://run-1/artifacts/verification_check_run_result.json',
        kind: 'verification_check_run',
        sha256: 'd'.repeat(64),
      }],
      missingDecisiveChecks: [],
      verdictSummary: 'Decisive verification found a mismatch.',
    }));

    const gateResult = evaluateRdiGate({
      outcome,
      reproducibilityProjection: projection,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.ranking).toBeNull();
    expect(gateResult.checks).toContainEqual({
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Integrity gate is blocked: Decisive verification found a mismatch.',
    });
  });

  it('fails closed when the verification projection run_id does not match the outcome provenance', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy, { reproducibility_status: 'verified' });
    outcome.produced_by.run_id = 'run-2';
    const projection = deriveReproducibilityProjection(createVerificationProjectionFixture('verified', {
      checkRunRefs: [{
        uri: 'rep://run-1/artifacts/verification_check_run_result.json',
        kind: 'verification_check_run',
        sha256: 'c'.repeat(64),
      }],
      missingDecisiveChecks: [],
      verdictSummary: 'Decisive verification completed successfully.',
    }));

    const gateResult = evaluateRdiGate({
      outcome,
      reproducibilityProjection: projection,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.checks).toContainEqual({
      name: 'verification_projection_matches_outcome',
      passed: false,
      message: 'Verification projection run_id must match outcome provenance.',
    });
    expect(gateResult.checks).toContainEqual({
      name: 'integrity_gate_ready',
      passed: false,
      message: 'Integrity gate cannot evaluate until the verification projection matches outcome provenance.',
    });
    expect(gateResult.checks.filter((check) => check.name === 'verification_projection_matches_outcome')).toHaveLength(1);
    expect(gateResult.checks.filter((check) => check.name === 'integrity_gate_ready')).toHaveLength(1);
  });
});
