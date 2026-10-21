import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { WorkflowAcceptanceCheckSpec } from '@nullius/shared';
import { StateManager } from '../../src/state-manager.js';
import { createToolAttemptIdentity, RunManifestManager } from '../../src/run-manifest.js';
import { compileWorkflowRuntimeRequest, parsePersistedWorkflowExecution } from '../../src/workflow-runtime.js';
import type { RunCommandInput } from '../../src/cli-run.js';

/** Deterministic transport fixture; these verdicts test receipt binding, not science. */
export function acceptanceFixture(stepStatus = 'completed') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-acceptance-')));
  const runtimeRoot = path.join(root, 'checker-runtime');
  fs.mkdirSync(runtimeRoot);
  const evidencePath = path.join(root, 'nested', 'evidence.json');
  fs.mkdirSync(path.dirname(evidencePath));
  fs.writeFileSync(evidencePath, JSON.stringify({ verdict: 'passed' }));
  const markerPath = path.join(runtimeRoot, 'calls.jsonl');
  const checkerPath = path.join(runtimeRoot, 'check.py');
  fs.writeFileSync(checkerPath, `import argparse, hashlib, json, pathlib, sys
p = argparse.ArgumentParser()
p.add_argument('--request', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
r = json.loads(pathlib.Path(a.request).read_text())
with pathlib.Path(__file__).with_name('calls.jsonl').open('a') as marker:
    marker.write(json.dumps(r) + '\\n')
evidence = pathlib.Path(r['project_root']) / r['requirements']['evidence_path']
inputs = []
if evidence.is_file():
    data = evidence.read_bytes()
    verdict = json.loads(data)['verdict']
    inputs.append({'path': r['requirements']['evidence_path'], 'sha256': hashlib.sha256(data).hexdigest()})
else:
    verdict = 'incomplete'
result = {k: r[k] for k in ['schema_version', 'check_id', 'run_id', 'workflow_id', 'plan_sha256', 'outputs_sha256']}
result.update(status=verdict, summary='Fixture evidence: ' + verdict, findings=[] if verdict == 'passed' else ['Fixture evidence is not accepted'], inputs=inputs)
pathlib.Path(a.output).write_text(json.dumps(result))
sys.exit(0 if verdict == 'passed' else 2 if verdict == 'unavailable' else 1)
`);
  const auxiliaryPath = path.join(runtimeRoot, 'checker_dependency.py');
  fs.writeFileSync(auxiliaryPath, '# fixture source identity\n');
  const check: WorkflowAcceptanceCheckSpec = {
    id: 'fixture_evidence',
    checker_path: 'check.py',
    checker_sources: ['check.py', 'checker_dependency.py'],
    request: { evidence_path: 'nested/evidence.json', contract: 'exact fixture' },
  };
  const deps = { runtimeRoot, timeoutMs: 2_000, resolveChecks: () => [check] };
  const manager = new StateManager(root);
  manager.ensureDirs();
  const state = manager.readState();
  state.run_id = 'acceptance-run';
  state.workflow_id = 'fixture-workflow';
  state.run_status = stepStatus === 'completed' ? 'completed' : 'idle';
  state.plan = {
    schema_version: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    plan_id: 'fixture-plan', run_id: state.run_id, workflow_id: state.workflow_id,
    steps: [{
      step_id: 'step-1', description: 'Bounded fixture operation', status: stepStatus,
      expected_approvals: [], expected_outputs: ['fixture_output'], recovery_notes: '',
      execution: {
        action: null, tool: 'fixture_operation', provider: null,
        depends_on: [], params: { input: 1 }, required_capabilities: [],
        degrade_mode: 'fail_closed', consumer_hints: { artifact: 'fixture_output' },
      },
    }],
  };
  manager.saveState(state);
  const journal = new RunManifestManager(path.join(root, 'artifacts', 'runs'));
  const result = { ok: true, isError: false, rawText: '{"value":1}', json: { value: 1 }, errorCode: null };
  const seedCommittedOutput = () => {
    const current = manager.readState();
    const rawStep = (current.plan as { steps: Array<Record<string, unknown>> }).steps[0]!;
    const request = compileWorkflowRuntimeRequest({
      projectRoot: root, runId: current.run_id!, workflowId: current.workflow_id!,
      step: {
        step_id: String(rawStep.step_id), description: String(rawStep.description), status: String(rawStep.status),
        execution: parsePersistedWorkflowExecution(rawStep.execution),
      },
    });
    const attempt = createToolAttemptIdentity({ stepId: request.step_id, toolName: request.tool, input: request });
    journal.observeToolIntents(current.run_id!, [attempt]);
    journal.markToolIntentsDispatched(current.run_id!, [attempt]);
    journal.commitToolAttempt(current.run_id!, attempt, result);
  };
  const output: string[] = [];
  const input: RunCommandInput = {
    command: 'run', projectRoot: root, workflowId: state.workflow_id, runId: state.run_id,
    runDir: null, manifestPath: null, dryRun: false,
  };
  return {
    root, runtimeRoot, evidencePath, markerPath, checkerPath, auxiliaryPath,
    check, deps, manager, journal, seedCommittedOutput, input, output,
    io: { cwd: root, stdout: (text: string) => output.push(text), stderr: () => {} },
    callTool: vi.fn(async () => result),
    markerCount: () => fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim().split('\n').length : 0,
    setVerdict: (verdict: string) => fs.writeFileSync(evidencePath, JSON.stringify({ verdict })),
  };
}

export function sha256File(filename: string): string {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

export function receiptPath(root: string, receipt: { path: string } | null): string {
  if (!receipt) throw new Error('expected a persisted acceptance receipt');
  return path.resolve(root, receipt.path);
}
