import { describe, expect, it } from 'vitest';

import {
  safeParseVerificationCoverageMetaV1,
  safeParseVerificationSubjectVerdictMetaV1,
} from '../verification-lift.js';

describe('verification-lift runtime parser', () => {
  it('accepts a minimal valid subject verdict artifact', () => {
    const parsed = safeParseVerificationSubjectVerdictMetaV1({
      schema_version: 1,
      subject_id: 'result:run-1:computation_result',
      status: 'not_attempted',
      missing_decisive_checks: [
        {
          check_kind: 'decisive_verification_pending',
          reason: 'Not attempted yet.',
          priority: 'high',
        },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects malformed missing_decisive_checks on subject verdict artifacts', () => {
    const parsed = safeParseVerificationSubjectVerdictMetaV1({
      schema_version: 1,
      subject_id: 'result:run-1:computation_result',
      status: 'not_attempted',
      missing_decisive_checks: [
        {
          check_kind: 'decisive_verification_pending',
          priority: 'urgent',
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'missing_decisive_checks[0].reason' }),
        expect.objectContaining({ path: 'missing_decisive_checks[0].priority' }),
      ]),
    );
  });

  it('accepts a minimal valid verification coverage artifact', () => {
    const parsed = safeParseVerificationCoverageMetaV1({
      schema_version: 1,
      summary: {
        subjects_total: 1,
        subjects_verified: 0,
        subjects_partial: 0,
        subjects_failed: 0,
        subjects_blocked: 0,
        subjects_not_attempted: 1,
      },
      missing_decisive_checks: [
        {
          subject_id: 'result:run-1:computation_result',
          check_kind: 'decisive_verification_pending',
          reason: 'Not attempted yet.',
          priority: 'high',
        },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects malformed coverage summary fields', () => {
    const parsed = safeParseVerificationCoverageMetaV1({
      schema_version: 1,
      summary: {
        subjects_total: 'many',
        subjects_verified: 0,
        subjects_partial: 0,
        subjects_failed: 0,
        subjects_blocked: 0,
        subjects_not_attempted: 1,
      },
      missing_decisive_checks: [],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'summary.subjects_total' })]),
    );
  });

  it('rejects malformed coverage gaps', () => {
    const parsed = safeParseVerificationCoverageMetaV1({
      schema_version: 1,
      summary: {
        subjects_total: 1,
        subjects_verified: 0,
        subjects_partial: 0,
        subjects_failed: 0,
        subjects_blocked: 0,
        subjects_not_attempted: 1,
      },
      missing_decisive_checks: [
        {
          check_kind: 'decisive_verification_pending',
          reason: 'Not attempted yet.',
          priority: 'high',
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'missing_decisive_checks[0].subject_id' })]),
    );
  });
});
