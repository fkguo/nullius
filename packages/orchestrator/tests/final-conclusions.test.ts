import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli.js';
import { handleOrchRunApprove, handleOrchRunApprovalsList } from '../src/orch-tools/approval.js';
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
      verification_summary: {
        decision: 'pass',
      },
      provenance: {
        orchestrator_component: '@autoresearch/orchestrator',
        trigger_surface: 'post_a5_approval_consumer',
        approved_via: 'orch_run_approve',
      },
    });

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView).toMatchObject({
      run_id: runId,
      run_status: 'completed',
      pending_approval: null,
      gate_satisfied: {
        A5: 'A5-0001',
      },
    });

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
});
