import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli.js';
import { handleOrchRunApprovalsList } from '../src/orch-tools/approval.js';
import { handleOrchRunStatus } from '../src/orch-tools/create-status-list.js';
import { handleOrchRunRequestFinalConclusions } from '../src/orch-tools/final-conclusions.js';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';

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
});
