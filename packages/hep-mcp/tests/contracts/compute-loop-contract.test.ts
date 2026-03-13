import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StateManager } from '@autoresearch/orchestrator';
import { createFromIdea } from '../../src/tools/create-from-idea.js';
import { handleToolCall } from '../../src/tools/index.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function makeHandoff(): Record<string, unknown> {
  return {
    campaign_id: '00000000-0000-0000-0000-000000000101',
    node_id: '00000000-0000-0000-0000-000000000102',
    idea_id: '00000000-0000-0000-0000-000000000103',
    promoted_at: '2026-03-13T00:00:00Z',
    idea_card: {
      thesis_statement: 'Minimal approved execution should lower back into the single-user substrate.',
      testable_hypotheses: ['Hypothesis A'],
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Execute the staged bridge task', method: 'generic execution', estimated_difficulty: 'low' },
      ],
      claims: [{ claim_text: 'Claim A', support_type: 'literature', evidence_uris: ['https://inspirehep.net/literature/1'] }],
    },
    grounding_audit: {
      status: 'pass',
      folklore_risk_score: 0.1,
      failures: [],
      timestamp: '2026-03-13T00:00:00Z',
    },
  };
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  delete process.env.HEP_DATA_DIR;
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('compute loop contract', () => {
  it('supports a single-user success path from staged idea to approved execution and finding follow-up', async () => {
    const hepDataDir = makeTmpDir('hep-compute-loop-');
    const projectRoot = makeTmpDir('orch-compute-loop-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());
    const staged = createFromIdea({ handoff_uri: handoffPath });

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), staged.run_id, 'computation');

    const planPayload = extractPayload(await handleToolCall(
      'hep_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, dry_run: false },
      'full',
    ));
    expect(planPayload.status).toBe('requires_approval');

    manager.approveRun(manager.readState(), String(planPayload.approval_id), 'approve for test');

    const execPayload = extractPayload(await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        manifest_path: String(planPayload.manifest_path),
      },
      'full',
    )) as {
      status: string;
      next_actions: Array<{ action_kind: string; task_kind: string }>;
    };

    expect(execPayload.status).toBe('completed');
    expect(execPayload.next_actions[0].action_kind).toBe('capture_finding');
    expect(execPayload.next_actions[0].task_kind).toBe('finding');

    const outcomePath = path.join(hepDataDir, 'runs', staged.run_id, 'artifacts', 'computation_result_v1.json');
    const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as {
      feedback_lowering: { signal: string; decision_kind: string };
      executor_provenance: { execution_surface: string };
      workspace_feedback: { tasks: Array<{ kind: string; status: string }> };
    };

    expect(outcome.feedback_lowering.signal).toBe('success');
    expect(outcome.feedback_lowering.decision_kind).toBe('capture_finding');
    expect(outcome.executor_provenance.execution_surface).toBe('computation_manifest_executor');
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'finding' && task.status === 'pending')).toBe(true);
  });

  it('surfaces deterministic feedback backtracks through the thin hep-mcp adapter when approved execution fails', async () => {
    const hepDataDir = makeTmpDir('hep-compute-loop-');
    const projectRoot = makeTmpDir('orch-compute-loop-');
    CLEANUP_DIRS.push(hepDataDir, projectRoot);
    process.env.HEP_DATA_DIR = hepDataDir;
    fs.mkdirSync(path.join(hepDataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(hepDataDir, 'runs'), { recursive: true });

    const handoffPath = path.join(hepDataDir, 'idea_handoff_c2_v1.json');
    writeJson(handoffPath, makeHandoff());
    const staged = createFromIdea({ handoff_uri: handoffPath });

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), staged.run_id, 'computation');

    const planPayload = extractPayload(await handleToolCall(
      'hep_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, dry_run: false },
      'full',
    ));
    fs.writeFileSync(
      path.join(hepDataDir, 'runs', staged.run_id, 'computation', 'scripts', 'execution_plan_runner.py'),
      "raise SystemExit(1)\n",
      'utf-8',
    );
    manager.approveRun(manager.readState(), String(planPayload.approval_id), 'approve for test');

    const execPayload = extractPayload(await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        manifest_path: String(planPayload.manifest_path),
      },
      'full',
    )) as {
      status: string;
      next_actions: Array<{ action_kind: string; task_kind: string; handoff_kind?: string }>;
    };

    expect(execPayload.status).toBe('failed');
    expect(execPayload.next_actions[0].action_kind).toBe('downgrade_idea');
    expect(execPayload.next_actions[0].task_kind).toBe('idea');
    expect(execPayload.next_actions[0].handoff_kind).toBe('feedback');

    const outcomePath = path.join(hepDataDir, 'runs', staged.run_id, 'artifacts', 'computation_result_v1.json');
    const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as {
      failure_reason?: string;
      feedback_lowering: { signal: string; decision_kind: string; prune_candidate: boolean };
      workspace_feedback: { handoffs: Array<{ handoff_kind: string }> };
    };

    expect(outcome.failure_reason).toContain("step 'task_001' exited with code 1");
    expect(outcome.feedback_lowering.signal).toBe('failure');
    expect(outcome.feedback_lowering.decision_kind).toBe('downgrade_idea');
    expect(outcome.feedback_lowering.prune_candidate).toBe(true);
    expect(outcome.workspace_feedback.handoffs[0]?.handoff_kind).toBe('feedback');
  });
});
