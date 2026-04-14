import type {
  VerificationSubjectV1,
  VerificationCoverageV1,
  VerificationSubjectVerdictV1,
} from './generated/index.js';

export type VerificationLiftParseIssue = {
  path: string;
  message: string;
};

export type VerificationSubjectVerdictMetaV1 = {
  subject_id: string;
  status: VerificationSubjectVerdictV1['status'];
  missing_decisive_checks: Array<{
    check_kind: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }>;
};

export type VerificationCoverageMetaV1 = {
  summary: VerificationCoverageV1['summary'];
  missing_decisive_checks: Array<{
    subject_id: string;
    check_kind: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }>;
};

export type VerificationSubjectMetaV1 = {
  subject_id: string;
  run_id: string;
  subject_kind: VerificationSubjectV1['subject_kind'];
  title: string;
};

export type VerificationKernelGateDecision = 'pass' | 'hold' | 'block' | 'unavailable';

export type VerificationKernelGateResult = {
  decision: VerificationKernelGateDecision;
  summary: string;
};

type VerdictSuccess = { ok: true; value: VerificationSubjectVerdictMetaV1 };
type VerdictFailure = { ok: false; issues: VerificationLiftParseIssue[] };
type CoverageSuccess = { ok: true; value: VerificationCoverageMetaV1 };
type CoverageFailure = { ok: false; issues: VerificationLiftParseIssue[] };
type SubjectSuccess = { ok: true; value: VerificationSubjectMetaV1 };
type SubjectFailure = { ok: false; issues: VerificationLiftParseIssue[] };

function issue(path: string, message: string): VerificationLiftParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPriority(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validateMissingChecks(
  value: unknown,
  path: string,
  issues: VerificationLiftParseIssue[],
  needsSubjectId: boolean,
): Array<{
  subject_id?: string;
  check_kind: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
}> | null {
  if (!Array.isArray(value)) {
    issues.push(issue(path, 'must be an array'));
    return null;
  }
  const out: Array<{
    subject_id?: string;
    check_kind: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }> = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isObject(entry)) {
      issues.push(issue(entryPath, 'must be an object'));
      return;
    }
    if (needsSubjectId) {
      if (typeof entry.subject_id !== 'string' || entry.subject_id.length === 0) {
        issues.push(issue(`${entryPath}.subject_id`, 'must be a non-empty string'));
      }
    }
    if (typeof entry.check_kind !== 'string' || entry.check_kind.length === 0) {
      issues.push(issue(`${entryPath}.check_kind`, 'must be a non-empty string'));
    }
    if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
      issues.push(issue(`${entryPath}.reason`, 'must be a non-empty string'));
    }
    if (!isPriority(entry.priority)) {
      issues.push(issue(`${entryPath}.priority`, 'must be low, medium, or high'));
    }
    if (
      (!needsSubjectId || (typeof entry.subject_id === 'string' && entry.subject_id.length > 0))
      && typeof entry.check_kind === 'string'
      && entry.check_kind.length > 0
      && typeof entry.reason === 'string'
      && entry.reason.length > 0
      && isPriority(entry.priority)
    ) {
      out.push({
        ...(needsSubjectId ? { subject_id: entry.subject_id as string } : {}),
        check_kind: entry.check_kind,
        reason: entry.reason,
        priority: entry.priority,
      });
    }
  });
  return out;
}

export function safeParseVerificationSubjectVerdictMetaV1(value: unknown): VerdictSuccess | VerdictFailure {
  const issues: VerificationLiftParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.schema_version !== 1) {
    issues.push(issue('schema_version', 'must equal 1'));
  }
  if (typeof value.subject_id !== 'string' || value.subject_id.length === 0) {
    issues.push(issue('subject_id', 'must be a non-empty string'));
  }
  if (typeof value.status !== 'string' || value.status.length === 0) {
    issues.push(issue('status', 'must be a non-empty string'));
  }
  const missingChecks = validateMissingChecks(
    value.missing_decisive_checks,
    'missing_decisive_checks',
    issues,
    false,
  );
  if (issues.length > 0 || !missingChecks) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      subject_id: value.subject_id as string,
      status: value.status as VerificationSubjectVerdictV1['status'],
      missing_decisive_checks: missingChecks.map(check => ({
        check_kind: check.check_kind,
        reason: check.reason,
        priority: check.priority,
      })),
    },
  };
}

export function safeParseVerificationSubjectMetaV1(value: unknown): SubjectSuccess | SubjectFailure {
  const issues: VerificationLiftParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.schema_version !== 1) {
    issues.push(issue('schema_version', 'must equal 1'));
  }
  if (typeof value.subject_id !== 'string' || value.subject_id.length === 0) {
    issues.push(issue('subject_id', 'must be a non-empty string'));
  }
  if (typeof value.run_id !== 'string' || value.run_id.length === 0) {
    issues.push(issue('run_id', 'must be a non-empty string'));
  }
  if (typeof value.subject_kind !== 'string' || value.subject_kind.length === 0) {
    issues.push(issue('subject_kind', 'must be a non-empty string'));
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    issues.push(issue('title', 'must be a non-empty string'));
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      subject_id: value.subject_id as string,
      run_id: value.run_id as string,
      subject_kind: value.subject_kind as VerificationSubjectV1['subject_kind'],
      title: value.title as string,
    },
  };
}

export function safeParseVerificationCoverageMetaV1(value: unknown): CoverageSuccess | CoverageFailure {
  const issues: VerificationLiftParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.schema_version !== 1) {
    issues.push(issue('schema_version', 'must equal 1'));
  }
  if (!isObject(value.summary)) {
    issues.push(issue('summary', 'must be an object'));
  }
  const summary = value.summary as Record<string, unknown> | undefined;
  const summaryFields = [
    'subjects_total',
    'subjects_verified',
    'subjects_partial',
    'subjects_failed',
    'subjects_blocked',
    'subjects_not_attempted',
  ] as const;
  for (const field of summaryFields) {
    if (toFiniteNumber(summary?.[field]) === null) {
      issues.push(issue(`summary.${field}`, 'must be numeric'));
    }
  }
  const missingChecks = validateMissingChecks(
    value.missing_decisive_checks,
    'missing_decisive_checks',
    issues,
    true,
  );
  if (issues.length > 0 || !missingChecks || !summary) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      summary: {
        subjects_total: toFiniteNumber(summary.subjects_total)!,
        subjects_verified: toFiniteNumber(summary.subjects_verified)!,
        subjects_partial: toFiniteNumber(summary.subjects_partial)!,
        subjects_failed: toFiniteNumber(summary.subjects_failed)!,
        subjects_blocked: toFiniteNumber(summary.subjects_blocked)!,
        subjects_not_attempted: toFiniteNumber(summary.subjects_not_attempted)!,
      },
      missing_decisive_checks: missingChecks.map(check => ({
        subject_id: check.subject_id!,
        check_kind: check.check_kind,
        reason: check.reason,
        priority: check.priority,
      })),
    },
  };
}

export function evaluateVerificationKernelGateV1(input: {
  expected_run_id?: string;
  subject: unknown;
  verdict: unknown;
  coverage: unknown;
}): VerificationKernelGateResult {
  const subjectParsed = safeParseVerificationSubjectMetaV1(input.subject);
  if (!subjectParsed.ok) {
    return { decision: 'unavailable', summary: 'Verification subject is unavailable or malformed.' };
  }
  const verdictParsed = safeParseVerificationSubjectVerdictMetaV1(input.verdict);
  if (!verdictParsed.ok) {
    return { decision: 'unavailable', summary: 'Verification verdict is unavailable or malformed.' };
  }
  const coverageParsed = safeParseVerificationCoverageMetaV1(input.coverage);
  if (!coverageParsed.ok) {
    return { decision: 'unavailable', summary: 'Verification coverage is unavailable or malformed.' };
  }

  const subject = subjectParsed.value;
  const verdict = verdictParsed.value;
  const coverage = coverageParsed.value;

  if (input.expected_run_id && subject.run_id !== input.expected_run_id) {
    return { decision: 'unavailable', summary: 'Verification truth does not match the expected run provenance.' };
  }
  if (subject.subject_id !== verdict.subject_id) {
    return { decision: 'unavailable', summary: 'Verification subject and verdict are not aligned.' };
  }
  if (coverage.missing_decisive_checks.some(check => check.subject_id !== subject.subject_id)) {
    return { decision: 'unavailable', summary: 'Verification coverage does not match the expected subject.' };
  }

  switch (verdict.status) {
    case 'blocked':
      return { decision: 'block', summary: 'Execution failed before decisive verification completed.' };
    case 'failed':
      if (verdict.missing_decisive_checks.length > 0 || coverage.missing_decisive_checks.length > 0) {
        return { decision: 'unavailable', summary: 'Decisive verification failed but still reports unresolved decisive gaps.' };
      }
      return { decision: 'block', summary: 'Decisive verification found a mismatch.' };
    case 'verified':
      if (verdict.missing_decisive_checks.length > 0 || coverage.missing_decisive_checks.length > 0) {
        return { decision: 'hold', summary: 'Verification passed partially, but decisive verification is still pending.' };
      }
      return { decision: 'pass', summary: 'Decisive verification completed successfully.' };
    case 'partial':
    case 'not_attempted':
      return {
        decision: 'hold',
        summary: typeof (input.verdict as Record<string, unknown>).summary === 'string'
          ? String((input.verdict as Record<string, unknown>).summary)
          : 'Decisive verification is still pending.',
      };
    default:
      return { decision: 'unavailable', summary: 'Verification verdict status is unavailable.' };
  }
}
