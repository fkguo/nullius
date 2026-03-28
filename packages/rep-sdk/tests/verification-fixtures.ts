import type { ArtifactRef } from '../src/model/artifact.js';
import type {
  MissingDecisiveCheck,
  VerificationCoverage,
  VerificationCoverageSummary,
  VerificationSubject,
  VerificationSubjectVerdict,
  VerificationSubjectVerdictStatus,
} from '../src/model/verification-projection.js';
import { sha256Hex } from '../src/protocol/index.js';

export interface VerificationProjectionFixture {
  subject: VerificationSubject;
  subjectRef: ArtifactRef;
  verdict: VerificationSubjectVerdict;
  verdictRef: ArtifactRef;
  coverage: VerificationCoverage;
  coverageRef: ArtifactRef;
}

export interface VerificationProjectionFixtureOptions {
  checkRunRefs?: ArtifactRef[];
  missingDecisiveChecks?: MissingDecisiveCheck[];
  verdictSummary?: string;
}

function coverageSummaryFor(status: VerificationSubjectVerdictStatus): VerificationCoverageSummary {
  return {
    subjects_total: 1,
    subjects_verified: status === 'verified' ? 1 : 0,
    subjects_partial: status === 'partial' ? 1 : 0,
    subjects_failed: status === 'failed' ? 1 : 0,
    subjects_blocked: status === 'blocked' ? 1 : 0,
    subjects_not_attempted: status === 'not_attempted' ? 1 : 0,
  };
}

export function createVerificationProjectionFixture(
  status: VerificationSubjectVerdictStatus = 'not_attempted',
  options: VerificationProjectionFixtureOptions = {},
): VerificationProjectionFixture {
  const missingDecisiveChecks = options.missingDecisiveChecks ?? [
    {
      check_kind: 'decisive_verification_pending',
      reason:
        status === 'blocked'
          ? 'Execution failed before decisive verification could run.'
          : 'Decisive verification has not run yet.',
      priority: 'high',
    },
  ];
  const subjectRef: ArtifactRef = {
    uri: 'rep://run-1/artifacts/verification_subject_result.json',
    kind: 'verification_subject',
    sha256: sha256Hex('verification-subject'),
  };
  const verdictRef: ArtifactRef = {
    uri: 'rep://run-1/artifacts/verification_subject_verdict_result.json',
    kind: 'verification_subject_verdict',
    sha256: sha256Hex('verification-verdict'),
  };
  const coverageRef: ArtifactRef = {
    uri: 'rep://run-1/artifacts/verification_coverage.json',
    kind: 'verification_coverage',
    sha256: sha256Hex('verification-coverage'),
  };

  return {
    subject: {
      schema_version: 1,
      subject_id: 'subject-result-1',
      subject_kind: 'result',
      run_id: 'run-1',
      title: 'Bounded contour result',
      source_refs: [{ uri: 'rep://run-1/artifacts/manifest.json', kind: 'manifest', sha256: sha256Hex('manifest') }],
    },
    subjectRef,
    verdict: {
      schema_version: 1,
      verdict_id: 'verdict-result-1',
      run_id: 'run-1',
      subject_id: 'subject-result-1',
      subject_ref: subjectRef,
      status,
      summary:
        options.verdictSummary
        ?? (status === 'blocked'
          ? 'Execution failed before decisive verification completed.'
          : 'Decisive verification is still pending.'),
      check_run_refs: options.checkRunRefs ?? [],
      missing_decisive_checks: missingDecisiveChecks,
    },
    verdictRef,
    coverage: {
      schema_version: 1,
      coverage_id: 'coverage-1',
      run_id: 'run-1',
      generated_at: '2026-03-27T00:00:00.000Z',
      subject_refs: [subjectRef],
      subject_verdict_refs: [verdictRef],
      summary: coverageSummaryFor(status),
      missing_decisive_checks: missingDecisiveChecks.map((check) => ({
        subject_id: 'subject-result-1',
        subject_ref: subjectRef,
        ...check,
      })),
    },
    coverageRef,
  };
}
