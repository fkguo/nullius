import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeBytesAtomicDurable } from '@nullius/shared';
import { StateManager } from '../state-manager.js';
import { maybeQueueIdeaEngineComputationFeedback } from './idea-engine-feedback.js';
import { maybeGenerateSkillProposal } from './skill-proposal-genesis.js';
import { maybeGenerateOpportunityProposals } from './opportunity-proposal-genesis.js';
import { utcNowIso } from '../util.js';
import { ensureDir, sha256File, toPosixRelative, writeJsonAtomic } from './io.js';
import { recordComputationResultToMemoryGraph } from './memory-graph-hookup.js';
import { writeComputationResultArtifact } from './result.js';
import { assertDeclaredDependencyClosure, assertStepPathArgumentsDeclared } from './dependency-closure.js';
import { assertNoSymlinkComponents, resolveWithinRoot } from './path-safety.js';
import { assertNativeRuntimeIdentityLive } from './runtime-identity.js';
import type {
  CompletedExecutionResult,
  ExternalDependencySnapshotEntry,
  ExecutionStatusFile,
  FailedExecutionResult,
  PreparedManifest,
  StepExecutionSnapshotV1,
  StepCommandPlan,
  WorkspaceFileSnapshotEntry,
} from './types.js';

function generatedProposal<T extends { proposalPath: string }>(
  proposal: T | { suppressed: true; proposalFingerprint: string; decision: string } | null,
): proposal is T {
  return Boolean(proposal && 'proposalPath' in proposal);
}

function buildStatus(prepared: PreparedManifest): ExecutionStatusFile {
  return {
    schema_version: 1,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    status: 'running',
    started_at: utcNowIso(),
    completed_at: null,
    errors: [],
    entry_point: {
      script: prepared.entryPointScriptRelativePath,
      sha256: sha256File(prepared.entryPointScriptPath),
    },
    steps: prepared.steps.map(step => ({
      id: step.id,
      tool: step.tool,
      command: step.argv,
      runtime_identity: step.runtimeIdentity,
      execution_environment: step.executionEnvironment,
      script: step.scriptRelativePath,
      script_pre_sha256: sha256File(step.scriptPath),
      script_post_sha256: null,
      expected_outputs: step.expectedOutputs,
      pre_snapshot_path: `logs/${step.id}/pre_snapshot_v1.json`,
      pre_snapshot_sha256: null,
      post_snapshot_path: `logs/${step.id}/post_snapshot_v1.json`,
      post_snapshot_sha256: null,
      output_refs: [],
      status: 'pending',
      exit_code: null,
      started_at: null,
      completed_at: null,
      log_dir: '',
    })),
  };
}

function snapshotWorkspaceFile(workspaceDir: string, filePath: string): WorkspaceFileSnapshotEntry {
  assertNoSymlinkComponents(workspaceDir, filePath, 'workspace snapshot file');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`workspace snapshot target is not a regular file: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  return {
    relative_path: toPosixRelative(workspaceDir, filePath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

function listWorkspaceSnapshotEntries(params: {
  logsDir: string;
  statusPath: string;
  workspaceDir: string;
}): WorkspaceFileSnapshotEntry[] {
  const entries: WorkspaceFileSnapshotEntry[] = [];
  const walk = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(dirPath, entry.name);
      if (fullPath === params.logsDir || fullPath === params.statusPath) continue;
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`workspace snapshot refuses symbolic link: ${fullPath}`);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        entries.push(snapshotWorkspaceFile(params.workspaceDir, fullPath));
      } else {
        throw new Error(`workspace snapshot refuses non-regular filesystem entry: ${fullPath}`);
      }
    }
  };
  walk(params.workspaceDir);
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function externalDependencySnapshotEntries(prepared: PreparedManifest): ExternalDependencySnapshotEntry[] {
  const dependencies = prepared.manifest.dependencies as Record<string, unknown>;
  const refs = Array.isArray(dependencies.external_dependency_refs)
    ? dependencies.external_dependency_refs as Array<Record<string, unknown>>
    : [];
  return refs.map((ref, index) => {
    if (typeof ref.path !== 'string' || typeof ref.sha256 !== 'string') {
      throw new Error(`external_dependency_refs[${index}] must contain path and sha256`);
    }
    if (!path.isAbsolute(ref.path)) {
      throw new Error(`external_dependency_refs[${index}].path must be absolute and must not depend on the caller working directory`);
    }
    const canonicalPath = fs.realpathSync.native(ref.path);
    if (!fs.lstatSync(canonicalPath).isFile()) {
      throw new Error(`external dependency is not a regular file: ${ref.path}`);
    }
    const bytes = fs.readFileSync(canonicalPath);
    const actual = sha256File(canonicalPath);
    if (actual !== ref.sha256) {
      throw new Error(`external dependency hash mismatch: ${ref.path}`);
    }
    if (ref.size_bytes !== undefined && ref.size_bytes !== bytes.length) {
      throw new Error(`external dependency size mismatch: ${ref.path}`);
    }
    return { canonical_path: canonicalPath, sha256: actual, size_bytes: bytes.length };
  }).sort((left, right) => left.canonical_path.localeCompare(right.canonical_path));
}

function assertWorkspaceRefsLive(workspaceDir: string, refs: WorkspaceFileSnapshotEntry[], label: string): void {
  for (const ref of refs) {
    const filePath = resolveWithinRoot(workspaceDir, ref.relative_path, label);
    assertNoSymlinkComponents(workspaceDir, filePath, label);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      throw new Error(`${label} is missing: ${ref.relative_path}`);
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== ref.size_bytes || sha256File(filePath) !== ref.sha256) {
      throw new Error(`${label} changed: ${ref.relative_path}`);
    }
  }
}

function requireNonEmptyWorkspaceRefs(
  refs: WorkspaceFileSnapshotEntry[],
  label: string,
): [WorkspaceFileSnapshotEntry, ...WorkspaceFileSnapshotEntry[]] {
  if (refs.length === 0) throw new Error(`${label} must contain at least one workspace file`);
  return refs as [WorkspaceFileSnapshotEntry, ...WorkspaceFileSnapshotEntry[]];
}

function assertExternalRefsLive(refs: ExternalDependencySnapshotEntry[], label: string): void {
  for (const ref of refs) {
    if (!fs.existsSync(ref.canonical_path) || !fs.lstatSync(ref.canonical_path).isFile()) {
      throw new Error(`${label} is missing: ${ref.canonical_path}`);
    }
    const bytes = fs.readFileSync(ref.canonical_path);
    if (bytes.length !== ref.size_bytes || sha256File(ref.canonical_path) !== ref.sha256) {
      throw new Error(`${label} changed: ${ref.canonical_path}`);
    }
  }
}

function priorOutputRefs(status: ExecutionStatusFile, currentStepId?: string): WorkspaceFileSnapshotEntry[] {
  return status.steps
    .filter(step => step.id !== currentStepId && step.status === 'completed')
    .flatMap(step => step.output_refs);
}

function writeExecutionSnapshot(filePath: string, snapshot: StepExecutionSnapshotV1): string {
  writeJsonAtomic(filePath, snapshot);
  return sha256File(filePath);
}

function assertPreparedExecutionBinding(prepared: PreparedManifest): void {
  const entryMatches = prepared.steps.filter(
    step => step.scriptRelativePath === prepared.entryPointScriptRelativePath,
  );
  if (entryMatches.length !== 1) {
    throw new Error(
      `entry_point.script must identify exactly one executed manifest step; found ${entryMatches.length}`,
    );
  }
  const entryStep = entryMatches[0]!;
  const declaredEntryArgs = prepared.manifest.entry_point.args ?? [];
  const stepArgs = prepared.manifest.steps.find(step => step.id === entryStep.id)?.args ?? [];
  if (
    (prepared.manifest.entry_point.tool !== undefined && prepared.manifest.entry_point.tool !== entryStep.tool)
    || declaredEntryArgs.length !== stepArgs.length
    || declaredEntryArgs.some((value, index) => value !== stepArgs[index])
  ) {
    throw new Error('entry_point must match the unique executed step tool and arguments exactly');
  }
  if (sha256File(prepared.manifestPath) !== prepared.manifestSha256) {
    throw new Error('computation manifest changed after preparation and before execution');
  }
}

function syntheticIntegrityFailureOutput(message: string): ReturnType<typeof spawnSync> {
  return {
    pid: 0,
    output: [null, '', message],
    stdout: '',
    stderr: message,
    status: null,
    signal: null,
    error: undefined,
  } as ReturnType<typeof spawnSync>;
}

function writeStepLogs(
  logDir: string,
  step: StepCommandPlan,
  output: ReturnType<typeof spawnSync>,
  snapshotMeta: Record<string, unknown>,
): void {
  ensureDir(logDir);
  // stdout/stderr capture must survive crash before the next CLI re-read
  // (status --json reads these on resume to surface failure context).
  writeBytesAtomicDurable(path.join(logDir, 'stdout.txt'), output.stdout ?? '');
  writeBytesAtomicDurable(path.join(logDir, 'stderr.txt'), output.stderr ?? '');
  writeJsonAtomic(path.join(logDir, 'meta.json'), {
    command: step.argv,
    exit_code: output.status,
    signal: output.signal,
    error: output.error?.message ?? null,
    runtime_identity: step.runtimeIdentity,
    execution_environment: step.executionEnvironment,
    ...snapshotMeta,
  });
}

export async function runPreparedManifest(
  projectRoot: string,
  prepared: PreparedManifest,
): Promise<CompletedExecutionResult | FailedExecutionResult> {
  assertPreparedExecutionBinding(prepared);
  const stateManager = new StateManager(projectRoot);
  const logsDir = path.join(prepared.workspaceDir, 'logs');
  const statusPath = path.join(prepared.workspaceDir, 'execution_status.json');
  const status = buildStatus(prepared);
  writeJsonAtomic(statusPath, status);
  for (const stepId of prepared.stepOrder) {
    const step = prepared.steps.find(candidate => candidate.id === stepId)!;
    const statusStep = status.steps.find(candidate => candidate.id === stepId)!;
    const logDir = path.join(logsDir, stepId);
    statusStep.status = 'running';
    statusStep.started_at = utcNowIso();
    statusStep.log_dir = toPosixRelative(prepared.workspaceDir, logDir);
    writeJsonAtomic(statusPath, status);
    let integrityFailure: string | null = null;
    let liveManifestHash = '';
    let liveScriptHash = '';
    let workspaceRefs: WorkspaceFileSnapshotEntry[] = [];
    let externalRefs: ExternalDependencySnapshotEntry[] = [];
    const preSnapshotPath = path.join(logDir, 'pre_snapshot_v1.json');
    const postSnapshotPath = path.join(logDir, 'post_snapshot_v1.json');
    ensureDir(logDir);
    try {
      assertNativeRuntimeIdentityLive({
        identity: step.runtimeIdentity,
        projectRoot,
        runDir: prepared.runDir,
      });
      assertWorkspaceRefsLive(prepared.workspaceDir, priorOutputRefs(status, step.id), 'prior step output before spawn');
      for (const outputPath of step.expectedOutputPaths) {
        assertNoSymlinkComponents(prepared.workspaceDir, outputPath, `step '${step.id}' output`, { allowMissingLeaf: true });
        if (fs.existsSync(outputPath)) {
          throw new Error(`step '${step.id}' expected output existed before spawn: ${toPosixRelative(prepared.workspaceDir, outputPath)}`);
        }
      }
      liveManifestHash = sha256File(prepared.manifestPath);
      liveScriptHash = sha256File(step.scriptPath);
      workspaceRefs = listWorkspaceSnapshotEntries({
        logsDir,
        statusPath,
        workspaceDir: prepared.workspaceDir,
      });
      externalRefs = externalDependencySnapshotEntries(prepared);
      assertWorkspaceRefsLive(prepared.workspaceDir, workspaceRefs, `step '${step.id}' pre-spawn workspace snapshot`);
      assertExternalRefsLive(externalRefs, `step '${step.id}' pre-spawn external dependency`);
      assertDeclaredDependencyClosure({
        externalRefs,
        manifest: prepared.manifest,
        workspaceDir: prepared.workspaceDir,
        workspaceRefs,
      });
      assertStepPathArgumentsDeclared({
        externalRefs,
        manifest: prepared.manifest,
        workspaceDir: prepared.workspaceDir,
      });
      const manifestRelativePath = toPosixRelative(prepared.workspaceDir, prepared.manifestPath);
      const scriptRelativePath = toPosixRelative(prepared.workspaceDir, step.scriptPath);
      const manifestRef = workspaceRefs.find(ref => ref.relative_path === manifestRelativePath);
      const scriptRef = workspaceRefs.find(ref => ref.relative_path === scriptRelativePath);
      if (!manifestRef || !scriptRef) {
        throw new Error(`step '${step.id}' pre-spawn snapshot omitted manifest or script`);
      }
      const preSnapshot: StepExecutionSnapshotV1 = {
        schema_version: 1,
        phase: 'pre_spawn',
        step_id: step.id,
        captured_at: utcNowIso(),
        manifest_ref: manifestRef,
        script_ref: scriptRef,
        runtime_identity: step.runtimeIdentity,
        execution_environment: step.executionEnvironment,
        workspace_file_refs: requireNonEmptyWorkspaceRefs(
          workspaceRefs,
          `step '${step.id}' pre-spawn snapshot`,
        ),
        external_dependency_refs: externalRefs,
        external_dependency_closure: 'declared_and_locked_not_syscall_traced',
      };
      statusStep.pre_snapshot_sha256 = writeExecutionSnapshot(preSnapshotPath, preSnapshot);
      writeJsonAtomic(statusPath, status);
    } catch (error) {
      integrityFailure = `pre-spawn provenance for step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!integrityFailure && liveManifestHash !== prepared.manifestSha256) {
      integrityFailure = `manifest changed before step '${step.id}' was spawned`;
    } else if (!integrityFailure && liveScriptHash !== statusStep.script_pre_sha256) {
      integrityFailure = `script for step '${step.id}' changed after the execution plan was recorded`;
    } else if (!integrityFailure && (statusStep.command.length !== step.argv.length || statusStep.command.some((value, index) => value !== step.argv[index]))) {
      integrityFailure = `structured command for step '${step.id}' changed after the execution plan was recorded`;
    }
    const output = integrityFailure
      ? syntheticIntegrityFailureOutput(integrityFailure)
      : spawnSync(step.argv[0]!, step.argv.slice(1), {
        cwd: prepared.workspaceDir,
        encoding: 'utf-8',
        env: step.executionEnvironment.variables,
        timeout: step.timeoutMinutes ? step.timeoutMinutes * 60_000 : undefined,
      });
    if (!integrityFailure) {
      try {
        assertNativeRuntimeIdentityLive({
          identity: step.runtimeIdentity,
          projectRoot,
          runDir: prepared.runDir,
        });
        const postManifestHash = sha256File(prepared.manifestPath);
        const postScriptHash = sha256File(step.scriptPath);
        if (postManifestHash !== liveManifestHash) {
          integrityFailure = `manifest changed while step '${step.id}' was executing`;
        } else if (postScriptHash !== liveScriptHash) {
          integrityFailure = `script for step '${step.id}' changed while it was executing`;
        }
        statusStep.script_post_sha256 = postScriptHash;
      } catch (error) {
        integrityFailure = `post-exit provenance for step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    statusStep.exit_code = output.status ?? null;
    statusStep.completed_at = utcNowIso();
    const missingOutputs = step.expectedOutputPaths.filter(filePath => !fs.existsSync(filePath));
    if (!integrityFailure && !output.error && output.status === 0 && missingOutputs.length === 0) {
      try {
        const outputRefs = step.expectedOutputPaths.map((filePath) => {
          assertNoSymlinkComponents(prepared.workspaceDir, filePath, `step '${step.id}' produced output`);
          return snapshotWorkspaceFile(prepared.workspaceDir, filePath);
        });
        assertWorkspaceRefsLive(
          prepared.workspaceDir,
          workspaceRefs,
          `step '${step.id}' pre-spawn inputs after exit`,
        );
        assertWorkspaceRefsLive(prepared.workspaceDir, priorOutputRefs(status, step.id), 'prior step output after current step');
        assertExternalRefsLive(externalRefs, `step '${step.id}' post-exit external dependency`);
        const manifestRef = snapshotWorkspaceFile(prepared.workspaceDir, prepared.manifestPath);
        const scriptRef = snapshotWorkspaceFile(prepared.workspaceDir, step.scriptPath);
        const postSnapshot: StepExecutionSnapshotV1 = {
          schema_version: 1,
          phase: 'post_exit',
          step_id: step.id,
          captured_at: utcNowIso(),
          manifest_ref: manifestRef,
          script_ref: scriptRef,
          runtime_identity: step.runtimeIdentity,
          execution_environment: step.executionEnvironment,
          workspace_file_refs: requireNonEmptyWorkspaceRefs(
            workspaceRefs,
            `step '${step.id}' post-exit snapshot`,
          ),
          external_dependency_refs: externalRefs,
          output_refs: outputRefs,
          external_dependency_closure: 'declared_and_locked_not_syscall_traced',
        };
        statusStep.output_refs = outputRefs;
        statusStep.post_snapshot_sha256 = writeExecutionSnapshot(postSnapshotPath, postSnapshot);
      } catch (error) {
        integrityFailure = `post-exit output provenance for step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    writeStepLogs(logDir, step, output, {
      pre_snapshot_path: statusStep.pre_snapshot_path,
      pre_snapshot_sha256: statusStep.pre_snapshot_sha256,
      post_snapshot_path: statusStep.post_snapshot_path,
      post_snapshot_sha256: statusStep.post_snapshot_sha256,
      script_pre_sha256: statusStep.script_pre_sha256,
      script_post_sha256: statusStep.script_post_sha256,
      output_refs: statusStep.output_refs,
    });
    if (integrityFailure || output.error || output.status !== 0 || missingOutputs.length > 0) {
      statusStep.status = 'failed';
      status.status = 'failed';
      status.completed_at = utcNowIso();
      const failureReason = integrityFailure ?? output.error?.message
        ?? (output.status !== 0
          ? `step '${step.id}' exited with code ${output.status}`
          : `step '${step.id}' did not produce expected outputs: ${missingOutputs.map(filePath => toPosixRelative(prepared.runDir, filePath)).join(', ')}`);
      status.errors.push(failureReason);
      writeJsonAtomic(statusPath, status);
      const failedState = stateManager.readState();
      if (failedState.run_status === 'running') {
        stateManager.transitionStatus(failedState, 'failed', {
          eventType: 'execution_failed',
          details: { run_id: prepared.runId, step_id: step.id, execution_status: statusPath },
        });
      }
      const { computationResult, computationResultPath, computationResultRef } = writeComputationResultArtifact({
        prepared,
        status,
        statusPath,
        logsDir,
        producedOutputs: prepared.steps.flatMap(currentStep => currentStep.expectedOutputPaths.filter(filePath => fs.existsSync(filePath))),
        failureReason,
      });
      maybeQueueIdeaEngineComputationFeedback({
        prepared,
        computationResult,
      });
      const memoryGraph = await recordComputationResultToMemoryGraph({
        projectRoot,
        manifest: prepared.manifest,
        computationResult,
      });
      if (memoryGraph.repairProposalPath) {
        const state = stateManager.readState();
        state.artifacts = {
          ...state.artifacts,
          mutation_proposal_repair_v1: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
        };
        stateManager.saveState(state);
        stateManager.appendLedger('repair_mutation_proposed', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_id: memoryGraph.repairProposalId,
            proposal_path: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
          },
        });
      } else if (memoryGraph.repairProposalSuppressed) {
        stateManager.appendLedger('proposal_suppressed', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_kind: 'repair',
            proposal_fingerprint: memoryGraph.repairProposalFingerprint,
            suppression_decision: memoryGraph.repairSuppressionDecision,
          },
        });
      }
      const skillProposal = maybeGenerateSkillProposal({
        projectRoot,
        runId: prepared.runId,
        manifest: prepared.manifest,
        computationResult,
      });
      if (skillProposal && !skillProposal.suppressed) {
        const state = stateManager.readState();
        state.artifacts = {
          ...state.artifacts,
          skill_proposal_v2: toPosixRelative(projectRoot, skillProposal.proposalPath),
        };
        stateManager.saveState(state);
        stateManager.appendLedger('skill_proposal_generated', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_id: skillProposal.proposal.proposal_id,
            proposal_path: toPosixRelative(projectRoot, skillProposal.proposalPath),
          },
        });
      } else if (skillProposal?.suppressed) {
        stateManager.appendLedger('proposal_suppressed', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_kind: 'skill',
            proposal_fingerprint: skillProposal.proposalFingerprint,
            suppression_decision: skillProposal.decision,
          },
        });
      }
      const opportunityProposals = maybeGenerateOpportunityProposals({
        projectRoot,
        runId: prepared.runId,
        manifest: prepared.manifest,
        computationResult,
      });
      if (opportunityProposals.optimize || opportunityProposals.innovate) {
        const state = stateManager.readState();
        state.artifacts = {
          ...state.artifacts,
          ...(generatedProposal(opportunityProposals.optimize) ? { mutation_proposal_optimize_v1: toPosixRelative(projectRoot, opportunityProposals.optimize.proposalPath) } : {}),
          ...(generatedProposal(opportunityProposals.innovate) ? { mutation_proposal_innovate_v1: toPosixRelative(projectRoot, opportunityProposals.innovate.proposalPath) } : {}),
        };
        stateManager.saveState(state);
        for (const [proposalKind, proposal] of [['optimize', opportunityProposals.optimize], ['innovate', opportunityProposals.innovate]] as const) {
          if (proposal && !('proposalPath' in proposal)) {
            stateManager.appendLedger('proposal_suppressed', {
              run_id: prepared.runId,
              workflow_id: 'computation',
              details: {
                proposal_kind: proposalKind,
                proposal_fingerprint: proposal.proposalFingerprint,
                suppression_decision: proposal.decision,
              },
            });
          }
        }
      }
      return {
        status: 'failed',
        ok: false,
        run_id: prepared.runId,
        manifest_path: prepared.manifestRelativePath,
        manifest_sha256: prepared.manifestSha256,
        artifact_paths: {
          execution_status: statusPath,
          logs_dir: logsDir,
          computation_result: computationResultPath,
        },
        outcome_ref: computationResultRef,
        next_actions: computationResult.next_actions,
        followup_bridge_refs: computationResult.followup_bridge_refs,
        summary: computationResult.summary,
        errors: [...status.errors],
      };
    }
    statusStep.status = 'completed';
    writeJsonAtomic(statusPath, status);
  }
  try {
    assertWorkspaceRefsLive(prepared.workspaceDir, priorOutputRefs(status), 'final production output');
    for (const step of prepared.steps) {
      assertNativeRuntimeIdentityLive({
        identity: step.runtimeIdentity,
        projectRoot,
        runDir: prepared.runDir,
      });
    }
  } catch (error) {
    const message = `final production provenance failed: ${error instanceof Error ? error.message : String(error)}`;
    status.status = 'failed';
    status.completed_at = utcNowIso();
    status.errors.push(message);
    writeJsonAtomic(statusPath, status);
    throw new Error(message);
  }
  status.status = 'completed';
  status.completed_at = utcNowIso();
  writeJsonAtomic(statusPath, status);
  const completedState = stateManager.readState();
  if (completedState.run_status === 'running') {
    stateManager.transitionStatus(completedState, 'completed', {
      eventType: 'execution_completed',
      details: { run_id: prepared.runId, execution_status: statusPath },
    });
  }
  const producedOutputs = prepared.steps.flatMap(step => step.expectedOutputPaths.filter(filePath => fs.existsSync(filePath)));
  const { computationResult, computationResultPath, computationResultRef } = writeComputationResultArtifact({
    prepared,
    status,
    statusPath,
    logsDir,
    producedOutputs,
  });
  maybeQueueIdeaEngineComputationFeedback({
    prepared,
    computationResult,
  });
  const memoryGraph = await recordComputationResultToMemoryGraph({
    projectRoot,
    manifest: prepared.manifest,
    computationResult,
  });
  if (memoryGraph.repairProposalPath) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      mutation_proposal_repair_v1: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
    };
    stateManager.saveState(state);
    stateManager.appendLedger('repair_mutation_proposed', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_id: memoryGraph.repairProposalId,
        proposal_path: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
      },
    });
  } else if (memoryGraph.repairProposalSuppressed) {
    stateManager.appendLedger('proposal_suppressed', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_kind: 'repair',
        proposal_fingerprint: memoryGraph.repairProposalFingerprint,
        suppression_decision: memoryGraph.repairSuppressionDecision,
      },
    });
  }
  const skillProposal = maybeGenerateSkillProposal({
    projectRoot,
    runId: prepared.runId,
    manifest: prepared.manifest,
    computationResult,
  });
  if (skillProposal && !skillProposal.suppressed) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      skill_proposal_v2: toPosixRelative(projectRoot, skillProposal.proposalPath),
    };
    stateManager.saveState(state);
    stateManager.appendLedger('skill_proposal_generated', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_id: skillProposal.proposal.proposal_id,
        proposal_path: toPosixRelative(projectRoot, skillProposal.proposalPath),
      },
    });
  } else if (skillProposal?.suppressed) {
    stateManager.appendLedger('proposal_suppressed', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_kind: 'skill',
        proposal_fingerprint: skillProposal.proposalFingerprint,
        suppression_decision: skillProposal.decision,
      },
    });
  }
  const opportunityProposals = maybeGenerateOpportunityProposals({
    projectRoot,
    runId: prepared.runId,
    manifest: prepared.manifest,
    computationResult,
  });
  if (opportunityProposals.optimize || opportunityProposals.innovate) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      ...(generatedProposal(opportunityProposals.optimize) ? { mutation_proposal_optimize_v1: toPosixRelative(projectRoot, opportunityProposals.optimize.proposalPath) } : {}),
      ...(generatedProposal(opportunityProposals.innovate) ? { mutation_proposal_innovate_v1: toPosixRelative(projectRoot, opportunityProposals.innovate.proposalPath) } : {}),
    };
    stateManager.saveState(state);
    for (const [proposalKind, proposal] of [['optimize', opportunityProposals.optimize], ['innovate', opportunityProposals.innovate]] as const) {
      if (proposal && !('proposalPath' in proposal)) {
        stateManager.appendLedger('proposal_suppressed', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_kind: proposalKind,
            proposal_fingerprint: proposal.proposalFingerprint,
            suppression_decision: proposal.decision,
          },
        });
      }
    }
  }
  return {
    status: 'completed',
    ok: true,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    artifact_paths: {
      execution_status: statusPath,
      logs_dir: logsDir,
      computation_result: computationResultPath,
    },
    outcome_ref: computationResultRef,
    next_actions: computationResult.next_actions,
    followup_bridge_refs: computationResult.followup_bridge_refs,
    summary: computationResult.summary,
    produced_outputs: producedOutputs,
  };
}
