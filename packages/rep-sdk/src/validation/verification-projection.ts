import type { ArtifactRef } from '../model/artifact.js';
import type {
  MissingDecisiveCheck,
  ReproducibilityProjection,
  ReproducibilityProjectionStatus,
  VerificationCoverage,
  VerificationIntegritySemantics,
  VerificationSubject,
  VerificationSubjectVerdict,
} from '../model/verification-projection.js';

export interface DeriveReproducibilityProjectionInput {
  subject: VerificationSubject;
  subjectRef: ArtifactRef;
  verdict: VerificationSubjectVerdict;
  verdictRef: ArtifactRef;
  coverage: VerificationCoverage;
  coverageRef: ArtifactRef;
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.uri === right.uri && left.sha256 === right.sha256;
}

function hasArtifactRef(refs: readonly ArtifactRef[], target: ArtifactRef): boolean {
  return refs.some((ref) => sameArtifactRef(ref, target));
}

function dedupeMissingChecks(checks: readonly MissingDecisiveCheck[]): MissingDecisiveCheck[] {
  const seen = new Set<string>();
  const unique: MissingDecisiveCheck[] = [];

  for (const check of checks) {
    const key = `${check.check_kind}:${check.reason}:${check.priority}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(check);
  }

  return unique;
}

function deriveIntegritySemantics(
  verdict: VerificationSubjectVerdict,
  missingChecks: readonly MissingDecisiveCheck[],
): VerificationIntegritySemantics {
  switch (verdict.status) {
    case 'blocked':
      return {
        status: 'blocked_by_execution_failure',
        gate_decision: 'block',
        summary: verdict.summary,
      };
    case 'verified':
    case 'failed':
      // Decisive terminal truth must stay backed by executed-check evidence.
      if (verdict.check_run_refs.length === 0) {
        throw new Error(
          'Verification projection requires verdict.check_run_refs for decisive verified/failed verdicts.',
        );
      }
      if (missingChecks.length > 0) {
        throw new Error(
          'Verification projection cannot claim a decisive verified/failed verdict while missing decisive checks remain.',
        );
      }
      return {
        status:
          verdict.status === 'verified'
            ? 'decisive_verification_complete'
            : 'decisive_verification_failed',
        gate_decision: verdict.status === 'verified' ? 'pass' : 'block',
        summary: verdict.summary,
      };
    case 'partial':
    case 'not_attempted':
      return {
        status: 'pending_decisive_verification',
        gate_decision: 'hold',
        summary: verdict.summary,
      };
  }
}

function projectVerdictStatus(
  integrityStatus: VerificationIntegritySemantics['status'],
): ReproducibilityProjectionStatus {
  switch (integrityStatus) {
    case 'decisive_verification_complete':
      return 'verified';
    case 'decisive_verification_failed':
      return 'failed';
    case 'blocked_by_execution_failure':
      return 'blocked';
    case 'pending_decisive_verification':
      return 'pending';
  }
}

export function deriveReproducibilityProjection(
  input: DeriveReproducibilityProjectionInput,
): ReproducibilityProjection {
  const { subject, subjectRef, verdict, verdictRef, coverage, coverageRef } = input;

  if (subject.run_id !== verdict.run_id || subject.run_id !== coverage.run_id) {
    throw new Error('Verification projection requires subject, verdict, and coverage to share one run_id.');
  }
  if (subject.subject_id !== verdict.subject_id) {
    throw new Error('Verification projection requires verdict.subject_id to match subject.subject_id.');
  }
  if (!sameArtifactRef(verdict.subject_ref, subjectRef)) {
    throw new Error('Verification projection requires verdict.subject_ref to match the supplied subjectRef.');
  }
  if (!hasArtifactRef(coverage.subject_refs, subjectRef)) {
    throw new Error('Verification projection requires coverage.subject_refs to include the supplied subjectRef.');
  }
  if (!hasArtifactRef(coverage.subject_verdict_refs, verdictRef)) {
    throw new Error(
      'Verification projection requires coverage.subject_verdict_refs to include the supplied verdictRef.',
    );
  }

  const coverageChecks = coverage.missing_decisive_checks
    .filter((gap) => gap.subject_id === subject.subject_id && sameArtifactRef(gap.subject_ref, subjectRef))
    .map(({ check_kind, reason, priority }) => ({ check_kind, reason, priority }));
  const missingDecisiveChecks = dedupeMissingChecks([
    ...verdict.missing_decisive_checks,
    ...coverageChecks,
  ]);
  const integrity = deriveIntegritySemantics(verdict, missingDecisiveChecks);

  return {
    source: 'verification_kernel_v1',
    run_id: subject.run_id,
    subject_id: subject.subject_id,
    subject_kind: subject.subject_kind,
    subject_title: subject.title,
    verdict_status: verdict.status,
    reproducibility_status: projectVerdictStatus(integrity.status),
    summary: verdict.summary,
    decisive_check_missing: missingDecisiveChecks.length > 0,
    missing_decisive_checks: missingDecisiveChecks,
    coverage_summary: { ...coverage.summary },
    integrity,
    refs: {
      subject: subjectRef,
      subject_verdict: verdictRef,
      coverage: coverageRef,
    },
  };
}
