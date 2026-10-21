import { describe, expect, it } from 'vitest';
import { _setAtomicWriteAuditHook } from '@nullius/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readWorkflowAcceptance, evaluateWorkflowAcceptance } from '../src/workflow-acceptance.js';
import { acceptanceFixture, receiptPath, sha256File } from './helpers/workflow-acceptance-fixture.js';

describe('workflow acceptance receipts', () => {
  it('distinguishes an unrequired workflow from a required check with no receipt, without spawning', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), { resolveChecks: () => [] }).status).toBe('not_required');
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps)).toMatchObject({
      status: 'missing', required_checks: ['fixture_evidence'], receipt: null,
    });
    expect(f.markerCount()).toBe(0);
  });

  it('executes a checker and persists a hash-bound receipt and state pointer', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    const view = evaluateWorkflowAcceptance(f.manager, f.deps);
    expect(view.status).toBe('passed');
    expect(view.identity?.plan_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(view.identity?.outputs_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.markerCount()).toBe(1);
    expect(view.receipt?.sha256).toBe(sha256File(receiptPath(f.root, view.receipt)));
    expect(f.manager.readState().workflow_acceptance).toEqual(view.receipt);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe('passed');
    expect(f.markerCount()).toBe(1);
  });

  it.each(['request', 'log', 'receipt'] as const)('does not accept evidence after a %s durability failure', artifact => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    const suffix = artifact === 'request' ? '.request.json' : artifact === 'log' ? '.log' : '/receipt.json';
    let injected = false;
    const restore = _setAtomicWriteAuditHook(event => {
      if (!injected && event.kind === 'rename' && event.to.includes('/workflow_acceptance/') && event.to.endsWith(suffix)) {
        injected = true;
        throw new Error('injected durability failure before parent directory sync');
      }
    });
    try {
      expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('unavailable');
    } finally {
      restore();
    }
    expect(injected).toBe(true);
    expect(f.markerCount()).toBe(artifact === 'request' ? 0 : 1);
    const state = f.manager.readState();
    expect(readWorkflowAcceptance(f.root, state, f.deps).status).not.toBe('passed');
    if (artifact === 'receipt') expect(state.workflow_acceptance).toBeUndefined();
  });

  it.each(['failed', 'incomplete', 'unavailable'] as const)('retains an actual checker %s result as nonpassing', status => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    f.setVerdict(status);
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe(status);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe(status);
    expect(f.markerCount()).toBe(1);
  });

  it.each(['pending', 'in_progress', 'skipped', 'failed'])('does not accept %s execution even if fixture evidence says passed', status => {
    const f = acceptanceFixture(status);
    if (status !== 'pending') f.seedCommittedOutput();
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).not.toBe('passed');
  });

  it('does not accept a completed plan with only a caller-authored output view', () => {
    const f = acceptanceFixture();
    const state = f.manager.readState();
    state.workflow_outputs.fixture_output = {
      step_id: 'step-1', tool: 'fixture_operation', runtime_status: 'completed', artifact_uri: null,
      additional_artifact_uris: [], summary_text: 'Caller authored success', reason_code: null,
      recoverable: false, payload: { value: 1 }, payload_truncated: false,
    };
    f.manager.saveState(state);
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).not.toBe('passed');
  });

  it('preserves immutable receipt history when changed evidence is checked again', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    const first = evaluateWorkflowAcceptance(f.manager, f.deps);
    const firstPath = receiptPath(f.root, first.receipt);
    const firstBytes = fs.readFileSync(firstPath);
    f.setVerdict('incomplete');
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe('stale');
    const second = evaluateWorkflowAcceptance(f.manager, f.deps);
    expect(second.status).toBe('incomplete');
    expect(receiptPath(f.root, second.receipt)).not.toBe(firstPath);
    expect(fs.readFileSync(firstPath)).toEqual(firstBytes);
    expect(f.markerCount()).toBe(2);
  });

  it.each(['changed', 'deleted'])('invalidates a nested declared evidence file when %s', action => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('passed');
    if (action === 'changed') f.setVerdict('failed');
    else fs.unlinkSync(f.evidencePath);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe('stale');
    expect(f.markerCount()).toBe(1);
  });

  it.each(['checker', 'dependency'])('invalidates a receipt after its %s source changes', source => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('passed');
    fs.appendFileSync(source === 'checker' ? f.checkerPath : f.auxiliaryPath, '\n# changed\n');
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe('stale');
    expect(f.markerCount()).toBe(1);
  });

  it('invalidates changed check requests and semantic plan input, but ignores lifecycle timestamps', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('passed');
    const lifecycle = f.manager.readState();
    const plan = lifecycle.plan as { updated_at: string; current_step_id?: string; steps: Array<{ status: string; execution: { params: Record<string, unknown> } }> };
    plan.updated_at = '2099-01-01T00:00:00Z';
    plan.current_step_id = 'step-1';
    f.manager.saveState(lifecycle);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe('passed');
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), {
      ...f.deps, resolveChecks: () => [{ ...f.check, request: { ...f.check.request, contract: 'changed' } }],
    }).status).toBe('stale');
    plan.steps[0]!.execution.params.input = 2;
    f.manager.saveState(lifecycle);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).toBe('stale');
  });

  it('rejects receipt byte tampering even when the original pointer is retained', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    const view = evaluateWorkflowAcceptance(f.manager, f.deps);
    fs.appendFileSync(receiptPath(f.root, view.receipt), '\n');
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).not.toBe('passed');
    expect(f.markerCount()).toBe(1);
  });

  it('rejects a substituted receipt from another project despite its valid file hash', () => {
    const first = acceptanceFixture();
    first.seedCommittedOutput();
    const accepted = evaluateWorkflowAcceptance(first.manager, first.deps);
    const second = acceptanceFixture();
    second.seedCommittedOutput();
    const copiedPath = path.join(second.root, 'artifacts', 'runs', 'acceptance-run', 'workflow_acceptance', 'substitution', 'receipt.json');
    fs.mkdirSync(path.dirname(copiedPath), { recursive: true });
    fs.copyFileSync(receiptPath(first.root, accepted.receipt), copiedPath);
    const substituted = second.manager.readState();
    substituted.workflow_acceptance = { path: path.relative(second.root, copiedPath), sha256: sha256File(copiedPath) };
    expect(readWorkflowAcceptance(second.root, substituted, second.deps).status).toBe('stale');
    expect(second.markerCount()).toBe(0);
  });

  it('does not let a changed durable output or deleted journal retain acceptance', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('passed');
    const manifestPath = path.join(f.root, 'artifacts', 'runs', 'acceptance-run', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.checkpoints[0].outcome.json = { value: 2 };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).not.toBe('passed');
    fs.unlinkSync(manifestPath);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).not.toBe('passed');
  });

  it.each(['identity', 'exit', 'empty_inputs', 'contradictory_findings'])('refuses a checker protocol violation: %s', mode => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    let checker = fs.readFileSync(f.checkerPath, 'utf8');
    const mutation = mode === 'identity' ? "result['run_id'] = 'other-run'"
      : mode === 'empty_inputs' ? 'result["inputs"] = []'
      : mode === 'contradictory_findings' ? 'result["findings"] = ["unresolved evidence"]' : '';
    if (mutation) checker = checker.replace('pathlib.Path(a.output).write_text', mutation + '\npathlib.Path(a.output).write_text');
    else checker = checker.replace('sys.exit(0 if verdict', 'sys.exit(1)\nsys.exit(0 if verdict');
    fs.writeFileSync(f.checkerPath, checker);
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('unavailable');
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).not.toBe('passed');
  });

  it('records unavailable when the checker exceeds its bounded execution budget', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    fs.writeFileSync(f.checkerPath, 'import time\ntime.sleep(10)\n');
    expect(evaluateWorkflowAcceptance(f.manager, { ...f.deps, timeoutMs: 20 }).status).toBe('unavailable');
  });

  it('records an unavailable result when the required checker cannot run', () => {
    const f = acceptanceFixture();
    f.seedCommittedOutput();
    fs.unlinkSync(f.checkerPath);
    expect(evaluateWorkflowAcceptance(f.manager, f.deps).status).toBe('unavailable');
    expect(f.markerCount()).toBe(0);
  });
});
