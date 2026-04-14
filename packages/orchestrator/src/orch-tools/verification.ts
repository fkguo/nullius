import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ArtifactRefV1,
  ComputationResultV1,
  VerificationCheckRunV1,
  VerificationCoverageV1,
  VerificationSubjectV1,
  VerificationSubjectVerdictV1,
} from '@autoresearch/shared';
import { invalidParams } from '@autoresearch/shared';
import { z } from 'zod';
import { createRunArtifactRef } from '../computation/artifact-refs.js';
import { writeJsonAtomic } from '../computation/io.js';
import { assertComputationResultValid } from '../computation/result-schema.js';
import { createStateManager, requireState } from './common.js';
import { OrchRunRecordVerificationSchema } from './schemas.js';

type VerificationStatus = z.output<typeof OrchRunRecordVerificationSchema>['status'];

function resolveWithinRunDir(runDir: string, candidatePath: string, field: string): string {
  const resolvedRunDir = path.resolve(runDir);
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedRunDir, candidatePath);
  const relative = path.relative(resolvedRunDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidParams(`${field} must stay within the run directory`, {
      field,
      run_dir: resolvedRunDir,
      candidate: candidatePath,
    });
  }
  return resolved;
}

function loadRequiredJson<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) {
    throw invalidParams(`${label} is required before recording decisive verification.`, {
      missing_path: filePath,
      next_actions: [
        {
          tool: 'orch_run_execute_manifest',
          reason: 'Generate the canonical computation_result_v1 and verification kernel seed artifacts before recording decisive verification.',
        },
      ],
    });
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function updateCoverageSummary(
  status: VerificationStatus,
): VerificationCoverageV1['summary'] {
  return {
    subjects_total: 1,
    subjects_verified: status === 'passed' ? 1 : 0,
    subjects_partial: 0,
    subjects_failed: status === 'failed' ? 1 : 0,
    subjects_blocked: status === 'blocked' ? 1 : 0,
    subjects_not_attempted: 0,
  };
}

function verdictStatus(status: VerificationStatus): VerificationSubjectVerdictV1['status'] {
  if (status === 'passed') return 'verified';
  if (status === 'failed') return 'failed';
  return 'blocked';
}

function buildVerdictSummary(status: VerificationStatus, summary: string): string {
  if (status === 'passed') return summary;
  if (status === 'failed') return summary;
  return summary;
}

export async function handleOrchRunRecordVerification(
  params: z.output<typeof OrchRunRecordVerificationSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  if (state.run_id !== params.run_id) {
    throw invalidParams('Current orchestrator state does not match the requested run_id.', {
      state_run_id: state.run_id,
      requested_run_id: params.run_id,
    });
  }

  const runDir = path.join(projectRoot, params.run_id);
  const computationResultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  const subjectPath = path.join(runDir, 'artifacts', 'verification_subject_computation_result_v1.json');
  const verdictPath = path.join(runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
  const coveragePath = path.join(runDir, 'artifacts', 'verification_coverage_v1.json');
  const checkRunPath = path.join(runDir, 'artifacts', 'verification_check_run_computation_result_v1.json');

  const computationResult = assertComputationResultValid(loadRequiredJson<unknown>(computationResultPath, 'computation_result_v1.json'));
  const subject = loadRequiredJson<VerificationSubjectV1>(subjectPath, 'verification_subject_computation_result_v1.json');
  const verdict = loadRequiredJson<VerificationSubjectVerdictV1>(verdictPath, 'verification_subject_verdict_computation_result_v1.json');
  const coverage = loadRequiredJson<VerificationCoverageV1>(coveragePath, 'verification_coverage_v1.json');

  if (computationResult.run_id !== params.run_id || subject.run_id !== params.run_id || verdict.run_id !== params.run_id || coverage.run_id !== params.run_id) {
    throw invalidParams('Verification artifacts do not match the requested run provenance.', {
      run_id: params.run_id,
    });
  }
  if (verdict.subject_id !== subject.subject_id) {
    throw invalidParams('Verification subject and verdict are misaligned.', {
      subject_id: subject.subject_id,
      verdict_subject_id: verdict.subject_id,
    });
  }

  const evidenceRefs: ArtifactRefV1[] = params.evidence_paths.map((evidencePath) => {
    const resolved = resolveWithinRunDir(runDir, evidencePath, 'evidence_paths');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw invalidParams('Each evidence path must resolve to an existing file inside the run dir.', {
        evidence_path: evidencePath,
        resolved_path: resolved,
      });
    }
    return createRunArtifactRef(params.run_id, runDir, resolved, 'verification_evidence');
  });

  const subjectRef = createRunArtifactRef(params.run_id, runDir, subjectPath, 'verification_subject');
  const checkRun: VerificationCheckRunV1 = {
    schema_version: 1,
    check_run_id: `check:${params.run_id}:computation_result:${params.check_kind}`,
    run_id: params.run_id,
    subject_id: subject.subject_id,
    subject_ref: subjectRef,
    check_kind: params.check_kind,
    check_role: 'decisive',
    status: params.status,
    summary: params.summary,
    evidence_refs: evidenceRefs as [ArtifactRefV1, ...ArtifactRefV1[]],
    executor_provenance: {
      component: '@autoresearch/orchestrator',
      surface: 'orch_run_record_verification',
      executor_kind: 'operator_recorded',
    },
    confidence: {
      level: params.confidence_level,
      ...(params.confidence_score !== undefined ? { score: params.confidence_score } : {}),
    },
    ...(params.notes ? { notes: params.notes } : {}),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };
  writeJsonAtomic(checkRunPath, checkRun);
  const checkRunRef = createRunArtifactRef(params.run_id, runDir, checkRunPath, 'verification_check_run');

  const nextVerdict: VerificationSubjectVerdictV1 = {
    ...verdict,
    status: verdictStatus(params.status),
    summary: buildVerdictSummary(params.status, params.summary),
    check_run_refs: [checkRunRef],
    missing_decisive_checks: [],
  };
  writeJsonAtomic(verdictPath, nextVerdict);
  const verdictRef = createRunArtifactRef(params.run_id, runDir, verdictPath, 'verification_subject_verdict');

  const nextCoverage: VerificationCoverageV1 = {
    ...coverage,
    generated_at: new Date().toISOString(),
    subject_refs: [subjectRef],
    subject_verdict_refs: [verdictRef],
    summary: updateCoverageSummary(params.status),
    missing_decisive_checks: [],
  };
  writeJsonAtomic(coveragePath, nextCoverage);
  const coverageRef = createRunArtifactRef(params.run_id, runDir, coveragePath, 'verification_coverage');

  const nextComputationResult: ComputationResultV1 = {
    ...computationResult,
    verification_refs: {
      ...(computationResult.verification_refs ?? {}),
      subject_refs: [subjectRef],
      check_run_refs: [checkRunRef],
      subject_verdict_refs: [verdictRef],
      coverage_refs: [coverageRef],
    },
  };
  writeJsonAtomic(computationResultPath, nextComputationResult);

  return {
    recorded: true,
    run_id: params.run_id,
    status: params.status,
    gate_summary: params.summary,
    check_run_uri: checkRunRef.uri,
    verdict_uri: verdictRef.uri,
    coverage_uri: coverageRef.uri,
    computation_result_uri: createRunArtifactRef(params.run_id, runDir, computationResultPath, 'computation_result').uri,
  };
}
