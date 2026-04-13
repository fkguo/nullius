import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall as handleOrchToolCall } from '@autoresearch/orchestrator';
import { createFromIdea } from '../../src/tools/create-from-idea.js';

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
    campaign_id: '11111111-1111-4111-8111-111111111111',
    node_id: '22222222-2222-4222-8222-222222222222',
    idea_id: '33333333-3333-4333-8333-333333333333',
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
    extractPayload(await handleOrchToolCall(
      'orch_run_create',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        workflow_id: 'computation',
      },
      'full',
    ));

    const runDir = staged.run_dir;

    const planPayload = extractPayload(await handleOrchToolCall(
      'orch_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, run_dir: runDir, dry_run: false },
      'full',
    ));
    expect(planPayload.status).toBe('requires_approval');

    extractPayload(await handleOrchToolCall(
      'orch_run_approve',
      {
        _confirm: true,
        project_root: projectRoot,
        approval_id: String(planPayload.approval_id),
        approval_packet_sha256: String(planPayload.approval_packet_sha256),
        note: 'approve for test',
      },
      'full',
    ));

    const execPayload = extractPayload(await handleOrchToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: runDir,
        manifest_path: String(planPayload.manifest_path),
      },
      'full',
    )) as {
      status: string;
      next_actions: Array<{ action_kind: string; task_kind: string }>;
      followup_bridge_refs: Array<{ uri: string }>;
    };

    expect(execPayload.status).toBe('completed');
    expect(execPayload.next_actions[0].action_kind).toBe('capture_finding');
    expect(execPayload.next_actions[0].task_kind).toBe('finding');
    expect(execPayload.followup_bridge_refs).toHaveLength(1);

    const outcomePath = path.join(hepDataDir, 'runs', staged.run_id, 'artifacts', 'computation_result_v1.json');
    const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as {
      feedback_lowering: { signal: string; decision_kind: string };
      executor_provenance: { execution_surface: string };
      followup_bridge_refs: Array<{ uri: string }>;
      workspace_feedback: { tasks: Array<{ kind: string; status: string }> };
    };

    expect(outcome.feedback_lowering.signal).toBe('success');
    expect(outcome.feedback_lowering.decision_kind).toBe('capture_finding');
    expect(outcome.executor_provenance.execution_surface).toBe('computation_manifest_executor');
    expect(outcome.followup_bridge_refs).toHaveLength(1);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'finding' && task.status === 'pending')).toBe(true);

    const writingBridgePath = path.join(hepDataDir, 'runs', staged.run_id, 'artifacts', 'writing_followup_bridge_v1.json');
    expect(fs.existsSync(writingBridgePath)).toBe(true);
    expect(execPayload.followup_bridge_refs[0]?.uri).toContain('writing_followup_bridge_v1.json');
    expect(outcome.followup_bridge_refs[0]?.uri).toContain('writing_followup_bridge_v1.json');
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
    extractPayload(await handleOrchToolCall(
      'orch_run_create',
      {
        project_root: projectRoot,
        run_id: staged.run_id,
        workflow_id: 'computation',
      },
      'full',
    ));

    const runDir = path.join(hepDataDir, 'runs', staged.run_id);

    const planPayload = extractPayload(await handleOrchToolCall(
      'orch_run_plan_computation',
      { project_root: projectRoot, run_id: staged.run_id, run_dir: runDir, dry_run: false },
      'full',
    ));
    fs.writeFileSync(
      path.join(hepDataDir, 'runs', staged.run_id, 'computation', 'scripts', 'hep_provider_runner.py'),
      "raise SystemExit(1)\n",
      'utf-8',
    );
    const approvalPacketSha = String(planPayload.approval_packet_sha256);
    extractPayload(await handleOrchToolCall(
      'orch_run_approve',
      {
        _confirm: true,
        project_root: projectRoot,
        approval_id: String(planPayload.approval_id),
        approval_packet_sha256: approvalPacketSha,
        note: 'approve for test',
      },
      'full',
    ));

    const execPayload = extractPayload(await handleOrchToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: runDir,
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

    const followupPayload = extractPayload(await handleOrchToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: staged.run_id,
        run_dir: runDir,
      },
      'full',
      {
        createMessage: async () => ({
          model: 'claude-test',
          content: { type: 'text', text: 'feedback acknowledged' },
          stopReason: 'endTurn',
        }),
        callTool: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
      },
    )) as {
      status: string;
      branch: string;
      task_kind?: string;
    };
    expect(followupPayload.status).toBe('launched');
    expect(followupPayload.branch).toBe('feedback');
    expect(followupPayload.task_kind).toBe('idea');
  });
});
