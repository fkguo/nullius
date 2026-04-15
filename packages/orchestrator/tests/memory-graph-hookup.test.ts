import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemoryGraph } from '@autoresearch/shared';
import { runCli } from '../src/cli.js';
import { executeComputationManifest } from '../src/computation/index.js';
import { handleOrchRunApprove } from '../src/orch-tools/approval.js';
import { handleOrchRunExport } from '../src/orch-tools/control.js';
import { handleOrchRunRequestFinalConclusions } from '../src/orch-tools/final-conclusions.js';
import { handleOrchRunRecordProposalDecision } from '../src/orch-tools/proposal-decision.js';
import { handleOrchRunStatus } from '../src/orch-tools/create-status-list.js';
import { handleOrchRunRecordVerification } from '../src/orch-tools/verification.js';
import { StateManager } from '../src/state-manager.js';
import { createTeamExecutionState } from '../src/team-execution-state.js';
import { TeamExecutionStateManager } from '../src/team-execution-storage.js';
import type { TeamPermissionMatrix } from '../src/team-execution-types.js';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-memory-graph-'));
}

function memoryGraphDbPath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch', 'memory-graph.sqlite');
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
    stdout,
    stderr,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function createCompletedFixture(projectRoot: string, runId: string): { runDir: string; manifestPath: string } {
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
        dependencies: {
          python_packages: ['sympy'],
          julia_packages: ['LoopTools'],
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return { runDir, manifestPath };
}

function createFailedFixture(projectRoot: string, runId: string): { runDir: string; manifestPath: string } {
  const runDir = path.join(projectRoot, runId);
  const scriptPath = path.join(runDir, 'computation', 'scripts', 'fail.py');
  const manifestPath = path.join(runDir, 'computation', 'manifest.json');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "raise SystemExit(1)\n", 'utf-8');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema_version: 1,
        entry_point: { script: 'scripts/fail.py', tool: 'python' },
        steps: [
          {
            id: 'fail_step',
            tool: 'python',
            script: 'scripts/fail.py',
            expected_outputs: [],
          },
        ],
        environment: { python_version: '3.11', platform: 'any' },
        dependencies: {
          python_packages: ['sympy'],
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return { runDir, manifestPath };
}

async function prepareCompletedRun(projectRoot: string, runId: string) {
  const manager = new StateManager(projectRoot);
  manager.ensureDirs();
  const state = manager.readState();
  state.run_id = runId;
  state.workflow_id = 'computation';
  state.run_status = 'running';
  state.gate_satisfied.A3 = 'A3-0001';
  manager.saveState(state);
  const { runDir, manifestPath } = createCompletedFixture(projectRoot, runId);
  const { io, stdout } = makeIo(projectRoot);
  const code = await runCli([
    'run',
    '--workflow-id', 'computation',
    '--run-id', runId,
    '--run-dir', runDir,
    '--manifest', manifestPath,
  ], io);
  expect(code).toBe(0);
  expect(JSON.parse(stdout.join(''))).toMatchObject({ status: 'completed', run_id: runId });
  return { manager, runDir, runId };
}

const TEAM_PERMISSIONS: TeamPermissionMatrix = {
  delegation: [
    {
      from_role: 'lead',
      to_role: 'delegate',
      allowed_task_kinds: ['compute', 'review'],
      allowed_handoff_kinds: ['compute', 'review'],
    },
  ],
  interventions: [
    {
      actor_role: 'lead',
      allowed_scopes: ['task', 'team'],
      allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
    },
  ],
};

describe('memory-graph hookup', () => {
  it('records compute failure and dependency/package signals into the control-plane memory graph', async () => {
    const projectRoot = makeTempProjectRoot();
    const runId = 'run-memory-fail';
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);

    const { runDir, manifestPath } = createFailedFixture(projectRoot, runId);
    const result = await executeComputationManifest({
      projectRoot,
      runId,
      runDir,
      manifestPath,
    });

    expect(result.status).toBe('failed');

    const graph = createMemoryGraph({ dbPath: memoryGraphDbPath(projectRoot) });
    const recent = await graph.getRecentEvents(4);
    expect(recent.some((event) => event.event_type === 'signal' && event.run_id === runId)).toBe(true);
    expect(recent.some((event) => event.event_type === 'outcome' && event.run_id === runId && (event.payload as Record<string, unknown>).gene_id === 'boundary:compute_result:failed')).toBe(true);

    const topSignals = await graph.topSignals(30, 20);
    expect(topSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'boundary:compute_result' }),
      expect.objectContaining({ signal: 'execution_status:failed' }),
      expect.objectContaining({ signal: 'package:python:sympy' }),
    ]));
    const proposalPath = path.join(projectRoot, 'artifacts', 'runs', runId, 'mutation_proposal_repair_v1.json');
    expect(fs.existsSync(proposalPath)).toBe(false);
  });

  it('records decisive verification and final conclusions closeout into the same memory graph', async () => {
    const projectRoot = makeTempProjectRoot();
    const runId = 'run-memory-a5';
    const { manager } = await prepareCompletedRun(projectRoot, runId);

    const verification = await handleOrchRunRecordVerification({
      project_root: projectRoot,
      run_id: runId,
      status: 'passed',
      summary: 'Decisive verification completed successfully.',
      evidence_paths: ['artifacts/computation_result_v1.json'],
      confidence_level: 'high',
    }) as Record<string, unknown>;

    const request = await handleOrchRunRequestFinalConclusions({
      project_root: projectRoot,
      run_id: runId,
      note: 'ready for A5',
    }) as Record<string, unknown>;

    const approval = await handleOrchRunApprove({
      _confirm: true,
      approval_id: String(request.approval_id),
      approval_packet_sha256: String(request.approval_packet_sha256),
      project_root: projectRoot,
      note: 'ship final conclusions',
    }) as Record<string, unknown>;

    expect(manager.readState().run_status).toBe('completed');

    const graph = createMemoryGraph({ dbPath: memoryGraphDbPath(projectRoot) });
    const recent = await graph.getRecentEvents(10);
    expect(recent.some((event) => event.event_type === 'outcome' && event.run_id === runId && (event.payload as Record<string, unknown>).gene_id === 'boundary:verification:passed')).toBe(true);
    expect(recent.some((event) => event.event_type === 'outcome' && event.run_id === runId && (event.payload as Record<string, unknown>).gene_id === 'boundary:final_conclusions:A5')).toBe(true);

    const topSignals = await graph.topSignals(30, 30);
    expect(topSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'boundary:verification' }),
      expect.objectContaining({ signal: 'verification_status:passed' }),
      expect.objectContaining({ signal: 'boundary:final_conclusions' }),
      expect.objectContaining({ signal: 'gate:a5' }),
      expect.objectContaining({ signal: 'package:julia:looptools' }),
    ]));

    const storedResult = readJson<Record<string, unknown>>(path.join(projectRoot, runId, 'artifacts', 'computation_result_v1.json'));
    expect(storedResult.verification_refs).toMatchObject({
      check_run_refs: [expect.objectContaining({ uri: verification.check_run_uri })],
    });
    expect(approval.final_conclusions_uri).toBe('orch://runs/run-memory-a5/artifact/final_conclusions_v1.json');
  });

  it('emits a local repair mutation proposal after the same failed signal repeats and surfaces it via status/export', async () => {
    const projectRoot = makeTempProjectRoot();
    for (const runId of ['run-memory-repeat-a', 'run-memory-repeat-b']) {
      const manager = new StateManager(projectRoot);
      manager.ensureDirs();
      const state = manager.readState();
      state.run_id = runId;
      state.workflow_id = 'computation';
      state.run_status = 'running';
      state.gate_satisfied.A3 = 'A3-0001';
      manager.saveState(state);

      const { runDir, manifestPath } = createFailedFixture(projectRoot, runId);
      const result = await executeComputationManifest({
        projectRoot,
        runId,
        runDir,
        manifestPath,
      });
      expect(result.status).toBe('failed');
    }

    const proposalPath = path.join(projectRoot, 'artifacts', 'runs', 'run-memory-repeat-b', 'mutation_proposal_repair_v1.json');
    expect(fs.existsSync(proposalPath)).toBe(true);
    const proposal = readJson<Record<string, unknown>>(proposalPath);
    expect(proposal).toMatchObject({
      mutation_type: 'repair',
      gate_level: 'A1',
      status: 'proposed',
      run_id: 'run-memory-repeat-b',
    });

    const manager = new StateManager(projectRoot);
    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.repair_mutation_proposal).toMatchObject({
      mutation_type: 'repair',
      status: 'proposed',
      run_id: 'run-memory-repeat-b',
    });
    expect(statusView.repair_mutation_proposal_error).toBeNull();

    const exportView = await handleOrchRunExport({
      project_root: projectRoot,
      _confirm: true,
      include_state: false,
      include_artifacts: true,
    }) as Record<string, unknown>;
    expect(exportView.current_run_repair_mutation_proposal).toMatchObject({
      mutation_type: 'repair',
      status: 'proposed',
      run_id: 'run-memory-repeat-b',
    });
    expect(exportView.current_run_repair_mutation_proposal_error).toBeNull();
    expect(manager.readState().artifacts.mutation_proposal_repair_v1).toBe('artifacts/runs/run-memory-repeat-b/mutation_proposal_repair_v1.json');
  });

  it.each([
    'accepted_for_later',
    'dismissed',
    'already_captured',
  ] as const)('records repair proposal decision %s and suppresses future duplicates', async (decision) => {
    const projectRoot = makeTempProjectRoot();
    for (const runId of ['run-decision-a', 'run-decision-b']) {
      const manager = new StateManager(projectRoot);
      manager.ensureDirs();
      const state = manager.readState();
      state.run_id = runId;
      state.workflow_id = 'computation';
      state.run_status = 'running';
      state.gate_satisfied.A3 = 'A3-0001';
      manager.saveState(state);
      const { runDir, manifestPath } = createFailedFixture(projectRoot, runId);
      const result = await executeComputationManifest({ projectRoot, runId, runDir, manifestPath });
      expect(result.status).toBe('failed');
    }

    const proposalPath = path.join(projectRoot, 'artifacts', 'runs', 'run-decision-b', 'mutation_proposal_repair_v1.json');
    const proposal = readJson<Record<string, unknown>>(proposalPath);
    const payload = await handleOrchRunRecordProposalDecision({
      project_root: projectRoot,
      proposal_kind: 'repair',
      proposal_id: String(proposal.proposal_id),
      decision,
      note: 'operator choice',
    }) as Record<string, unknown>;
    expect(payload).toMatchObject({
      recorded: true,
      proposal_kind: 'repair',
      proposal_id: proposal.proposal_id,
      decision,
      suppress_duplicates: true,
    });

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.repair_mutation_proposal).toMatchObject({
      decision,
      decision_note: 'operator choice',
      duplicates_suppressed: true,
    });
    expect(statusView.learning_summary).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: 'repair',
          decision,
          duplicates_suppressed: true,
        }),
      ]),
    });

    const manager = new StateManager(projectRoot);
    const state = manager.readState();
    state.run_id = 'run-decision-c';
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const { runDir, manifestPath } = createFailedFixture(projectRoot, 'run-decision-c');
    const result = await executeComputationManifest({
      projectRoot,
      runId: 'run-decision-c',
      runDir,
      manifestPath,
    });
    expect(result.status).toBe('failed');
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', 'run-decision-c', 'mutation_proposal_repair_v1.json'))).toBe(false);

    const ledger = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('"event_type":"proposal_suppressed"');
    expect(ledger).toContain(`"suppression_decision":"${decision}"`);
  });

  it('fails closed when proposal-decision proposal_id does not match the current proposal pointer', async () => {
    const projectRoot = makeTempProjectRoot();
    for (const runId of ['run-decision-x', 'run-decision-y']) {
      const manager = new StateManager(projectRoot);
      manager.ensureDirs();
      const state = manager.readState();
      state.run_id = runId;
      state.workflow_id = 'computation';
      state.run_status = 'running';
      state.gate_satisfied.A3 = 'A3-0001';
      manager.saveState(state);
      const { runDir, manifestPath } = createFailedFixture(projectRoot, runId);
      await executeComputationManifest({ projectRoot, runId, runDir, manifestPath });
    }
    await expect(handleOrchRunRecordProposalDecision({
      project_root: projectRoot,
      proposal_kind: 'repair',
      proposal_id: 'mp_wrong',
      decision: 'dismissed',
    })).rejects.toThrow(/proposal_id does not match/i);
  });

  it('emits a local skill proposal after repeated successful package-usage workflows and surfaces it via status/export', async () => {
    const projectRoot = makeTempProjectRoot();
    for (const runId of ['run-skill-a', 'run-skill-b']) {
      await prepareCompletedRun(projectRoot, runId);
    }

    const proposalPath = path.join(projectRoot, 'artifacts', 'runs', 'run-skill-b', 'skill_proposal_v2.json');
    expect(fs.existsSync(proposalPath)).toBe(true);
    const proposal = readJson<Record<string, unknown>>(proposalPath);
    expect(proposal).toMatchObject({
      proposal_type: 'new_skill',
      origin: 'agent_trace',
      gate_level: 'A1',
      status: 'pending_review',
      trigger: expect.objectContaining({
        pattern_kind: 'package_usage_pattern',
        package_names: ['julia:LoopTools', 'python:sympy'],
      }),
      action: expect.objectContaining({
        type: 'package_playbook',
      }),
    });
    expect((proposal.evidence_traces as unknown[]).length).toBeGreaterThanOrEqual(3);

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.skill_proposal).toMatchObject({
      proposal_type: 'new_skill',
      origin: 'agent_trace',
      gate_level: 'A1',
      status: 'pending_review',
      action: expect.objectContaining({ type: 'package_playbook' }),
    });
    expect(statusView.skill_proposal_error).toBeNull();

    const exportView = await handleOrchRunExport({
      project_root: projectRoot,
      _confirm: true,
      include_state: false,
      include_artifacts: true,
    }) as Record<string, unknown>;
    expect(exportView.current_run_skill_proposal).toMatchObject({
      proposal_type: 'new_skill',
      origin: 'agent_trace',
      gate_level: 'A1',
      status: 'pending_review',
    });
    expect(exportView.current_run_skill_proposal_error).toBeNull();
    expect(exportView.current_run_learning_summary).toMatchObject({
      proposal_count: 1,
      entries: [
        expect.objectContaining({
          kind: 'skill',
          summary: expect.stringContaining('package/workflow pattern'),
          pattern_kind: 'package_usage_pattern',
        }),
      ],
    });
  });

  it('emits local optimize/innovate mutation proposals after repeated successful workflows and surfaces them via status/export', async () => {
    const projectRoot = makeTempProjectRoot();
    for (const runId of ['run-opportunity-a', 'run-opportunity-b', 'run-opportunity-c', 'run-opportunity-d']) {
      await prepareCompletedRun(projectRoot, runId);
    }

    const optimizePath = path.join(projectRoot, 'artifacts', 'runs', 'run-opportunity-d', 'mutation_proposal_optimize_v1.json');
    const innovatePath = path.join(projectRoot, 'artifacts', 'runs', 'run-opportunity-d', 'mutation_proposal_innovate_v1.json');
    expect(fs.existsSync(optimizePath)).toBe(true);
    expect(fs.existsSync(innovatePath)).toBe(true);

    const optimize = readJson<Record<string, unknown>>(optimizePath);
    const innovate = readJson<Record<string, unknown>>(innovatePath);
    expect(optimize).toMatchObject({
      mutation_type: 'optimize',
      gate_level: 'A0',
      status: 'proposed',
      run_id: 'run-opportunity-d',
    });
    expect(innovate).toMatchObject({
      mutation_type: 'innovate',
      gate_level: 'A2',
      status: 'proposed',
      run_id: 'run-opportunity-d',
    });

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.optimize_mutation_proposal).toMatchObject({
      mutation_type: 'optimize',
      gate_level: 'A0',
      status: 'proposed',
    });
    expect(statusView.innovate_mutation_proposal).toMatchObject({
      mutation_type: 'innovate',
      gate_level: 'A2',
      status: 'proposed',
    });
    expect(statusView.optimize_mutation_proposal_error).toBeNull();
    expect(statusView.innovate_mutation_proposal_error).toBeNull();

    const exportView = await handleOrchRunExport({
      project_root: projectRoot,
      _confirm: true,
      include_state: false,
      include_artifacts: true,
    }) as Record<string, unknown>;
    expect(exportView.current_run_optimize_mutation_proposal).toMatchObject({
      mutation_type: 'optimize',
      gate_level: 'A0',
      status: 'proposed',
    });
    expect(exportView.current_run_innovate_mutation_proposal).toMatchObject({
      mutation_type: 'innovate',
      gate_level: 'A2',
      status: 'proposed',
    });
    expect(exportView.current_run_learning_summary).toMatchObject({
      proposal_count: 3,
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill',
          summary: expect.stringContaining('package/workflow pattern'),
        }),
        expect.objectContaining({
          kind: 'optimize',
          summary: expect.stringContaining('optimization opportunity'),
        }),
        expect.objectContaining({
          kind: 'innovate',
          summary: expect.stringContaining('innovation opportunity'),
        }),
      ]),
    });
  });

  it('adds a compact team summary when team state exists for the current run', async () => {
    const projectRoot = makeTempProjectRoot();
    const runId = 'run-team-summary';
    const { manager } = await prepareCompletedRun(projectRoot, runId);
    const teamState = createTeamExecutionState({
      workspace_id: `ws-${runId}`,
      coordination_policy: 'supervised_delegate',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-1',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: TEAM_PERMISSIONS,
    }, runId);
    teamState.delegate_assignments[0]!.status = 'running';
    teamState.checkpoints.push({
      checkpoint_id: 'cp-1',
      assignment_id: teamState.delegate_assignments[0]!.assignment_id,
      task_id: 'task-1',
      handoff_id: null,
      last_completed_step: null,
      resume_from: null,
      updated_at: new Date().toISOString(),
    });
    new TeamExecutionStateManager(projectRoot).save(teamState);

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.team_summary).toMatchObject({
      workspace_id: `ws-${runId}`,
      coordination_policy: 'supervised_delegate',
      active_assignment_count: 1,
      checkpoint_count: 1,
      active_assignments: [
        expect.objectContaining({
          task_id: 'task-1',
          task_kind: 'compute',
          status: 'running',
          delegate_id: 'delegate-1',
        }),
      ],
    });
    expect(statusView.team_summary_error).toBeNull();
  });

  it('returns a structured team summary error when delegated-team trace exists but team state is missing', async () => {
    const projectRoot = makeTempProjectRoot();
    const runId = 'run-team-missing';
    const { runDir } = await prepareCompletedRun(projectRoot, runId);
    const resultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    const result = readJson<Record<string, unknown>>(resultPath);
    const workspaceFeedback = result.workspace_feedback as Record<string, unknown>;
    const tasks = workspaceFeedback.tasks as Array<Record<string, unknown>>;
    tasks[0] = {
      ...tasks[0],
      metadata: {
        ...((tasks[0]?.metadata as Record<string, unknown> | undefined) ?? {}),
        team_execution: {
          assignment_id: 'assign-1',
          delegate_id: 'delegate-1',
          handoff_kind: 'compute',
        },
      },
    };
    result.workspace_feedback = workspaceFeedback;
    writeJson(resultPath, result);

    const statusView = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
    expect(statusView.team_summary).toBeNull();
    expect(statusView.team_summary_error).toMatchObject({
      code: 'TEAM_SUMMARY_MISSING',
    });
  });
});
