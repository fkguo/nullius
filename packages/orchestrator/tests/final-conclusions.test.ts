import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli.js';
import { handleOrchRunApprove, handleOrchRunApprovalsList } from '../src/orch-tools/approval.js';
import { consumeApprovedFinalConclusions } from '../src/orch-tools/final-conclusions.js';
import { handleOrchRunExport } from '../src/orch-tools/control.js';
import { handleOrchRunStatus } from '../src/orch-tools/create-status-list.js';
import { handleOrchRunRequestFinalConclusions } from '../src/orch-tools/final-conclusions.js';
import { handleOrchRunRecordVerification } from '../src/orch-tools/verification.js';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';
import { readRunListView } from '../src/orch-tools/run-read-model.js';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-final-conclusions-'));
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stderr,
    stdout,
  };
}

function createComputationFixture(projectRoot: string, runId: string): { runDir: string; manifestPath: string } {
  const runDir = path.join(projectRoot, runId);
  const scriptPath = path.join(runDir, 'computation', 'scripts', 'write_ok.py');
  const manifestPath = path.join(runDir, 'computation', 'manifest.json');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.txt').write_text('ok\\n', encoding='utf-8')\n",
    'utf-8',
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema_version: 1,
        entry_point: { script: 'scripts/write_ok.py', tool: 'python' },
        steps: [
          {
            id: 'write_ok',
            tool: 'python',
            script: 'scripts/write_ok.py',
            expected_outputs: ['outputs/ok.txt'],
          },
        ],
        environment: { python_version: '3.11', platform: 'any' },
        dependencies: {},
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return { runDir, manifestPath };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

const EXISTING_EVIDENCE_PATH = 'artifacts/computation_result_v1.json';

async function prepareCompletedRun(): Promise<{
  manager: StateManager;
  projectRoot: string;
  runDir: string;
  runId: string;
}> {
  const projectRoot = makeTempProjectRoot();
  const manager = new StateManager(projectRoot);
  manager.ensureDirs();
  const runId = 'M-A5-1';
  const state = manager.readState();
  state.run_id = runId;
  state.workflow_id = 'computation';
  state.run_status = 'running';
  state.gate_satisfied.A3 = 'A3-0001';
  manager.saveState(state);
  const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
  const { io, stdout } = makeIo(projectRoot);
  const code = await runCli([
    'run',
    '--workflow-id', 'computation',
    '--run-id', runId,
    '--run-dir', runDir,
    '--manifest', manifestPath,
  ], io);
  expect(code).toBe(0);
  expect(JSON.parse(stdout.join(''))).toMatchObject({
    status: 'completed',
    run_id: runId,
  });
  expect(manager.readState().run_status).toBe('completed');
  return { manager, projectRoot, runDir, runId };
}

function setVerificationPass(runDir: string): void {
  const verdictPath = path.join(runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
  const coveragePath = path.join(runDir, 'artifacts', 'verification_coverage_v1.json');
  const verdict = readJson<Record<string, unknown>>(verdictPath);
  verdict.status = 'verified';
  verdict.summary = 'Decisive verification completed successfully.';
  verdict.missing_decisive_checks = [];
  writeJson(verdictPath, verdict);

  const coverage = readJson<Record<string, unknown>>(coveragePath);
  coverage.summary = {
    subjects_total: 1,
    subjects_verified: 1,
    subjects_partial: 0,
    subjects_failed: 0,
    subjects_blocked: 0,
    subjects_not_attempted: 0,
  };
  coverage.missing_decisive_checks = [];
  writeJson(coveragePath, coverage);
}

async function recordVerificationPass(projectRoot: string, runId: string): Promise<Record<string, unknown>> {
  return handleOrchRunRecordVerification({
    project_root: projectRoot,
    run_id: runId,
    status: 'passed',
    summary: 'Decisive verification completed successfully.',
    evidence_paths: [EXISTING_EVIDENCE_PATH],
    confidence_level: 'high',
  }) as Promise<Record<string, unknown>>;
}

function setVerificationBlock(runDir: string): void {
  const verdictPath = path.join(runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
  const coveragePath = path.join(runDir, 'artifacts', 'verification_coverage_v1.json');
  const verdict = readJson<Record<string, unknown>>(verdictPath);
  verdict.status = 'failed';
  verdict.summary = 'Decisive verification found a mismatch.';
  verdict.missing_decisive_checks = [];
  writeJson(verdictPath, verdict);

  const coverage = readJson<Record<string, unknown>>(coveragePath);
  coverage.summary = {
    subjects_total: 1,
    subjects_verified: 0,
    subjects_partial: 0,
    subjects_failed: 1,
    subjects_blocked: 0,
    subjects_not_attempted: 0,
  };
  coverage.missing_decisive_checks = [];
  writeJson(coveragePath, coverage);
}

function setVerificationUnavailable(runDir: string): void {
  const resultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  const result = readJson<Record<string, unknown>>(resultPath);
  const verificationRefs = (result.verification_refs ?? {}) as Record<string, unknown>;
  delete verificationRefs.coverage_refs;
  result.verification_refs = verificationRefs;
  writeJson(resultPath, result);
}

async function requestA5(projectRoot: string, runId: string): Promise<Record<string, unknown>> {
  return handleOrchRunRequestFinalConclusions({
    project_root: projectRoot,
    run_id: runId,
    note: 'ready for A5',
  }) as Promise<Record<string, unknown>>;
}

describe('final conclusions consumer', () => {
  it('creates an A5 pending approval from a completed run when decisive verification passes', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);

    const payload = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
      note: 'ready for A5',
    }) as Record<string, unknown>;

    expect(payload).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A5',
      gate_decision: 'pass',
      run_id: runId,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval).toMatchObject({
      approval_id: 'A5-0001',
      category: 'A5',
    });

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.pending_approval).toMatchObject({
      approval_id: 'A5-0001',
      category: 'A5',
    });

    const approvalsView = await handleOrchRunApprovalsList({
      project_root: projectRoot,
      run_id: runId,
      gate_filter: 'all',
      include_history: false,
    }) as { approvals: Array<Record<string, unknown>> };
    expect(approvalsView.approvals).toEqual([
      expect.objectContaining({
        approval_id: 'A5-0001',
        gate_id: 'A5',
        status: 'pending',
      }),
    ]);
  });

  it('replays the same pending A5 approval on repeated requests', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);

    const first = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;
    const second = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;

    expect(first.approval_id).toBe('A5-0001');
    expect(second.approval_id).toBe('A5-0001');
    expect(manager.readState().approval_seq.A5).toBe(1);
  });

  it('records a decisive verification pass and makes A5 request runtime-reachable', async () => {
    const { manager, projectRoot, runId } = await prepareCompletedRun();

    const verification = await handleOrchRunRecordVerification({
      project_root: projectRoot,
      run_id: runId,
      status: 'passed',
      summary: 'Decisive verification completed successfully.',
      evidence_paths: [EXISTING_EVIDENCE_PATH],
      confidence_level: 'high',
      check_kind: 'decisive_verification',
    }) as Record<string, unknown>;

    expect(verification).toMatchObject({
      recorded: true,
      run_id: runId,
      status: 'passed',
    });

    const result = readJson<Record<string, unknown>>(path.join(projectRoot, runId, 'artifacts', 'computation_result_v1.json'));
    expect(result.verification_refs).toMatchObject({
      check_run_refs: [expect.objectContaining({ kind: 'verification_check_run' })],
    });
    const verificationDecisionNode = (result.workspace_feedback as Record<string, unknown>).workspace as Record<string, unknown>;
    expect((verificationDecisionNode.nodes as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node_id: `decision:verification:${runId}`,
        kind: 'decision',
        metadata: expect.objectContaining({
          boundary: 'verification',
          verification_status: 'passed',
        }),
      }),
    ]));
    expect((result.workspace_feedback as Record<string, unknown>).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'intervention_recorded',
        payload: expect.objectContaining({
          intervention_kind: 'verify',
          boundary: 'verification',
          verification_status: 'passed',
        }),
      }),
    ]));

    const verdict = readJson<Record<string, unknown>>(path.join(projectRoot, runId, 'artifacts', 'verification_subject_verdict_computation_result_v1.json'));
    expect(verdict).toMatchObject({
      status: 'verified',
      summary: 'Decisive verification completed successfully.',
      missing_decisive_checks: [],
    });
    expect(verdict.check_run_refs).toEqual([expect.objectContaining({ kind: 'verification_check_run' })]);

    const coverage = readJson<Record<string, unknown>>(path.join(projectRoot, runId, 'artifacts', 'verification_coverage_v1.json'));
    expect(coverage).toMatchObject({
      summary: {
        subjects_verified: 1,
        subjects_failed: 0,
        subjects_blocked: 0,
        subjects_not_attempted: 0,
      },
      missing_decisive_checks: [],
    });

    const finalConclusionsRequest = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;
    expect(finalConclusionsRequest).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A5',
      gate_decision: 'pass',
    });
    expect(manager.readState().pending_approval?.category).toBe('A5');
    const requestedResult = readJson<Record<string, unknown>>(path.join(projectRoot, runId, 'artifacts', 'computation_result_v1.json'));
    expect(((requestedResult.workspace_feedback as Record<string, unknown>).workspace as Record<string, unknown>).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node_id: `decision:final-conclusions:${runId}`,
        kind: 'decision',
        metadata: expect.objectContaining({
          boundary: 'final_conclusions',
          status: 'pending_approval',
          approval_id: 'A5-0001',
        }),
      }),
    ]));
    expect((requestedResult.workspace_feedback as Record<string, unknown>).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'intervention_recorded',
        payload: expect.objectContaining({
          intervention_kind: 'request_final_conclusions',
          boundary: 'final_conclusions_request',
          approval_id: 'A5-0001',
        }),
      }),
    ]));
  });

  it('fails closed after decisive verification is recorded as failed', async () => {
    const { manager, projectRoot, runId } = await prepareCompletedRun();

    const verification = await handleOrchRunRecordVerification({
      project_root: projectRoot,
      run_id: runId,
      status: 'failed',
      summary: 'Decisive verification found a mismatch.',
      evidence_paths: [EXISTING_EVIDENCE_PATH],
      confidence_level: 'medium',
    }) as Record<string, unknown>;

    expect(verification.status).toBe('failed');
    const request = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;
    expect(request).toMatchObject({
      status: 'blocked',
      gate_decision: 'block',
      ready_for_final_conclusions: false,
    });
    expect(manager.readState().pending_approval).toBeNull();
  });

  it('fails closed after decisive verification is recorded as blocked', async () => {
    const { manager, projectRoot, runId } = await prepareCompletedRun();

    const verification = await handleOrchRunRecordVerification({
      project_root: projectRoot,
      run_id: runId,
      status: 'blocked',
      summary: 'Verification is blocked by missing prerequisite evidence.',
      evidence_paths: [EXISTING_EVIDENCE_PATH],
      confidence_level: 'low',
    }) as Record<string, unknown>;

    expect(verification.status).toBe('blocked');
    const request = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;
    expect(request).toMatchObject({
      status: 'blocked',
      gate_decision: 'block',
      ready_for_final_conclusions: false,
    });
    expect(manager.readState().pending_approval).toBeNull();
  });

  it('approves A5 into a final_conclusions_v1 artifact and keeps run truth completed', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);

    const approval = await handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
      note: 'ship final conclusions',
    }) as Record<string, unknown>;

    expect(approval).toMatchObject({
      approved: true,
      approval_id: 'A5-0001',
      category: 'A5',
      run_status: 'completed',
      final_conclusions_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
      final_conclusions_uri: 'orch://runs/M-A5-1/artifact/final_conclusions_v1.json',
    });

    const state = manager.readState();
    expect(state.run_status).toBe('completed');
    expect(state.pending_approval).toBeNull();
    expect(state.gate_satisfied.A5).toBe('A5-0001');
    expect(state.approval_history).toEqual([
      expect.objectContaining({
        approval_id: 'A5-0001',
        category: 'A5',
        decision: 'approved',
      }),
    ]);
    expect(state.artifacts.final_conclusions_v1).toBe('artifacts/runs/M-A5-1/final_conclusions_v1.json');

    const artifactPath = path.join(projectRoot, String(approval.final_conclusions_path));
    const artifact = readJson<Record<string, unknown>>(artifactPath);
    expect(artifact).toMatchObject({
      schema_version: 1,
      run_id: runId,
      approval_id: 'A5-0001',
      gate_id: 'A5',
      objective_title: 'Approved computation for M-A5-1',
      source_result_summary: expect.stringContaining('Approved execution completed'),
      produced_artifact_refs: expect.any(Array),
      verification_check_run_refs: expect.any(Array),
      verification_summary: {
        decision: 'pass',
      },
      provenance: {
        orchestrator_component: '@autoresearch/orchestrator',
        trigger_surface: 'post_a5_approval_consumer',
        approved_via: 'orch_run_approve',
      },
    });
    const updatedResult = readJson<Record<string, unknown>>(path.join(projectRoot, runId, 'artifacts', 'computation_result_v1.json'));
    expect((((updatedResult.workspace_feedback as Record<string, unknown>).workspace as Record<string, unknown>).nodes)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        node_id: `decision:final-conclusions:${runId}`,
        kind: 'decision',
        metadata: expect.objectContaining({
          boundary: 'final_conclusions',
          status: 'approved',
          approval_id: 'A5-0001',
          final_conclusions_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
        }),
      }),
    ]));
    expect((updatedResult.workspace_feedback as Record<string, unknown>).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'intervention_recorded',
        payload: expect.objectContaining({
          intervention_kind: 'approve',
          boundary: 'final_conclusions_approved',
          approval_id: 'A5-0001',
          final_conclusions_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
        }),
      }),
    ]));

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView).toMatchObject({
      run_id: runId,
      run_status: 'completed',
      pending_approval: null,
      gate_satisfied: {
        A5: 'A5-0001',
      },
      final_conclusions: {
        artifact_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
        artifact_uri: 'orch://runs/M-A5-1/artifact/final_conclusions_v1.json',
        approval_id: 'A5-0001',
        objective_title: 'Approved computation for M-A5-1',
        verification_summary: {
          decision: 'pass',
        },
      },
      final_conclusions_error: null,
      research_outcome_projection: {
        projection_status: 'partial',
        source_final_conclusions_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
        objective_title: 'Approved computation for M-A5-1',
        summary: expect.stringContaining('A5 final conclusions were approved'),
        missing_for_research_outcome_v1: ['lineage_id', 'strategy_ref', 'metrics', 'rdi_scores'],
      },
      research_outcome_projection_error: null,
    });

    const exportView = await handleOrchRunExport({
      project_root: projectRoot,
      _confirm: true,
      include_state: true,
      include_artifacts: true,
    }) as Record<string, unknown>;
    expect(exportView.current_run_final_conclusions).toMatchObject({
      artifact_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
      approval_id: 'A5-0001',
      objective_title: 'Approved computation for M-A5-1',
    });
    expect(exportView.current_run_final_conclusions_error).toBeNull();
    expect(exportView.current_run_research_outcome_projection).toMatchObject({
      projection_status: 'partial',
      source_final_conclusions_path: 'artifacts/runs/M-A5-1/final_conclusions_v1.json',
      objective_title: 'Approved computation for M-A5-1',
    });
    expect(exportView.current_run_research_outcome_projection_error).toBeNull();

    const approvalsView = await handleOrchRunApprovalsList({
      project_root: projectRoot,
      run_id: runId,
      gate_filter: 'all',
      include_history: true,
    }) as { approvals: Array<Record<string, unknown>> };
    expect(approvalsView.approvals).toEqual([
      expect.objectContaining({
        approval_id: 'A5-0001',
        gate_id: 'A5',
        status: 'approved',
      }),
    ]);

    const runList = readRunListView(manager, { limit: 10, status_filter: 'all' });
    expect(runList.runs.find(run => run.run_id === runId)).toMatchObject({
      last_status: 'completed',
    });
  });

  it('fails closed when A5 approve loses canonical source truth after request time', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);
    fs.unlinkSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'));

    await expect(handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
      note: 'try approve anyway',
    })).rejects.toThrow();

    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval).toMatchObject({
      approval_id: 'A5-0001',
      category: 'A5',
    });
    expect(state.approval_history).toHaveLength(0);
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'final_conclusions_v1.json'))).toBe(false);
  });

  it('reports a structured final_conclusions error when the pointer exists but the artifact is missing', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    await recordVerificationPass(projectRoot, runId);
    const request = await requestA5(projectRoot, runId);
    await handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
    });

    const artifactPath = path.join(projectRoot, 'artifacts', 'runs', runId, 'final_conclusions_v1.json');
    fs.unlinkSync(artifactPath);

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.final_conclusions).toBeNull();
    expect(statusView.final_conclusions_error).toMatchObject({
      code: 'FINAL_CONCLUSIONS_MISSING',
    });

    const exportView = await handleOrchRunExport({
      project_root: projectRoot,
      _confirm: true,
      include_state: false,
      include_artifacts: true,
    }) as Record<string, unknown>;
    expect(exportView.current_run_final_conclusions).toBeNull();
    expect(exportView.current_run_final_conclusions_error).toMatchObject({
      code: 'FINAL_CONCLUSIONS_MISSING',
    });
    expect(exportView.current_run_research_outcome_projection).toBeNull();
    expect(exportView.current_run_research_outcome_projection_error).toMatchObject({
      code: 'RESEARCH_OUTCOME_PROJECTION_UNAVAILABLE',
    });

    // keep state pointer untouched; this path is meant to surface drift, not heal it silently
    expect(manager.readState().artifacts.final_conclusions_v1).toBe('artifacts/runs/M-A5-1/final_conclusions_v1.json');
  });

  it('does not create an approval when verification is still on hold', async () => {
    const { manager, projectRoot, runId } = await prepareCompletedRun();

    const payload = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;

    expect(payload).toMatchObject({
      status: 'not_ready',
      gate_id: 'A5',
      gate_decision: 'hold',
      ready_for_final_conclusions: false,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('completed');
    expect(state.pending_approval).toBeNull();
  });

  it('fails closed when decisive verification is blocking', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationBlock(runDir);

    const payload = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;

    expect(payload).toMatchObject({
      status: 'blocked',
      gate_id: 'A5',
      gate_decision: 'block',
      ready_for_final_conclusions: false,
    });
    expect(manager.readState().pending_approval).toBeNull();
  });

  it('fails closed when verification truth is unavailable', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationUnavailable(runDir);

    const payload = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
    }) as Record<string, unknown>;

    expect(payload).toMatchObject({
      status: 'unavailable',
      gate_id: 'A5',
      gate_decision: 'unavailable',
      ready_for_final_conclusions: false,
    });
    expect(manager.readState().pending_approval).toBeNull();
  });

  it('keeps CLI final-conclusions behavior aligned with the MCP handler', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'final-conclusions',
      '--run-id', runId,
      '--note', 'cli request',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A5',
      gate_decision: 'pass',
      run_id: runId,
    });
    const state = manager.readState() as RunState;
    expect(state.pending_approval?.category).toBe('A5');
  });

  it('prints final-conclusions pointers when CLI approve consumes A5', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    await requestA5(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli(['approve', 'A5-0001', '--note', 'approve via cli'], io);

    expect(code).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('approved: A5-0001');
    expect(text).toContain('final_conclusions_path: artifacts/runs/M-A5-1/final_conclusions_v1.json');
    expect(text).toContain('final_conclusions_uri: orch://runs/M-A5-1/artifact/final_conclusions_v1.json');
    expect(manager.readState().run_status).toBe('completed');
  });

  it('records decisive verification through the CLI front door', async () => {
    const { projectRoot, runId } = await prepareCompletedRun();
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'verify',
      '--run-id', runId,
      '--status', 'passed',
      '--summary', 'Decisive verification completed successfully.',
      '--evidence-path', EXISTING_EVIDENCE_PATH,
      '--confidence-level', 'high',
    ], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(payload).toMatchObject({
      recorded: true,
      run_id: runId,
      status: 'passed',
    });
  });

  it('returns a structured project_recent_digest error when the ledger is missing', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-DIGEST-LEDGER';
    state.workflow_id = 'computation';
    manager.saveState(state);
    fs.unlinkSync(manager.ledgerPath);

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.project_recent_digest).toBeNull();
    expect(statusView.project_recent_digest_error).toMatchObject({
      code: 'PROJECT_RECENT_DIGEST_LEDGER_MISSING',
    });
  });

  it('keeps project_recent_digest readable when a newer historical artifact is invalid', async () => {
    const { manager, projectRoot, runId } = await prepareCompletedRun();
    await recordVerificationPass(projectRoot, runId);
    const request = await requestA5(projectRoot, runId);
    await handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
      note: 'approve valid digest source',
    });

    manager.appendLedger('approval_approved', {
      run_id: 'M-DIGEST-BAD',
      details: { category: 'A5' },
    });
    writeJson(
      path.join(projectRoot, 'artifacts', 'runs', 'M-DIGEST-BAD', 'final_conclusions_v1.json'),
      { created_at: 'not-enough-fields' },
    );
    const state = manager.readState();
    state.run_id = 'M-DIGEST-BAD';
    state.workflow_id = 'computation';
    state.run_status = 'completed';
    manager.saveState(state);

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.project_recent_digest).toMatchObject({
      latest_final_conclusions: expect.objectContaining({
        run_id: runId,
      }),
    });
    expect(statusView.project_recent_digest_error).toMatchObject({
      code: 'PROJECT_RECENT_DIGEST_PARTIAL',
      read_errors: expect.arrayContaining([
        expect.objectContaining({
          code: 'FINAL_CONCLUSIONS_INVALID',
          run_id: 'M-DIGEST-BAD',
        }),
      ]),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-6 regression — digest reliability flag (torn-stream awareness)
//
// Source of bug: project_recent_digest is computed by walking
// ledger.jsonl. If the ledger had partial/torn lines from a crash
// mid-append, the digest used to be returned as if it were authoritative
// — even though it was silently skipping unparseable events. Downstream
// consumers (status, export, memory-graph) had no signal to distinguish
// a clean digest from one computed over a partial ledger.
//
// Fix: digest.reliable === true iff every ledger line parsed cleanly.
// Otherwise reliable === false and invalid_lines exposes the count.
// ─────────────────────────────────────────────────────────────────────────────

describe('B-6 regression — digest reliability flag', () => {
  it('marks digest.reliable === false when the ledger has malformed lines', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-DIGEST-TORN';
    state.workflow_id = 'computation';
    manager.saveState(state);
    // Append a deliberately-malformed line to the ledger to simulate a
    // torn-stream write (e.g. crash mid-append before the durable write
    // completed). Direct append is the only realistic way to reproduce
    // this in-test; the durable primitive's contract is "all-or-nothing
    // per call" but a crash between two calls leaves a partial file.
    fs.appendFileSync(manager.ledgerPath, '{ "ts": "torn", malformed-json\n', 'utf-8');
    // Then append a valid event so the digest still has SOME signal.
    manager.appendLedger('run_init', {
      run_id: 'M-DIGEST-TORN',
      workflow_id: 'computation',
    });

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;

    expect(statusView.project_recent_digest).toBeTruthy();
    const digest = statusView.project_recent_digest as Record<string, unknown>;
    expect(digest.reliable).toBe(false);
    expect(digest.invalid_lines).toBe(1);
    // The error path still surfaces the LEDGER_PARSE_ERROR for operators.
    expect(statusView.project_recent_digest_error).toMatchObject({
      code: 'PROJECT_RECENT_DIGEST_PARTIAL',
      read_errors: expect.arrayContaining([
        expect.objectContaining({ code: 'LEDGER_PARSE_ERROR' }),
      ]),
    });
  });

  it('marks digest.reliable === true and omits invalid_lines for a clean ledger', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-DIGEST-CLEAN';
    state.workflow_id = 'computation';
    manager.saveState(state);
    manager.appendLedger('run_init', {
      run_id: 'M-DIGEST-CLEAN',
      workflow_id: 'computation',
    });

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;

    expect(statusView.project_recent_digest).toBeTruthy();
    const digest = statusView.project_recent_digest as Record<string, unknown>;
    expect(digest.reliable).toBe(true);
    // invalid_lines is intentionally omitted when reliable to keep the
    // happy-path digest shape compact.
    expect('invalid_lines' in digest).toBe(false);
  });

  it('marks digest.reliable === false with the correct count when multiple lines are torn', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-DIGEST-MULTI-TORN';
    state.workflow_id = 'computation';
    manager.saveState(state);
    // Three torn lines interleaved with two valid events.
    fs.appendFileSync(manager.ledgerPath, '{ broken-1\n', 'utf-8');
    manager.appendLedger('run_init', { run_id: 'M-DIGEST-MULTI-TORN', workflow_id: 'computation' });
    fs.appendFileSync(manager.ledgerPath, 'not even close to json\n', 'utf-8');
    manager.appendLedger('status_changed', { run_id: 'M-DIGEST-MULTI-TORN', workflow_id: 'computation' });
    fs.appendFileSync(manager.ledgerPath, '{"ts": "still-broken\n', 'utf-8');

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    const digest = statusView.project_recent_digest as Record<string, unknown>;
    expect(digest.reliable).toBe(false);
    expect(digest.invalid_lines).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-4 regression — approval SHA-256 TOCTOU
// Source of bug: handleOrchRunApprove read the approval packet for the
// SHA-256 integrity check, but consumeApprovedFinalConclusions re-read the
// SAME file via readJsonFile for JSON.parse. Between the two reads a
// concurrent writer (or an attacker with write access to the project tree)
// could swap bytes A for bytes B — first read passes integrity with A,
// second read parses B, and the consumer acts on un-verified bytes.
//
// Fix:
//   - handleOrchRunApprove reads the packet ONCE into a Buffer
//   - Hash is computed from that Buffer
//   - The Buffer (packetBytes) is passed to consumeApprovedFinalConclusions
//   - The consumer parses from the in-memory bytes — never re-reads disk
//
// Direct unit test of consumeApprovedFinalConclusions used here because
// vitest+ESM cannot spy on `fs.readFileSync` (module namespace not
// configurable). Driving the bug surface directly is more honest than a
// fs-spy assertion anyway: we provide *verified* bytes and a *tampered*
// disk, and assert the consumer used the bytes.
// ─────────────────────────────────────────────────────────────────────────────
describe('B-4 regression — approval packet single-buffer read', () => {
  it('consumer parses from packetBytes, NOT from disk — survives tamper-after-hash', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);

    const packetPath = path.join(
      projectRoot,
      'artifacts', 'runs', runId, 'approvals', 'A5-0001', 'approval_packet_v1.json',
    );
    const packetPathRel = `artifacts/runs/${runId}/approvals/A5-0001/approval_packet_v1.json`;

    // Capture the genuine SHA-verified bytes (gate_id === 'A5')
    const genuineBytes = fs.readFileSync(packetPath);
    const genuineSha = createHash('sha256').update(genuineBytes).digest('hex');
    expect(genuineSha).toBe(String(request.approval_packet_sha256));

    // Tamper the on-disk file AFTER capturing the genuine bytes.
    // Simulates the attacker mutating the packet between the integrity
    // check and the consumer parse.
    const tampered = JSON.parse(genuineBytes.toString('utf-8')) as Record<string, unknown>;
    tampered.gate_id = 'A4';
    fs.writeFileSync(packetPath, JSON.stringify(tampered, null, 2), 'utf-8');

    // Call the consumer DIRECTLY with the genuine bytes. With the B-4 fix,
    // the consumer parses these bytes and sees gate_id === 'A5' → success.
    // Without the fix, the consumer would re-read packetPath → bytes have
    // gate_id === 'A4' → throws "final conclusions consumer requires an
    // A5 approval packet".
    const state = manager.readState();
    const result = await consumeApprovedFinalConclusions({
      approvalId: String(request.approval_id),
      packetBytes: genuineBytes,
      packetJsonPath: packetPath,
      packetPathRel,
      packetSha256: genuineSha,
      projectRoot,
      state,
    });

    expect(result.final_conclusions_path).toContain('final_conclusions_v1.json');
    // The produced final_conclusions_v1 artifact should exist on disk.
    expect(fs.existsSync(path.join(projectRoot, result.final_conclusions_path))).toBe(true);
  });

  it('end-to-end approve flow succeeds with the single-buffer-read path', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);

    const approval = await handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
    }) as Record<string, unknown>;

    expect(approval).toMatchObject({
      approved: true,
      approval_id: 'A5-0001',
      category: 'A5',
      run_status: 'completed',
    });

    const state = manager.readState();
    expect(state.run_status).toBe('completed');
    expect(state.pending_approval).toBeNull();
  });

  it('rejects approve when on-disk packet SHA-256 does not match the caller-supplied hash', async () => {
    const { projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);

    // Pre-existing integrity contract: passing a wrong SHA still fails
    // closed. Guards against future refactors that might accidentally
    // skip the SHA check while keeping the single-buffer-read pattern.
    await expect(
      handleOrchRunApprove({
        _confirm: true,
        approval_id: String(request.approval_id),
        approval_packet_sha256: 'a'.repeat(64),
        project_root: projectRoot,
      }),
    ).rejects.toThrow(/approval_packet_sha256 mismatch/);

    // Sanity: the genuine SHA still approves cleanly (proves the rejection
    // above wasn't a side-effect of the test setup).
    const approval = await handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
    }) as Record<string, unknown>;
    expect(approval.approved).toBe(true);
  });

  it('provenance — approval_packet_ref.sha256 in final_conclusions_v1 derives from SHA-verified bytes, not disk', async () => {
    // R1 reviewer found a residual TOCTOU: createControlPlaneArtifactRef
    // re-read the packet from disk to populate approval_packet_ref.sha256
    // and size_bytes in the persisted final_conclusions_v1.json. After
    // tamper-after-hash, that recorded SHA would be SHA(B) (tampered disk)
    // while the runtime decision used bytes A — a self-consistent but
    // internally-mismatched provenance chain.
    //
    // With the R2 fix, the helper takes `prehashedBytes` and derives both
    // sha256 AND size_bytes from those SHA-verified bytes.
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);

    const packetPath = path.join(
      projectRoot,
      'artifacts', 'runs', runId, 'approvals', 'A5-0001', 'approval_packet_v1.json',
    );
    const packetPathRel = `artifacts/runs/${runId}/approvals/A5-0001/approval_packet_v1.json`;

    const genuineBytes = fs.readFileSync(packetPath);
    const genuineSha = createHash('sha256').update(genuineBytes).digest('hex');
    expect(genuineSha).toBe(String(request.approval_packet_sha256));
    const genuineSize = genuineBytes.length;

    // Tamper disk: same gate_id (so the gate check would PASS even on disk
    // re-read — we don't want the test to short-circuit through the gate
    // check) but visibly different content so its SHA differs.
    const tampered = JSON.parse(genuineBytes.toString('utf-8')) as Record<string, unknown>;
    tampered._tamper_marker = 'mutated_after_hash_check';
    const tamperedBytes = Buffer.from(JSON.stringify(tampered, null, 2), 'utf-8');
    const tamperedSha = createHash('sha256').update(tamperedBytes).digest('hex');
    fs.writeFileSync(packetPath, tamperedBytes);
    expect(tamperedSha).not.toBe(genuineSha); // sanity

    const state = manager.readState();
    const result = await consumeApprovedFinalConclusions({
      approvalId: String(request.approval_id),
      packetBytes: genuineBytes,
      packetJsonPath: packetPath,
      packetPathRel,
      packetSha256: genuineSha,
      projectRoot,
      state,
    });

    const finalConclusions = readJson<Record<string, unknown>>(
      path.join(projectRoot, result.final_conclusions_path),
    );
    const ref = finalConclusions.approval_packet_ref as Record<string, unknown>;
    // Provenance MUST record the SHA-verified bytes, not the tampered disk
    expect(ref.sha256).toBe(genuineSha);
    expect(ref.size_bytes).toBe(genuineSize);
    expect(ref.sha256).not.toBe(tamperedSha);
  });

  it('falls back to disk read when packetBytes is omitted (backward compatibility)', async () => {
    const { manager, projectRoot, runDir, runId } = await prepareCompletedRun();
    setVerificationPass(runDir);
    const request = await requestA5(projectRoot, runId);

    const packetPath = path.join(
      projectRoot,
      'artifacts', 'runs', runId, 'approvals', 'A5-0001', 'approval_packet_v1.json',
    );
    const packetPathRel = `artifacts/runs/${runId}/approvals/A5-0001/approval_packet_v1.json`;

    // Caller without packetBytes (e.g. a hypothetical legacy MCP client)
    // should still work via the disk-read fallback path. This documents
    // the back-compat behavior — production callers MUST use packetBytes
    // to close the TOCTOU window.
    const state = manager.readState();
    const result = await consumeApprovedFinalConclusions({
      approvalId: String(request.approval_id),
      packetJsonPath: packetPath,
      packetPathRel,
      packetSha256: String(request.approval_packet_sha256),
      projectRoot,
      state,
    });

    expect(result.final_conclusions_path).toContain('final_conclusions_v1.json');
  });
});
