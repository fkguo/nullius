import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/cli-run.js';
import { runWorkflowPlanCommand } from '../src/cli-workflow-plan.js';
import { readWorkflowAcceptance } from '../src/workflow-acceptance.js';
import { acceptanceFixture, receiptPath } from './helpers/workflow-acceptance-fixture.js';
import * as fs from 'node:fs';

describe('workflow CLI execution and acceptance', () => {
  it('reports execution completion separately from required acceptance failure', async () => {
    const f = acceptanceFixture('pending');
    f.setVerdict('incomplete');
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool: f.callTool }, workflowAcceptance: f.deps })).toBe(1);
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.manager.readState().run_status).toBe('completed');
    expect(JSON.parse(f.output.join(''))).toMatchObject({
      status: 'completed', ok: false, run_status: 'completed',
      workflow_acceptance: { status: 'incomplete' },
    });
  });

  it('rechecks a no-pending workflow without redispatching providers and retains receipt history', async () => {
    const f = acceptanceFixture('pending');
    f.setVerdict('incomplete');
    const deps = { workflowToolCaller: { callTool: f.callTool }, workflowAcceptance: f.deps };
    expect(await runCommand(f.input, f.io, deps)).toBe(1);
    const firstPointer = f.manager.readState().workflow_acceptance!;
    const firstBytes = fs.readFileSync(receiptPath(f.root, firstPointer));
    f.setVerdict('passed');
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, deps)).toBe(0);
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.markerCount()).toBe(2);
    expect(JSON.parse(f.output.join(''))).toMatchObject({
      status: 'completed', ok: true, workflow_acceptance: { status: 'passed' },
    });
    expect(fs.readFileSync(receiptPath(f.root, firstPointer))).toEqual(firstBytes);
    expect(f.manager.readState().workflow_acceptance?.path).not.toBe(firstPointer.path);
  });

  it('keeps normal success when the workflow has no required checks', async () => {
    const f = acceptanceFixture('pending');
    expect(await runCommand(f.input, f.io, {
      workflowToolCaller: { callTool: f.callTool }, workflowAcceptance: { resolveChecks: () => [] },
    })).toBe(0);
    expect(JSON.parse(f.output.join(''))).toMatchObject({ ok: true, workflow_acceptance: { status: 'not_required' } });
    expect(f.markerCount()).toBe(0);
  });

  it.each(['pending', 'completed'])('does not spawn checks or providers for dry-run with %s execution', async status => {
    const f = acceptanceFixture(status);
    if (status === 'completed') f.seedCommittedOutput();
    expect(await runCommand({ ...f.input, dryRun: true }, f.io, {
      workflowToolCaller: { callTool: f.callTool }, workflowAcceptance: f.deps,
    })).toBe(0);
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.markerCount()).toBe(0);
    expect(f.manager.readState().workflow_acceptance ?? null).toBeNull();
  });

  it.each(['skip_with_reason', 'partial_result'])('never grants acceptance to a %s workflow', async degradeMode => {
    const f = acceptanceFixture('pending');
    const state = f.manager.readState();
    const step = (state.plan as { steps: Array<{ execution: { degrade_mode: string } }> }).steps[0]!;
    step.execution.degrade_mode = degradeMode;
    f.manager.saveState(state);
    const callTool = async () => ({ ok: false, isError: true, rawText: 'fixture tool failed', json: null, errorCode: 'TOOL_ERROR' });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool }, workflowAcceptance: f.deps })).toBe(1);
    expect(readWorkflowAcceptance(f.root, f.manager.readState(), f.deps).status).not.toBe('passed');
  });

  it('clears the prior acceptance pointer when replacing a workflow plan', async () => {
    const f = acceptanceFixture('pending');
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool: f.callTool }, workflowAcceptance: f.deps })).toBe(0);
    expect(f.manager.readState().workflow_acceptance).toBeTruthy();
    await runWorkflowPlanCommand({
      projectRoot: f.root, recipeId: 'literature_landscape', phase: 'prework',
      inputs: { run_id: 'replacement-run', query: 'generic topic', topic: 'generic topic', seed_recid: '1234' },
      preferredProviders: [], allowedProviders: [], availableTools: [],
    }, f.io);
    expect(f.manager.readState().workflow_acceptance ?? null).toBeNull();
    expect(f.manager.readState().run_id).toBe('replacement-run');
    expect(f.markerCount()).toBe(1);
  });

  it('requires real literature evidence after a checked-in recipe executes successfully', async () => {
    const f = acceptanceFixture('pending');
    await runWorkflowPlanCommand({
      projectRoot: f.root, recipeId: 'literature_landscape', phase: 'prework',
      inputs: { run_id: 'literature-run', query: 'generic topic', topic: 'generic topic', seed_recid: '1234' },
      preferredProviders: [], allowedProviders: [], availableTools: [],
    }, f.io);
    f.output.length = 0;
    const code = await runCommand({ ...f.input, workflowId: 'literature_landscape', runId: 'literature-run' }, f.io, {
      workflowToolCaller: { callTool: f.callTool },
    });
    expect(f.callTool).toHaveBeenCalled();
    expect(f.manager.readState().run_status).toBe('completed');
    expect(code).toBe(1);
    const payload = JSON.parse(f.output.join(''));
    expect(payload).toMatchObject({ status: 'completed', ok: false });
    expect(payload.workflow_acceptance.required_checks.length).toBeGreaterThan(0);
    expect(['failed', 'incomplete', 'unavailable']).toContain(payload.workflow_acceptance.status);
  });
});
