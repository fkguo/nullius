import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleToolCall } from '../src/tooling.js';
import { ORCH_TOOL_SPECS } from '../src/orch-tools/index.js';
import { OrchRunPlanComputationSchema } from '../src/orch-tools/schemas.js';

type Payload = Record<string, unknown>;
type ExecutionPayload = Payload & {
  next_actions: Array<{ action_kind: string; task_kind: string; handoff_kind?: string }>;
  followup_bridge_refs: Array<{ uri: string }>;
};
type Outcome = {
  failure_reason?: string;
  feedback_lowering: { signal: string; decision_kind: string; prune_candidate: boolean } | null;
  executor_provenance: { execution_surface: string };
  followup_bridge_refs: Array<{ uri: string }>;
  workspace_feedback: { tasks: Array<{ kind: string; status: string }>; handoffs: Array<{ handoff_kind: string }> };
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const readJson = <T = Payload>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
async function call<T = Payload>(name: string, args: Payload, ctx?: Parameters<typeof handleToolCall>[3]): Promise<T> {
  const result = await handleToolCall(name, args, 'full', ctx);
  return JSON.parse(result.content[0]!.text) as T;
}
function fixture(fail: boolean | 'missing-output' = false, declaredFeedbackSignal?: 'success') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-computation-'));
  roots.push(root);
  const projectRoot = path.join(root, 'project');
  const runId = 'explicit-domain-operation';
  // The run's own directory.
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  fs.mkdirSync(projectRoot);
  const handoffPath = path.join(root, 'handoff.json');
  const handoffUri = pathToFileURL(handoffPath).href;
  const program = fail === 'missing-output' ? 'pass\n' : fail ? 'raise SystemExit(1)\n' : [
    'from pathlib import Path',
    'import json',
    "Path('outputs').mkdir(exist_ok=True)",
    "Path('outputs/value.txt').write_text(str(sum([2, 3])) + '\\n')",
    ...(declaredFeedbackSignal ? [
      `Path('outputs/research_feedback.json').write_text(json.dumps({'feedback_signal': '${declaredFeedbackSignal}'}) + '\\n')`,
    ] : []),
    '',
  ].join('\n');
  const handoff = {
    campaign_id: 'cccccc01', node_id: 'nnnnnn02', idea_id: 'dddddd03', promoted_at: '2026-03-13T00:00:00Z',
    grounding_audit: { status: 'pass', folklore_risk_score: 0.1, failures: [], timestamp: '2026-03-13T00:00:00Z' },
    idea_card: {
      thesis_statement: 'Execute an explicit operation supplied by the domain caller.',
      claims: [{ claim_text: 'The operation has a declared output.' }, { claim_text: 'The input is supplied explicitly.' }],
      testable_hypotheses: ['The declared sum equals five.', 'The declared output file is produced.'], required_observables: ['sum'],
      minimal_compute_plan: [{ step: 'Evaluate the sum', method: 'Python', estimated_difficulty: 'low' }],
      method_spec: {
        files: [{ path: 'scripts/evaluate.py', content: program }],
        run_card: {
          schema_version: 2, workflow_id: 'computation', title: 'Evaluate a supplied operation',
          phases: [{ phase_id: 'task_001', backend: { kind: 'shell', argv: ['python3', 'scripts/evaluate.py'], cwd: '.', timeout_seconds: 10 }, outputs: ['outputs/value.txt', ...(declaredFeedbackSignal ? ['outputs/research_feedback.json'] : [])] }],
        },
      },
    },
  };
  writeJson(handoffPath, handoff);
  return { root, projectRoot, runDir, runId, handoffPath, handoffUri, handoff };
}
type Fixture = ReturnType<typeof fixture>;
async function stage(f: Fixture) {
  return call('orch_run_stage_idea', { project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, handoff_path: f.handoffPath, handoff_uri: f.handoffUri });
}
async function create(f: Fixture) {
  expect((await call('orch_run_create', { project_root: f.projectRoot, run_id: f.runId, workflow_id: 'computation' })).run_id).toBe(f.runId);
  writeJson(path.join(f.projectRoot, '.nullius', 'approval_policy.json'), { require_approval_for: { compute_runs: true } });
}
async function plan(f: Fixture, dryRun = false) {
  return call('orch_run_plan_computation', { project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, dry_run: dryRun });
}
async function approveAndExecute(f: Fixture, p: Payload): Promise<ExecutionPayload> {
  await call('orch_run_approve', { _confirm: true, project_root: f.projectRoot, approval_id: p.approval_id, approval_packet_sha256: p.approval_packet_sha256, note: 'Approve the supplied operation.' });
  return call<ExecutionPayload>('orch_run_execute_manifest', { _confirm: true, project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, manifest_path: p.manifest_path });
}

describe('idea computation at the generic owner', () => {
  it('publishes the required executable method through tool and schema descriptions', () => {
    const tool = ORCH_TOOL_SPECS.find(spec => spec.name === 'orch_run_plan_computation');
    for (const description of [tool?.description, OrchRunPlanComputationSchema.shape.run_id.description]) {
      expect(description).toContain('requiring a supplied method_spec with files and run_card');
      expect(description).toContain('missing methods are refused before executable artifacts are written');
    }
  });

  it('stages into the run\'s own directory and preserves outline, hints and file-URI provenance', async () => {
    const f = fixture();
    const staged = await stage(f);
    expect(staged.status).toBe('staged');
    expect(staged.outline_seed_path).toBe('artifacts/outline_seed_v1.json');
    expect(staged.hints_snapshot_path).toBe('artifacts/idea_handoff_hints_v1.json');
    expect((staged.next_actions as Array<{ tool: string }>)[0]?.tool).toBe('orch_run_plan_computation');
    const seed = readJson(path.join(f.runDir, String(staged.outline_seed_path)));
    expect(seed).toMatchObject({ thesis: f.handoff.idea_card.thesis_statement, claims: f.handoff.idea_card.claims, hypotheses: f.handoff.idea_card.testable_hypotheses, source_handoff_uri: f.handoffUri });
    const hints = readJson(path.join(f.runDir, String(staged.hints_snapshot_path)));
    expect(hints).toMatchObject({ version: 1, source_handoff_uri: f.handoffUri, hints: { campaign_id: 'cccccc01', method_spec: f.handoff.idea_card.method_spec } });
    expect(fs.existsSync(path.join(f.projectRoot, '.nullius'))).toBe(false);
  });

  it('dry-runs the supplied operation without launching it and can plan from persisted hints', async () => {
    const f = fixture(); await stage(f); await create(f);
    fs.unlinkSync(f.handoffPath);
    const p = await plan(f, true);
    expect(p.status).toBe('dry_run');
    expect(p.execution_plan_path).toBe('computation/execution_plan_v1.json');
    expect(p.manifest_path).toBe('computation/manifest.json');
    expect(p.task_ids).toEqual(['task_001']);
    expect(fs.existsSync(path.join(f.runDir, 'computation/outputs/value.txt'))).toBe(false);
  });

  it('rejects mismatched staged provenance before creating computation artifacts', async () => {
    const f = fixture(); await stage(f); await create(f);
    const hintsFile = path.join(f.runDir, 'artifacts/idea_handoff_hints_v1.json');
    writeJson(hintsFile, { ...readJson(hintsFile), source_handoff_uri: 'file:///different-input.json' });
    const p = await plan(f, true);
    expect(JSON.stringify(p)).toContain('source_handoff_uri does not match outline_seed_v1.json provenance');
    expect(fs.existsSync(path.join(f.runDir, 'computation'))).toBe(false);
  });

  it.each(['missing', 'invalid'])('refuses a %s handoff before staging any run artifacts', async (kind) => {
    const f = fixture();
    if (kind === 'missing') fs.unlinkSync(f.handoffPath);
    else writeJson(f.handoffPath, { ...f.handoff, idea_card: {} });
    const result = await handleToolCall('orch_run_stage_idea', { project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, handoff_path: f.handoffPath }, 'full');
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(f.runDir, 'artifacts'))).toBe(false);
    expect(fs.existsSync(path.join(f.projectRoot, '.nullius'))).toBe(false);
  });

  it('refuses a method-less handoff before generating executable or completion artifacts', async () => {
    const f = fixture();
    delete (f.handoff.idea_card as { method_spec?: unknown }).method_spec;
    writeJson(f.handoffPath, f.handoff);
    await stage(f); await create(f);
    const before = fs.readFileSync(path.join(f.projectRoot, '.nullius/state.json'));
    for (const dryRun of [true, false]) {
      const result = await handleToolCall('orch_run_plan_computation', { project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, dry_run: dryRun }, 'full');
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('method_spec with files and run_card is required');
      expect(fs.existsSync(path.join(f.runDir, 'computation'))).toBe(false);
      expect(fs.existsSync(path.join(f.runDir, 'artifacts/computation_result_v1.json'))).toBe(false);
      expect(fs.readFileSync(path.join(f.projectRoot, '.nullius/state.json'))).toEqual(before);
      expect(fs.existsSync(path.join(f.projectRoot, 'artifacts/runs', f.runId, 'approvals'))).toBe(false);
    }
  });

  it('requires bound A3 approval and records real execution without an undeclared finding', async () => {
    const f = fixture(); await stage(f); await create(f);
    const p = await plan(f);
    expect(p.status).toBe('requires_approval');
    expect(p.gate_id).toBe('A3');
    const manifest = readJson<{ entry_point: { script: string }; description: string }>(path.join(f.runDir, String(p.manifest_path)));
    expect(manifest.entry_point.script).toBe('scripts/evaluate.py');
    expect(manifest.description).toContain('Provider-backed execution materialized from staged method_spec.run_card');
    const packet = readJson<{ details_md: string }>(path.join(f.projectRoot, String(p.packet_json_path)));
    expect(packet.details_md).toContain('Bridge objective');
    expect(packet.details_md).toContain('Execution plan tasks:');
    const unapproved = await call('orch_run_execute_manifest', { _confirm: true, project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, manifest_path: p.manifest_path });
    expect(unapproved.status).toBe('requires_approval');
    expect(fs.existsSync(path.join(f.runDir, 'computation/outputs/value.txt'))).toBe(false);
    const result = await approveAndExecute(f, p);
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(path.join(f.runDir, 'computation/outputs/value.txt'), 'utf8')).toBe('5\n');
    expect(result.next_actions).toEqual([]);
    expect(result.followup_bridge_refs).toEqual([]);
    const outcome = readJson<Outcome>(path.join(f.runDir, 'artifacts/computation_result_v1.json'));
    expect(outcome.feedback_lowering).toBeNull();
    expect(outcome.executor_provenance.execution_surface).toBe('computation_manifest_executor');
    expect(outcome.workspace_feedback.tasks).toHaveLength(1);
    expect(outcome.workspace_feedback.tasks[0]).toMatchObject({ kind: 'compute', status: 'completed' });
    expect(outcome.followup_bridge_refs).toEqual([]);
    const bridge = path.join(f.runDir, 'artifacts/writing_followup_bridge_v1.json');
    expect(fs.existsSync(bridge)).toBe(false);
  });

  it('reports a supplied program failure without treating it as negative scientific feedback', async () => {
    const f = fixture(true); await stage(f); await create(f);
    const p = await plan(f);
    expect(p.status).toBe('requires_approval');
    const result = await approveAndExecute(f, p);
    expect(result.status).toBe('failed');
    expect(result.next_actions).toEqual([]);
    expect(fs.existsSync(path.join(f.runDir, 'computation/outputs/value.txt'))).toBe(false);
    const outcome = readJson<Outcome>(path.join(f.runDir, 'artifacts/computation_result_v1.json'));
    expect(outcome.failure_reason).toContain("step 'task_001' exited with code 1");
    expect(outcome.feedback_lowering).toBeNull();
    expect(outcome.workspace_feedback.handoffs).toEqual([]);
    expect(outcome.workspace_feedback.tasks).toHaveLength(1);
    expect(outcome.workspace_feedback.tasks[0]).toMatchObject({ kind: 'compute', status: 'blocked' });
    const ctx = {
      createMessage: vi.fn(async () => ({ model: 'claude-test', content: { type: 'text' as const, text: 'feedback acknowledged' }, stopReason: 'endTurn' })),
      callTool: async () => ({ content: [{ type: 'text' as const, text: '{}' }], isError: false }),
    };
    const followup = await call('orch_run_progress_followups', { _confirm: true, project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir }, ctx);
    expect(followup).toMatchObject({ status: 'skipped_no_pending_task', branch: 'none' });
    expect(ctx.createMessage).not.toHaveBeenCalled();
  });

  it('fails when a successful process omits its declared output', async () => {
    const f = fixture('missing-output'); await stage(f); await create(f);
    const result = await approveAndExecute(f, await plan(f));
    expect(result.status).toBe('failed');
    expect(fs.existsSync(path.join(f.runDir, 'computation/outputs/value.txt'))).toBe(false);
    const outcome = readJson<Outcome>(path.join(f.runDir, 'artifacts/computation_result_v1.json'));
    expect(outcome.feedback_lowering).toBeNull();
    expect(result.next_actions).toEqual([]);
    expect(outcome.failure_reason).toContain("step 'task_001' did not produce expected outputs:");
  });

  it('keeps declared feedback writing/review bridge refs without attaching provider delegated-launch policy', async () => {
    const f = fixture(false, 'success'); await stage(f); await create(f);
    for (const [content_type, content] of [['section_output', 'existing draft seed'], ['reviewer_report', 'existing review seed']]) {
      await call('orch_run_stage_content', { project_root: f.projectRoot, run_id: f.runId, run_dir: f.runDir, content_type, content });
    }
    const result = await approveAndExecute(f, await plan(f));
    expect(result.status).toBe('completed');
    expect(result.next_actions[0]).toMatchObject({ action_kind: 'capture_finding', task_kind: 'finding' });
    expect(result.followup_bridge_refs).toHaveLength(2);
    expect(result).not.toHaveProperty('delegated_launch');
    expect(fs.readFileSync(path.join(f.runDir, 'computation/outputs/value.txt'), 'utf8')).toBe('5\n');
  });
});
