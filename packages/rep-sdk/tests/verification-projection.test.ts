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
    expect(Object.keys(projection.refs).sort()).toEqual(['coverage', 'subject', 'subject_verdict']);
    expect('check_run_refs' in projection).toBe(false);
    expect('reproducibility_report_ref' in projection).toBe(false);
    expect('integrity_report_ref' in projection).toBe(false);
  });

  it('fails closed when coverage linkage does not include the subject ref', () => {
    const fixture = createVerificationProjectionFixture('not_attempted');
    fixture.coverage.subject_refs = [];

    expect(() => deriveReproducibilityProjection(fixture)).toThrow(
      'Verification projection requires coverage.subject_refs to include the supplied subjectRef.',
    );
  });
});
