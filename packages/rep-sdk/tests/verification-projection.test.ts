import { describe, expect, it } from 'vitest';
import { deriveReproducibilityProjection } from '../src/validation/index.js';
import { createVerificationProjectionFixture } from './verification-fixtures.js';

describe('verification projection', () => {
  it('derives pending reproducibility truth from not_attempted verification artifacts', () => {
    const fixture = createVerificationProjectionFixture('not_attempted');

    const projection = deriveReproducibilityProjection(fixture);

    expect(projection.reproducibility_status).toBe('pending');
    expect(projection.verdict_status).toBe('not_attempted');
    expect(projection.decisive_check_missing).toBe(true);
    expect(projection.missing_decisive_checks).toEqual([
      {
        check_kind: 'decisive_verification_pending',
        reason: 'Decisive verification has not run yet.',
        priority: 'high',
      },
    ]);
    expect(projection.integrity).toEqual({
      status: 'pending_decisive_verification',
      gate_decision: 'hold',
      summary: 'Decisive verification is still pending.',
    });
    expect(projection.refs).toEqual({
      subject: fixture.subjectRef,
      subject_verdict: fixture.verdictRef,
      coverage: fixture.coverageRef,
    });
  });

  it('derives blocked reproducibility truth without fabricating report or check-run authority', () => {
    const fixture = createVerificationProjectionFixture('blocked');

    const projection = deriveReproducibilityProjection(fixture);

    expect(projection.reproducibility_status).toBe('blocked');
    expect(projection.summary).toContain('Execution failed');
    expect(projection.integrity).toEqual({
      status: 'blocked_by_execution_failure',
      gate_decision: 'block',
      summary: 'Execution failed before decisive verification completed.',
    });
    expect(Object.keys(projection.refs).sort()).toEqual(['coverage', 'subject', 'subject_verdict']);
    expect('check_run_refs' in projection).toBe(false);
    expect('reproducibility_report_ref' in projection).toBe(false);
    expect('integrity_report_ref' in projection).toBe(false);
  });

  it('derives decisive failed truth when executed checks back a failed verdict', () => {
    const fixture = createVerificationProjectionFixture('failed', {
      checkRunRefs: [{
        uri: 'rep://run-1/artifacts/verification_check_run_result.json',
        kind: 'verification_check_run',
        sha256: 'f'.repeat(64),
      }],
      missingDecisiveChecks: [],
      verdictSummary: 'Decisive verification found a mismatch.',
    });

    const projection = deriveReproducibilityProjection(fixture);

    expect(projection.reproducibility_status).toBe('failed');
    expect(projection.integrity).toEqual({
      status: 'decisive_verification_failed',
      gate_decision: 'block',
      summary: 'Decisive verification found a mismatch.',
    });
  });

  it('derives pending truth from partial verdicts', () => {
    const fixture = createVerificationProjectionFixture('partial', {
      verdictSummary: 'One supporting check ran, but decisive verification is still incomplete.',
    });

    const projection = deriveReproducibilityProjection(fixture);

    expect(projection.reproducibility_status).toBe('pending');
    expect(projection.integrity).toEqual({
      status: 'pending_decisive_verification',
      gate_decision: 'hold',
      summary: 'One supporting check ran, but decisive verification is still incomplete.',
    });
  });

  it.each(['verified', 'failed'] as const)(
    'fails closed when a decisive %s verdict lacks executed check refs',
    (status) => {
      const fixture = createVerificationProjectionFixture(status, {
        missingDecisiveChecks: [],
        verdictSummary: `A decisive ${status} verification was claimed without backing checks.`,
      });

      expect(() => deriveReproducibilityProjection(fixture)).toThrow(
        'Verification projection requires verdict.check_run_refs for decisive verified/failed verdicts.',
      );
    },
  );

  it('fails closed when decisive verdicts still carry missing decisive checks', () => {
    const fixture = createVerificationProjectionFixture('verified', {
      checkRunRefs: [{
        uri: 'rep://run-1/artifacts/verification_check_run_result.json',
        kind: 'verification_check_run',
        sha256: 'b'.repeat(64),
      }],
      verdictSummary: 'A decisive verification succeeded, but decisive gaps were still reported.',
    });

    expect(() => deriveReproducibilityProjection(fixture)).toThrow(
      'Verification projection cannot claim a decisive verified/failed verdict while missing decisive checks remain.',
    );
  });

  it('fails closed when coverage linkage does not include the subject ref', () => {
    const fixture = createVerificationProjectionFixture('not_attempted');
    fixture.coverage.subject_refs = [];

    expect(() => deriveReproducibilityProjection(fixture)).toThrow(
      'Verification projection requires coverage.subject_refs to include the supplied subjectRef.',
    );
  });
});
