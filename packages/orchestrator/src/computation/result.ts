import * as fs from 'node:fs';
import * as path from 'node:path';
import { createArtifactRefV1, writeBytesAtomicDurable } from '@nullius/shared';
import { createHash } from 'node:crypto';
import type {
  ArtifactRefV1,
  ComputationResultV1,
  VerificationCoverageV1,
  VerificationSubjectV1,
  VerificationSubjectVerdictV1,
} from '@nullius/shared';
import { createRunArtifactRef, makeRunArtifactUri } from './artifact-refs.js';
import { assertExecutionPlanValid } from './execution-plan.js';
import { planComputationFollowupBridges, writeComputationFollowupBridgeArtifacts } from './followup-bridges.js';
import { writeJsonAtomic } from './io.js';
import { deriveFeedbackLowering, deriveNextIdeaLoopState } from './loop-feedback.js';
import { assertComputationResultValid } from './result-schema.js';
import { readFeedbackDeclaration } from './result-signal.js';
import type { ExecutionStatusFile, PreparedManifest } from './types.js';

function listFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function buildSummary(status: ExecutionStatusFile, producedCount: number): string {
  if (status.status === 'completed') {
    return `Approved execution completed ${status.steps.length} step(s) and produced ${producedCount} declared output artifact(s).`;
  }
  const failedStep = status.steps.find(step => step.status === 'failed');
  const completedSteps = status.steps.filter(step => step.status === 'completed').length;
  return `Approved execution failed at ${failedStep?.id ?? 'an unknown step'} after ${completedSteps}/${status.steps.length} completed step(s).`;
}

function loadExecutionPlanTitle(prepared: PreparedManifest): string {
  const planPath = path.join(prepared.workspaceDir, 'execution_plan_v1.json');
  if (!fs.existsSync(planPath)) {
    return prepared.manifest.title ?? `Approved computation for ${prepared.runId}`;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as unknown;
    return assertExecutionPlanValid(parsed).objective;
  } catch {
    return prepared.manifest.title ?? `Approved computation for ${prepared.runId}`;
  }
}

function collectProducedArtifactRefs(params: {
  prepared: PreparedManifest;
  statusPath: string;
  logsDir: string;
  producedOutputs: string[];
  fileRef?: (filePath: string, kind: string) => ArtifactRefV1;
}): ArtifactRefV1[] {
  const files = [
    params.statusPath,
    ...params.producedOutputs.filter(filePath => fs.existsSync(filePath)).sort(),
    ...listFilesRecursive(params.logsDir),
  ];
  const seen = new Set<string>();
  return files
    .filter(filePath => {
      if (seen.has(filePath)) return false;
      seen.add(filePath);
      return true;
    })
    .map(filePath => (params.fileRef ?? ((file, kind) => createRunArtifactRef(params.prepared.runId, params.prepared.runDir, file, kind)))(
      filePath,
      filePath === params.statusPath
        ? 'execution_status'
        : filePath.startsWith(params.logsDir)
          ? 'execution_log'
          : 'structured_result',
    ));
}

function writeComputationVerificationArtifacts(params: {
  prepared: PreparedManifest;
  manifestRef: ArtifactRefV1;
  producedArtifactRefs: ArtifactRefV1[];
  objectiveTitle: string;
  summary: string;
  executionStatus: Extract<ComputationResultV1['execution_status'], 'completed' | 'failed'>;
  generatedAt: string;
  writeJson: (filePath: string, payload: unknown) => void;
  fileRef: (filePath: string, kind: string) => ArtifactRefV1;
}): NonNullable<ComputationResultV1['verification_refs']> {
  const subjectId = `result:${params.prepared.runId}:computation_result`;
  const verdictId = `verdict:${params.prepared.runId}:computation_result`;
  const coverageId = `coverage:${params.prepared.runId}:computation_result`;
  const subjectPath = path.join(params.prepared.runDir, 'artifacts', 'verification_subject_computation_result_v1.json');
  const verdictPath = path.join(params.prepared.runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
  const coveragePath = path.join(params.prepared.runDir, 'artifacts', 'verification_coverage_v1.json');
  const subjectSourceRefs = [params.manifestRef, ...params.producedArtifactRefs] as [ArtifactRefV1, ...ArtifactRefV1[]];
  const missingCheck = {
    check_kind: 'decisive_verification_pending',
    reason: params.executionStatus === 'failed'
      ? 'Decisive verification is blocked by execution failure.'
      : 'Decisive verification has not been attempted yet.',
    priority: 'high' as const,
  };
  const subject: VerificationSubjectV1 = {
    schema_version: 1,
    subject_id: subjectId,
    subject_kind: 'result',
    run_id: params.prepared.runId,
    title: params.objectiveTitle,
    description: params.summary,
    source_refs: subjectSourceRefs,
    linked_identifiers: [{
      id_kind: 'computation_result_uri',
      id_value: makeRunArtifactUri(params.prepared.runId, 'artifacts/computation_result_v1.json'),
    }],
  };
  params.writeJson(subjectPath, subject);
  const subjectRef = params.fileRef(subjectPath, 'verification_subject');

  const verdict: VerificationSubjectVerdictV1 = {
    schema_version: 1,
    verdict_id: verdictId,
    run_id: params.prepared.runId,
    subject_id: subjectId,
    subject_ref: subjectRef,
    status: params.executionStatus === 'failed' ? 'blocked' : 'not_attempted',
    summary: params.executionStatus === 'failed'
      ? 'Decisive verification is blocked by execution failure.'
      : 'Decisive verification has not been attempted yet.',
    check_run_refs: [],
    missing_decisive_checks: [missingCheck],
  };
  params.writeJson(verdictPath, verdict);
  const verdictRef = params.fileRef(verdictPath, 'verification_subject_verdict');

  const coverage: VerificationCoverageV1 = {
    schema_version: 1,
    coverage_id: coverageId,
    run_id: params.prepared.runId,
    generated_at: params.generatedAt,
    subject_refs: [subjectRef],
    subject_verdict_refs: [verdictRef],
    summary: {
      subjects_total: 1,
      subjects_verified: 0,
      subjects_partial: 0,
      subjects_failed: 0,
      subjects_blocked: params.executionStatus === 'failed' ? 1 : 0,
      subjects_not_attempted: params.executionStatus === 'completed' ? 1 : 0,
    },
    missing_decisive_checks: [{
      subject_id: subjectId,
      subject_ref: subjectRef,
      check_kind: missingCheck.check_kind,
      reason: missingCheck.reason,
      priority: missingCheck.priority,
    }],
  };
  params.writeJson(coveragePath, coverage);
  const coverageRef = params.fileRef(coveragePath, 'verification_coverage');

  return {
    subject_refs: [subjectRef],
    subject_verdict_refs: [verdictRef],
    coverage_refs: [coverageRef],
  };
}

export function writeComputationResultArtifact(params: {
  prepared: PreparedManifest;
  status: ExecutionStatusFile;
  statusPath: string;
  logsDir: string;
  producedOutputs: string[];
  failureReason?: string;
  deferPublication?: boolean;
}): {
  computationResult: ComputationResultV1;
  computationResultPath: string;
  computationResultRef: ArtifactRefV1;
  commit: (guard?: () => void) => void;
  rollback: () => void;
  release: () => void;
} {
  if ((params.status.status !== 'completed' && params.status.status !== 'failed') || !params.status.completed_at) {
    throw new Error('computation result can only be written after execution reaches a terminal state');
  }
  const pending = new Map<string, string>();
  const writeJson = (filePath: string, payload: unknown): void => {
    if (params.deferPublication) pending.set(filePath, JSON.stringify(payload, null, 2) + '\n');
    else writeJsonAtomic(filePath, payload);
  };
  const fileRef = (filePath: string, kind: string): ArtifactRefV1 => {
    const bytes = pending.get(filePath);
    return bytes === undefined ? createRunArtifactRef(params.prepared.runId,params.prepared.runDir,filePath,kind)
      : createArtifactRefV1({uri:makeRunArtifactUri(params.prepared.runId,path.relative(params.prepared.runDir,filePath).split(path.sep).join('/')),
          sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:Buffer.byteLength(bytes),kind,produced_by:'@nullius/orchestrator'});
  };
  // Local publication is prepared before the canonical completion lock.
  // Raw child outputs/logs are never staged or rolled back here.
  if (params.deferPublication) writeJson(params.statusPath, params.status);
  const manifestRef = createRunArtifactRef(
    params.prepared.runId,
    params.prepared.runDir,
    params.prepared.manifestPath,
    'computation_manifest',
  );
  const producedArtifactRefs = collectProducedArtifactRefs({...params,fileRef});
  const objectiveTitle = loadExecutionPlanTitle(params.prepared);
  const summary = buildSummary(params.status, params.producedOutputs.length);
  const computationResultPath = path.join(params.prepared.runDir, 'artifacts', 'computation_result_v1.json');
  const declaration = readFeedbackDeclaration({
    executionStatus: params.status.status,
    producedOutputs: params.producedOutputs,
  });
  const feedbackLowering = deriveFeedbackLowering({
    runId: params.prepared.runId,
    executionStatus: params.status.status,
    signal: declaration?.signal ?? null,
    ...(declaration ? { declarationRef: fileRef(declaration.filePath, 'research_feedback') } : {}),
  });
  const baseResult = {
    schema_version: 1 as const,
    run_id: params.prepared.runId,
    objective_title: objectiveTitle,
    manifest_ref: manifestRef,
    execution_status: params.status.status,
    produced_artifact_refs: producedArtifactRefs,
    started_at: params.status.started_at,
    finished_at: params.status.completed_at,
    summary,
    feedback_lowering: feedbackLowering,
    executor_provenance: {
      orchestrator_component: '@nullius/orchestrator',
      execution_surface: 'computation_manifest_executor',
      approval_gate: 'A3' as const,
      step_tools: [...new Set(params.prepared.steps.map(step => step.tool))],
      step_ids: [...params.prepared.stepOrder],
    },
    ...(params.failureReason ? { failure_reason: params.failureReason } : {}),
  };
  const verificationRefs = writeComputationVerificationArtifacts({
    prepared: params.prepared,
    manifestRef,
    producedArtifactRefs,
    objectiveTitle,
    summary,
    executionStatus: params.status.status,
    generatedAt: params.status.completed_at,
    writeJson, fileRef,
  });
  const resultWithVerification = {
    ...baseResult,
    verification_refs: verificationRefs,
  };
  const followupBridges = planComputationFollowupBridges(params.prepared.runDir, resultWithVerification);
  const { workspaceFeedback, nextActions } = deriveNextIdeaLoopState(baseResult, followupBridges.writingSeed);
  const followupBridgeRefs = writeComputationFollowupBridgeArtifacts(
    params.prepared.runId,
    params.prepared.runDir,
    followupBridges.bridgePlans,
    {writeJson,fileRef},
  );
  const computationResult = assertComputationResultValid({
    ...resultWithVerification,
    next_actions: nextActions,
    followup_bridge_refs: followupBridgeRefs,
    workspace_feedback: workspaceFeedback,
  });
  writeJson(computationResultPath, computationResult);
  // Keep this journal until canonical completion succeeds. A writer can throw
  // after rename (directory fsync), and a later state guard can still refuse.
  const written: Array<{file:string; bytes:Buffer|null; mode:number|undefined; originalTimes:{atime:Date;mtime:Date}|null; published:string}> = [];
  const rollback = (): void => {
    while (written.length) {
      const entry = written.at(-1)!;
      const current = fs.existsSync(entry.file) ? fs.readFileSync(entry.file) : null;
      if (current?.equals(Buffer.from(entry.published))) {
        if (entry.bytes === null) fs.unlinkSync(entry.file);
        else {
          writeBytesAtomicDurable(entry.file,entry.bytes,entry.mode);
          if(entry.originalTimes) fs.utimesSync(entry.file,entry.originalTimes.atime,entry.originalTimes.mtime);
        }
      } else if (!(current === null && entry.bytes === null) && !(entry.bytes !== null && current?.equals(entry.bytes))) {
        throw new Error('local publication changed concurrently; manual reconciliation required');
      }
      written.pop();
    }
  };
  return {
    computationResult,
    computationResultPath,
    computationResultRef: fileRef(computationResultPath,'computation_result'),
    rollback,
    release: () => { written.length = 0; },
    commit: guard => {
      try {
        for (const [file,published] of pending) {
          guard?.();
          const previous = fs.existsSync(file) ? fs.statSync(file) : null;
          const bytes = previous ? fs.readFileSync(file) : null;
          const mode = previous ? previous.mode & 0o777 : undefined;
          written.push({file,bytes,mode,originalTimes:previous?{atime:previous.atime,mtime:previous.mtime}:null,published});
          writeBytesAtomicDurable(file,published,mode,guard);
        }
        guard?.();
      } catch (error) {
        try { rollback(); } catch (restoreError) { throw new Error('local publication rollback failed; manual reconciliation required', {cause:restoreError}); }
        throw error;
      }
    },
  };
}
