import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';
import { handleOrchRunCreate } from '../src/orch-tools/create-status-list.js';
import { buildRunStatusView } from '../src/orch-tools/run-read-model.js';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mode-decisions-'));
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

async function initRuntimeOnly(projectRoot: string, extraArgs: string[] = []): Promise<string> {
  const { io, stdout } = makeIo(projectRoot);
  const code = await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only', ...extraArgs], io);
  expect(code).toBe(0);
  return stdout.join('');
}

function readLedgerEvents(projectRoot: string): Array<Record<string, unknown>> {
  const ledgerPath = path.join(projectRoot, '.nullius', 'ledger.jsonl');
  return fs.readFileSync(ledgerPath, 'utf-8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function readDecisionLines(projectRoot: string): Array<Record<string, unknown>> {
  const filePath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

async function statusJson(projectRoot: string): Promise<Record<string, unknown>> {
  const { io, stdout } = makeIo(projectRoot);
  const code = await runCli([`--project-root=${projectRoot}`, 'status', '--json'], io);
  expect(code).toBe(0);
  return JSON.parse(stdout.join('')) as Record<string, unknown>;
}

function driftIssues(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const drift = payload.project_surface_drift as { issues?: Array<Record<string, unknown>> } | null;
  return drift?.issues ?? [];
}

describe('execution mode declaration', () => {
  it('declares file mode on a fresh runtime-only init', async () => {
    const projectRoot = makeTempProjectRoot();
    const output = await initRuntimeOnly(projectRoot, ['--mode=file']);

    expect(output).toContain('[ok] execution mode declared: file');
    const state = new StateManager(projectRoot).readState();
    expect(state.execution_mode).toBe('file');
    const initialized = readLedgerEvents(projectRoot).find(event => event.event_type === 'initialized');
    expect(initialized?.details).toMatchObject({ execution_mode: 'file' });

    const payload = await statusJson(projectRoot);
    expect(payload.execution_mode).toBe('file');
  });

  it('leaves the mode undeclared without --mode and reports null in the receipt', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    const state = new StateManager(projectRoot).readState();
    expect(state.execution_mode ?? null).toBeNull();
    const payload = await statusJson(projectRoot);
    expect(payload.execution_mode).toBeNull();
    // Undeclared with no run evidence: no drift hint either.
    expect(driftIssues(payload).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
  });

  it('declares and re-declares the mode on an already-initialized root', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    const declared = await initRuntimeOnly(projectRoot, ['--mode', 'file']);
    expect(declared).toContain('[ok] execution mode declared: file');
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
    let modeEvents = readLedgerEvents(projectRoot).filter(event => event.event_type === 'execution_mode_declared');
    expect(modeEvents).toHaveLength(1);
    expect(modeEvents[0]?.details).toMatchObject({ execution_mode: 'file' });

    const repeated = await initRuntimeOnly(projectRoot, ['--mode=file']);
    expect(repeated).toContain('[ok] execution mode already declared: file');
    modeEvents = readLedgerEvents(projectRoot).filter(event => event.event_type === 'execution_mode_declared');
    expect(modeEvents).toHaveLength(1);

    const switched = await initRuntimeOnly(projectRoot, ['--mode=engine']);
    expect(switched).toContain('[ok] execution mode declared: engine');
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('engine');
  });

  it('rejects an invalid --mode value', async () => {
    const projectRoot = makeTempProjectRoot();
    const { io } = makeIo(projectRoot);
    await expect(
      runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only', '--mode=teamwork'], io),
    ).rejects.toThrow('invalid --mode value');
  });

  it('preserves a declared mode across run creation', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=file']);

    await handleOrchRunCreate({ project_root: projectRoot, run_id: 'M1' } as Parameters<typeof handleOrchRunCreate>[0]);
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
  });
});

describe('decision ledger', () => {
  it('records decisions and pending questions with sequential ids', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    const first = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Adopt the larger cutoff for the scattering length', '--by', 'FKG'], first.io)).toBe(0);
    expect(first.stdout.join('')).toContain('recorded: D1');

    const second = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'Freeze the bibliography before the next milestone?'], second.io)).toBe(0);
    expect(second.stdout.join('')).toContain('pending: D2');

    const lines = readDecisionLines(projectRoot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 'D1', kind: 'decided', by: 'FKG', resolves: null });
    expect(lines[1]).toMatchObject({ id: 'D2', kind: 'pending', by: 'user' });

    const eventTypes = readLedgerEvents(projectRoot).map(event => event.event_type);
    expect(eventTypes).toContain('decision_recorded');
    expect(eventTypes).toContain('decision_pending_recorded');
  });

  it('resolves a pending question and surfaces open items in the receipt', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'Which sign convention for the isospin projection?'], makeIo(projectRoot).io);

    let payload = await statusJson(projectRoot);
    let ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger).toMatchObject({ decided_count: 0, pending_count: 1, open_count: 1 });
    expect(ledger.open_items).toMatchObject([{ id: 'D1', text: 'Which sign convention for the isospin projection?' }]);

    const resolve = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Keep the convention as derived; audit closed', '--resolves', 'D1', '--by', 'FKG'], resolve.io)).toBe(0);
    expect(resolve.stdout.join('')).toContain('recorded: D2');
    expect(resolve.stdout.join('')).toContain('resolved: D1');

    payload = await statusJson(projectRoot);
    ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger).toMatchObject({ decided_count: 1, pending_count: 1, open_count: 0 });
    expect(ledger.latest_decided).toMatchObject({ id: 'D2', resolves: 'D1', by: 'FKG' });

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as Record<string, unknown>;
    expect(parsed.open_ids).toEqual([]);
    expect(Array.isArray(parsed.records) && parsed.records.length === 2).toBe(true);
  });

  it('rejects invalid resolve targets and empty text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'A standalone decision'], makeIo(projectRoot).io);

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', 'D99'], makeIo(projectRoot).io),
    ).rejects.toThrow('does not match any recorded decision id');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', 'D1'], makeIo(projectRoot).io),
    ).rejects.toThrow('points at a decided entry');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'x', '--resolves', 'D1'], makeIo(projectRoot).io),
    ).rejects.toThrow('--resolves is only valid with decision record');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', '   '], makeIo(projectRoot).io),
    ).rejects.toThrow('requires the text');
  });

  it('refuses to record into an uninitialized root', async () => {
    const projectRoot = makeTempProjectRoot();
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'too early'], makeIo(projectRoot).io),
    ).rejects.toThrow('not initialized');
  });

  it('tolerates invalid ledger lines without losing the valid ones', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'A valid decision'], makeIo(projectRoot).io);
    fs.appendFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), 'not json at all\n', 'utf-8');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    expect(parsed.invalid_lines).toBe(1);
    expect(parsed.records).toHaveLength(1);

    const payload = await statusJson(projectRoot);
    expect((payload.decision_ledger as Record<string, unknown>).invalid_lines).toBe(1);
  });

  it('renders mode and open decisions in the human status text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=file']);
    await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'Adopt the refit or keep the published couplings?'], makeIo(projectRoot).io);

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], io)).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('execution_mode: file');
    expect(text).toContain('decisions: 0 decided, 1 open');
    expect(text).toContain('[open] D1');
  });
});

describe('undeclared-mode drift hint', () => {
  it('hints when the engine stays frozen while dated run evidence accumulates', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', '20260701T090000Z-m1-scan-r1'), { recursive: true });

    const payload = await statusJson(projectRoot);
    const hint = driftIssues(payload).find(issue => issue.code === 'EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
    expect(hint).toBeDefined();
    expect(String(hint?.message)).toContain('nullius init --mode=file');
    expect(hint?.evidence).toMatchObject({
      dated_run_dirs_observed: 1,
      latest_run_dir: path.join('artifacts', 'runs', '20260701T090000Z-m1-scan-r1'),
      harness_milestone_executor: 'research-team',
      team_run_dirs_observed: 0,
    });
  });

  it('counts team runs in the evidence so a declared-but-never-run executor is visible', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'team', 'runs', '20260702T090000Z-m1-review-r1'), { recursive: true });

    const payload = await statusJson(projectRoot);
    const hint = driftIssues(payload).find(issue => issue.code === 'EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
    expect(hint?.evidence).toMatchObject({ team_run_dirs_observed: 1 });
  });

  it('stays silent once either mode is declared', async () => {
    for (const mode of ['file', 'engine'] as const) {
      const projectRoot = makeTempProjectRoot();
      await initRuntimeOnly(projectRoot, [`--mode=${mode}`]);
      fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', '20260701T090000Z-m1-scan-r1'), { recursive: true });

      const payload = await statusJson(projectRoot);
      expect(driftIssues(payload).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
    }
  });

  it('stays silent while the engine surface is in use', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', '20260701T090000Z-m1-scan-r1'), { recursive: true });
    const manager = new StateManager(projectRoot);
    const withRun = manager.readState() as RunState;
    withRun.run_id = 'M1';
    manager.saveState(withRun);

    let payload = await statusJson(projectRoot);
    expect(driftIssues(payload).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');

    // Approval history alone (run_id back to null) also counts as engine use.
    const withApproval = manager.readState() as RunState;
    withApproval.run_id = null;
    withApproval.approval_history = [
      { ts: '2026-07-01T00:00:00Z', approval_id: 'A1-0001', category: 'A1', decision: 'approved', note: '' },
    ];
    manager.saveState(withApproval);

    payload = await statusJson(projectRoot);
    expect(driftIssues(payload).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
  });
});

describe('file-mode recovery quieting', () => {
  function planFocusWarningCodes(payload: Record<string, unknown>): string[] {
    const recovery = payload.recovery_context as Record<string, unknown>;
    const warnings = Array.isArray(recovery.derivation_warnings) ? recovery.derivation_warnings : [];
    return warnings
      .filter((warning): warning is Record<string, unknown> => Boolean(warning) && typeof warning === 'object')
      .map(warning => String(warning.code));
  }

  it('drops the plan-focus warning in declared file mode and keeps it otherwise', async () => {
    const undeclaredRoot = makeTempProjectRoot();
    await initRuntimeOnly(undeclaredRoot);
    expect(planFocusWarningCodes(await statusJson(undeclaredRoot))).toContain('RECOVERY_PLAN_FOCUS_UNAVAILABLE');

    const fileModeRoot = makeTempProjectRoot();
    await initRuntimeOnly(fileModeRoot, ['--mode=file']);
    expect(planFocusWarningCodes(await statusJson(fileModeRoot))).not.toContain('RECOVERY_PLAN_FOCUS_UNAVAILABLE');
  });

  it('keeps mode and decision fields visible through buildRunStatusView for library callers', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=file']);
    await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Fold the verified pole position into the contract', '--by', 'FKG'], makeIo(projectRoot).io);

    const view = buildRunStatusView(projectRoot, new StateManager(projectRoot).readState()) as Record<string, unknown>;
    expect(view.execution_mode).toBe('file');
    expect((view.decision_ledger as Record<string, unknown>).decided_count).toBe(1);
    expect(view.decision_ledger_error).toBeNull();
  });
});
