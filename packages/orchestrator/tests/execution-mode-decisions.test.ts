import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { renderHelp } from '../src/cli-help.js';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';
import { handleOrchRunExport } from '../src/orch-tools/control.js';
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

  it('preserves the declared mode through an idempotency replay', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=file']);

    const params = { project_root: projectRoot, run_id: 'M1', idempotency_key: 'k1' } as Parameters<typeof handleOrchRunCreate>[0];
    await handleOrchRunCreate(params);
    const replay = await handleOrchRunCreate(params) as Record<string, unknown>;
    expect(replay.idempotency_replay).toBe(true);
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
  });

  it('rejects an inline --mode value with trailing garbage', async () => {
    const projectRoot = makeTempProjectRoot();
    await expect(
      runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only', '--mode=file=typo'], makeIo(projectRoot).io),
    ).rejects.toThrow('invalid --mode value');
  });

  it('appends the declaration event when --force re-init changes the mode', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=engine']);

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only', '--force', '--mode=file'], io)).toBe(0);
    expect(stdout.join('')).toContain('[ok] execution mode declared: file');
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
    const modeEvents = readLedgerEvents(projectRoot).filter(event => event.event_type === 'execution_mode_declared');
    // One from the engine->file change; the initial --mode=engine declaration
    // on the fresh init is carried by the 'initialized' event details instead.
    expect(modeEvents).toHaveLength(1);
    expect(modeEvents[0]?.details).toMatchObject({ execution_mode: 'file' });
  });

  it('previews but does not write the mode on --refresh --dry-run', async () => {
    const parentDir = makeTempProjectRoot();
    const projectRoot = path.join(parentDir, 'project-root');
    expect(await runCli([`--project-root=${projectRoot}`, 'init'], makeIo(parentDir).io)).toBe(0);

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--refresh', '--dry-run', '--mode=file'], io)).toBe(0);
    expect(stdout.join('')).toContain('[ok] would declare execution mode: file (--dry-run, not written)');
    expect(new StateManager(projectRoot).readState().execution_mode ?? null).toBeNull();

    const applied = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--refresh', '--mode=file'], applied.io)).toBe(0);
    expect(applied.stdout.join('')).toContain('[ok] execution mode declared: file');
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
  });

  it('declares the mode on a fresh full-scaffold init', async () => {
    const parentDir = makeTempProjectRoot();
    const projectRoot = path.join(parentDir, 'project-root');
    const { io, stdout } = makeIo(parentDir);

    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--mode=file'], io)).toBe(0);
    expect(stdout.join('')).toContain('[ok] execution mode declared: file');
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
    expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(true);
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

  it('repairs an unterminated tail line before appending', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A hand-added valid record whose final newline is missing: blind append
    // would concatenate and corrupt BOTH lines.
    const manual = { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'Manually added question', by: 'user', resolves: null };
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), JSON.stringify(manual), 'utf-8');

    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Recorded after the manual edit'], makeIo(projectRoot).io)).toBe(0);

    const lines = readDecisionLines(projectRoot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 'D1', kind: 'pending' });
    expect(lines[1]).toMatchObject({ id: 'D2', kind: 'decided' });

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    expect((JSON.parse(list.stdout.join('')) as { invalid_lines: number }).invalid_lines).toBe(0);
  });

  it('allocates distinct ids under concurrent recording processes', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

    const runOne = (text: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, `--project-root=${projectRoot}`, 'decision', 'record', text], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', code => resolve(code ?? -1));
    });
    const [first, second] = await Promise.all([runOne('Concurrent decision one'), runOne('Concurrent decision two')]);
    expect(first).toBe(0);
    expect(second).toBe(0);

    const lines = readDecisionLines(projectRoot);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map(line => line.id))).toEqual(new Set(['D1', 'D2']));
  }, 20000);

  it('treats unsafe manual ids as invalid lines and keeps allocation sane', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const huge = { id: 'D99999999999999999999', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'absurd id', by: 'user', resolves: null };
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), `${JSON.stringify(huge)}\n`, 'utf-8');

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Normal decision'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain('recorded: D1');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: Array<{ id: string }> };
    expect(parsed.invalid_lines).toBe(1);
    expect(parsed.records.map(record_ => record_.id)).toEqual(['D1']);
  });

  it('releases the append lock after a failed recording', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', 'D42'], makeIo(projectRoot).io),
    ).rejects.toThrow('does not match any recorded decision id');
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'decisions.jsonl.lock'))).toBe(false);

    const retry = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Recovered after the failed attempt'], retry.io)).toBe(0);
    expect(retry.stdout.join('')).toContain('recorded: D1');
  });

  it('refuses to allocate past the id-space ceiling instead of emitting an invisible record', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ceiling = { id: `D${Number.MAX_SAFE_INTEGER}`, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'ceiling id', by: 'user', resolves: null };
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), `${JSON.stringify(ceiling)}\n`, 'utf-8');

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'one past the ceiling'], makeIo(projectRoot).io),
    ).rejects.toThrow('decision id space exhausted');
    expect(readDecisionLines(projectRoot)).toHaveLength(1);
  });

  it('quarantines duplicate ids so resolution stays unambiguous', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const first = { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'first question', by: 'user', resolves: null };
    const duplicate = { id: 'D1', ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'unrelated question with a stolen id', by: 'user', resolves: null };
    fs.writeFileSync(
      path.join(projectRoot, '.nullius', 'decisions.jsonl'),
      `${JSON.stringify(first)}\n${JSON.stringify(duplicate)}\n`,
      'utf-8',
    );

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: Array<{ id: string; text: string }> };
    expect(parsed.invalid_lines).toBe(1);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.text).toBe('first question');

    // Resolving D1 targets exactly the surviving first occurrence.
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'answered', '--resolves', 'D1'], makeIo(projectRoot).io)).toBe(0);
    const payload = await statusJson(projectRoot);
    expect((payload.decision_ledger as Record<string, unknown>).open_count).toBe(0);
  });

  it('repairs the tail in place, preserving the ledger file mode', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const manual = { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'no trailing newline', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, JSON.stringify(manual), 'utf-8');
    fs.chmodSync(ledgerPath, 0o600);

    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'appended after repair'], makeIo(projectRoot).io)).toBe(0);
    expect(readDecisionLines(projectRoot)).toHaveLength(2);
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it('fails with a normal permission error on a read-only ledger instead of replacing it', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const manual = { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'read-only, no trailing newline', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, JSON.stringify(manual), 'utf-8');
    fs.chmodSync(ledgerPath, 0o444);
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'must not be written'], makeIo(projectRoot).io),
      ).rejects.toThrow(/EACCES|permission denied/);
      expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o444);
      expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(JSON.stringify(manual));
      expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }
  });

  it('fails closed on a leftover lock and recovers after quiescent repair', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A lock left behind by a crashed process (provably dead pid).
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const lockPath = path.join(projectRoot, '.nullius', 'decisions.jsonl.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid ?? 999999, ts: '2026-07-10T00:00:00Z' }), 'utf-8');

    // No automatic reclamation: the bounded wait expires and the error names
    // the lock file and the repair.
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'blocked by the stale lock'], makeIo(projectRoot).io),
    ).rejects.toThrow(/decisions ledger is locked \(.*decisions\.jsonl\.lock.*decision list --project-root .*remove that lock file and retry only if the entry is absent/s);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'))).toBe(false);

    // The documented repair: verify nothing is recording, remove, retry.
    fs.rmSync(lockPath);
    const retry = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'recorded after the repair'], retry.io)).toBe(0);
    expect(retry.stdout.join('')).toContain('recorded: D1');
  }, 20000);

  it('quarantines forward and replayed resolutions instead of closing later questions', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    // A decided entry resolving an id that does not exist yet (hand-written):
    // sequential semantics must quarantine it, not let it pre-close the id.
    const forward = { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'decided', text: 'answer to a question that does not exist yet', by: 'user', resolves: 'D2' };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(forward)}\n`, 'utf-8');

    const pendingIo = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'A brand-new question'], pendingIo.io)).toBe(0);
    // D1 exists as bytes, so allocation continues at D2 — and the quarantined
    // forward resolution must not close it.
    expect(pendingIo.stdout.join('')).toContain('pending: D2');
    const payload = await statusJson(projectRoot);
    const ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger.open_count).toBe(1);
    expect(ledger.open_items).toMatchObject([{ id: 'D2' }]);
    expect(ledger.invalid_lines).toBe(1);

    // A replayed resolution of an already-closed pending is quarantined too.
    const replayRoot = makeTempProjectRoot();
    await initRuntimeOnly(replayRoot);
    const lines = [
      { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'question', by: 'user', resolves: null },
      { id: 'D2', ts: '2026-07-10T00:00:01Z', kind: 'decided', text: 'first answer', by: 'user', resolves: 'D1' },
      { id: 'D3', ts: '2026-07-10T00:00:02Z', kind: 'decided', text: 'replayed answer', by: 'user', resolves: 'D1' },
    ];
    fs.writeFileSync(path.join(replayRoot, '.nullius', 'decisions.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
    const replayPayload = await statusJson(replayRoot);
    const replayLedger = replayPayload.decision_ledger as Record<string, unknown>;
    expect(replayLedger.invalid_lines).toBe(1);
    expect(replayLedger.decided_count).toBe(1);
  });

  it('reserves the id of a quarantined line so allocation never reuses it', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    // Valid canonical id, structurally invalid record (empty text).
    fs.writeFileSync(ledgerPath, `${JSON.stringify({ id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: '', by: 'user', resolves: null })}\n`, 'utf-8');

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'first CLI decision'], record.io)).toBe(0);
    // D1 exists as bytes (quarantined), so the CLI must continue at D2.
    expect(record.stdout.join('')).toContain('recorded: D2');
    const payload = await statusJson(projectRoot);
    expect((payload.decision_ledger as Record<string, unknown>).invalid_lines).toBe(1);
  });

  it('reserves the id visible on an unparseable crash tail', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    // A write interrupted mid-record: broken JSON, no trailing newline, but
    // the id bytes are visible and must be reserved.
    fs.writeFileSync(ledgerPath, '{"id":"D1","ts":', 'utf-8');

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'recorded after the crash tail'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain('recorded: D2');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: Array<{ id: string }> };
    expect(parsed.invalid_lines).toBe(1);
    expect(parsed.records.map(entry => entry.id)).toEqual(['D2']);
  });

  it('reserves every id candidate on duplicate-key lines', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    // A malformed tail carrying TWO id candidates, then a parseable record
    // with duplicate id keys (JSON.parse keeps the last): both lines are
    // quarantined and every visible id stays reserved.
    const duplicateKeyRecord = '{"id":"D3","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"duplicate keys","by":"user","resolves":null,"id":"D4"}';
    fs.writeFileSync(ledgerPath, `{"id":"D1","id":"D2","ts":\n${duplicateKeyRecord}\n`, 'utf-8');

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'continues past every candidate'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain('recorded: D5');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: Array<{ id: string }> };
    expect(parsed.invalid_lines).toBe(2);
    expect(parsed.records.map(entry => entry.id)).toEqual(['D5']);
  });

  it('decodes JSON escapes when hunting id candidates and ignores nested ids', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const lines = [
      // Duplicate id keys where the second is spelled with a JSON escape:
      // JSON.parse admits it as D2; the scanner sees both and quarantines.
      '{"id":"D1","\\u0069d":"D2","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"escaped duplicate key","by":"user","resolves":null}',
      // A crash tail whose id value is escaped: still reserved as D3.
      '{"id":"D\\u0033","ts":',
      // A malformed line whose only id is NESTED: not a record identity,
      // reserves nothing.
      '{"meta":{"id":"D99"},"ts":',
    ].join('\n') + '\n';
    fs.writeFileSync(ledgerPath, lines, 'utf-8');

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'allocated past the escapes'], record.io)).toBe(0);
    // D1..D3 reserved (escaped spellings included); D99 was nested, so the
    // next id is D4, not D100.
    expect(record.stdout.join('')).toContain('recorded: D4');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: Array<{ id: string }> };
    expect(parsed.invalid_lines).toBe(3);
    expect(parsed.records.map(entry => entry.id)).toEqual(['D4']);
  });

  it('quarantines records whose persisted authorship is not an explicit nonempty string', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const lines = [
      { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'by is false', by: false, resolves: null },
      { id: 'D2', ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'by is blank', by: '   ', resolves: null },
      { id: 'D3', ts: '2026-07-10T00:00:02Z', kind: 'pending', text: 'by is missing', resolves: null },
    ];
    fs.writeFileSync(ledgerPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    // Fabricating "user" for any of these would invent provenance.
    expect(parsed.invalid_lines).toBe(3);
    expect(parsed.records).toHaveLength(0);

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'clean record'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain('recorded: D4');
  });

  it('quarantines a non-ASCII-whitespace-only line instead of skipping it as blank', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    // A single 0xA0 byte (latin1 NBSP): lossy trimming would treat the line
    // as blank; fatal decoding must quarantine it.
    fs.writeFileSync(ledgerPath, Buffer.concat([Buffer.from([0xa0]), Buffer.from('\n', 'utf-8')]));

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    expect((JSON.parse(list.stdout.join('')) as { invalid_lines: number }).invalid_lines).toBe(1);
  });

  it('shell-quotes the project root in lock guidance and escapes control characters in rendering', async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "nullius d'ir-"));
    const projectRoot = path.join(parentDir, 'project root');
    fs.mkdirSync(projectRoot, { recursive: true });
    await initRuntimeOnly(projectRoot);

    // Lock guidance must stay copy-pasteable for a root with a space and an
    // apostrophe.
    const lockPath = path.join(projectRoot, '.nullius', 'decisions.jsonl.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, ts: '2026-07-10T00:00:00Z' }), 'utf-8');
    const expectedQuoted = `'${projectRoot.replaceAll("'", "'\\''")}'`;
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'blocked'], makeIo(projectRoot).io),
    ).rejects.toThrow(`decision list --project-root ${expectedQuoted}`);
    fs.rmSync(lockPath);

    // Control characters in recorded text must not forge extra receipt lines.
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'line one\nforged: looks-like-a-field\u001b[31m'], makeIo(projectRoot).io)).toBe(0);
    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], io)).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('line one\\nforged: looks-like-a-field\\u001b[31m');
    expect(text).not.toContain('line one\nforged');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(0);
    expect(list.stdout.join('')).toContain('\\nforged');
  }, 20000);

  it('quarantines lines with invalid or truncated UTF-8 instead of admitting mutated text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    // A record whose text contains a raw invalid byte (0xff): lossy decoding
    // would silently turn it into U+FFFD and admit the mutated decision.
    const head = Buffer.from('{"id":"D1","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"corrupted ', 'utf-8');
    const tail = Buffer.from('","by":"user","resolves":null}\n', 'utf-8');
    // A second line ending in a truncated multibyte sequence (first byte of a
    // two-byte UTF-8 character).
    const truncated = Buffer.concat([
      Buffer.from('{"id":"D2","ts":"2026-07-10T00:00:01Z","kind":"pending","text":"cut ', 'utf-8'),
      Buffer.from([0xc3]),
    ]);
    fs.writeFileSync(ledgerPath, Buffer.concat([head, Buffer.from([0xff]), tail, truncated]));

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    expect(parsed.invalid_lines).toBe(2);
    expect(parsed.records).toHaveLength(0);

    // Both quarantined ids stay reserved.
    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'clean text'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain('recorded: D3');
  });

  it('creates no state when the fresh-init audit event cannot be written', async () => {
    const projectRoot = makeTempProjectRoot();
    const controlDir = path.join(projectRoot, '.nullius');
    fs.mkdirSync(controlDir, { recursive: true });
    const ledgerPath = path.join(controlDir, 'ledger.jsonl');
    fs.writeFileSync(ledgerPath, '', 'utf-8');
    fs.chmodSync(ledgerPath, 0o444);
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only', '--mode=file'], makeIo(projectRoot).io),
      ).rejects.toThrow(/EACCES|permission denied/);
      // Event-before-state: the failed init left no state file, so the retry
      // is a clean fresh init whose audit trail is complete.
      expect(fs.existsSync(path.join(controlDir, 'state.json'))).toBe(false);
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }

    const retry = await initRuntimeOnly(projectRoot, ['--mode=file']);
    expect(retry).toContain('[ok] execution mode declared: file');
    const initialized = readLedgerEvents(projectRoot).find(event => event.event_type === 'initialized');
    expect(initialized?.details).toMatchObject({ execution_mode: 'file' });
  });

  it('rejects non-canonical ids and malformed resolves fields as invalid lines', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const lines = [
      // Leading-zero id: not canonical, cannot alias D1.
      { id: 'D01', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'leading zero id', by: 'user', resolves: null },
      // Pending entries must not carry resolves.
      { id: 'D1', ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'pending with resolves', by: 'user', resolves: 'D2' },
      // Malformed resolves value on a decided entry.
      { id: 'D2', ts: '2026-07-10T00:00:02Z', kind: 'decided', text: 'bad resolves', by: 'user', resolves: 'not-an-id' },
    ];
    fs.writeFileSync(ledgerPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf-8');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    expect(parsed.invalid_lines).toBe(3);
    expect(parsed.records).toHaveLength(0);

    // D1 and D2 were reserved by the quarantined lines; D01 was not an id.
    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'continues after the quarantine'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain('recorded: D3');
  });

  it('keeps the declared mode unchanged when the audit event cannot be written', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'ledger.jsonl');
    fs.chmodSync(ledgerPath, 0o444);
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only', '--mode=file'], makeIo(projectRoot).io),
      ).rejects.toThrow(/EACCES|permission denied/);
      // Event-before-state ordering: the failed declaration left no state change.
      expect(new StateManager(projectRoot).readState().execution_mode ?? null).toBeNull();
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }

    const retry = await initRuntimeOnly(projectRoot, ['--mode=file']);
    expect(retry).toContain('[ok] execution mode declared: file');
    expect(new StateManager(projectRoot).readState().execution_mode).toBe('file');
    expect(readLedgerEvents(projectRoot).filter(event => event.event_type === 'execution_mode_declared')).toHaveLength(1);
  });

  it('lists the invalid-line count even when no valid record exists', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), 'garbage\n', 'utf-8');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(0);
    const text = list.stdout.join('');
    expect(text).toContain('no decisions recorded');
    expect(text).toContain('invalid_lines: 1');
  });

  it('surfaces the semantic error before touching a read-only unterminated ledger', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const manual = { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'decided', text: 'a decided entry', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, JSON.stringify(manual), 'utf-8'); // no trailing LF
    fs.chmodSync(ledgerPath, 0o444);
    try {
      // Validation runs before any byte is written: the resolve error wins,
      // not EACCES, and the unterminated tail stays byte-identical.
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', 'D1'], makeIo(projectRoot).io),
      ).rejects.toThrow('points at a decided entry');
      expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(JSON.stringify(manual));
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }
  });

  it('renders a genuinely empty ledger and a ledger read error in the text status', async () => {
    const emptyRoot = makeTempProjectRoot();
    await initRuntimeOnly(emptyRoot);
    fs.writeFileSync(path.join(emptyRoot, '.nullius', 'decisions.jsonl'), '', 'utf-8');
    const empty = makeIo(emptyRoot);
    expect(await runCli([`--project-root=${emptyRoot}`, 'status'], empty.io)).toBe(0);
    expect(empty.stdout.join('')).toContain('decisions: 0 decided, 0 open');

    const errorRoot = makeTempProjectRoot();
    await initRuntimeOnly(errorRoot);
    // A directory at the ledger path makes the read model fail structurally.
    fs.mkdirSync(path.join(errorRoot, '.nullius', 'decisions.jsonl'));
    const broken = makeIo(errorRoot);
    expect(await runCli([`--project-root=${errorRoot}`, 'status'], broken.io)).toBe(0);
    expect(broken.stdout.join('')).toContain('decision_ledger_error');
  });

  it('derives the ledger path from the control-dir authority and requires state.json to record', async () => {
    // Overridden control dir: the ledger must follow it.
    const overriddenRoot = makeTempProjectRoot();
    const previous = process.env.NULLIUS_CONTROL_DIR;
    process.env.NULLIUS_CONTROL_DIR = 'ctl';
    try {
      await initRuntimeOnly(overriddenRoot);
      expect(await runCli([`--project-root=${overriddenRoot}`, 'decision', 'record', 'recorded under the override'], makeIo(overriddenRoot).io)).toBe(0);
      expect(fs.existsSync(path.join(overriddenRoot, 'ctl', 'decisions.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(overriddenRoot, '.nullius', 'decisions.jsonl'))).toBe(false);
      const receipt = await statusJson(overriddenRoot);
      expect((receipt.decision_ledger as Record<string, unknown>).path).toBe('ctl/decisions.jsonl');

      // The undeclared-mode hint must also name the overridden state path.
      const hintRoot = makeTempProjectRoot();
      await initRuntimeOnly(hintRoot);
      fs.mkdirSync(path.join(hintRoot, 'artifacts', 'runs', '20260701T090000Z-m1-scan-r1'), { recursive: true });
      const hint = driftIssues(await statusJson(hintRoot)).find(issue => issue.code === 'EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
      expect(hint?.path).toBe('ctl/state.json');
    } finally {
      if (previous === undefined) delete process.env.NULLIUS_CONTROL_DIR;
      else process.env.NULLIUS_CONTROL_DIR = previous;
    }

    // A bare control dir without state.json is not an initialized project.
    const bareRoot = makeTempProjectRoot();
    fs.mkdirSync(path.join(bareRoot, '.nullius'), { recursive: true });
    await expect(
      runCli([`--project-root=${bareRoot}`, 'decision', 'record', 'too early'], makeIo(bareRoot).io),
    ).rejects.toThrow('not initialized');
  });

  it('rejects resolving the same pending entry twice', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'A question with one answer'], makeIo(projectRoot).io);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'First answer', '--resolves', 'D1'], makeIo(projectRoot).io)).toBe(0);

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Second answer', '--resolves', 'D1'], makeIo(projectRoot).io),
    ).rejects.toThrow('already resolved');
  });

  it('reports truncation explicitly when more than ten items are open', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    for (let index = 1; index <= 12; index += 1) {
      expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', `Open question number ${index}`], makeIo(projectRoot).io)).toBe(0);
    }

    const payload = await statusJson(projectRoot);
    const ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger.open_count).toBe(12);
    expect((ledger.open_items as unknown[]).length).toBe(10);
    expect(ledger.open_items_omitted).toBe(2);

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], io)).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('decisions: 0 decided, 12 open');
    expect(text).toContain(`... and 2 more open (run: nullius decision list --project-root '${projectRoot}')`);
  }, 20000);

  it('keeps the decision recorded when the ledger mirror append fails', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = path.join(projectRoot, '.nullius', 'ledger.jsonl');
    fs.chmodSync(ledgerPath, 0o444);
    try {
      const { io, stdout, stderr } = makeIo(projectRoot);
      expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Recorded despite mirror failure'], io)).toBe(0);
      expect(stdout.join('')).toContain('recorded: D1');
      expect(stderr.join('')).toContain('ledger.jsonl mirror event failed');
      expect(readDecisionLines(projectRoot)).toHaveLength(1);
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }
  });

  it('lists actions in the decision command help', () => {
    const help = renderHelp('decision');
    expect(help).toContain('record "<what was decided>"');
    expect(help).toContain('pending "<open question>"');
    expect(help).toContain('list [--json]');
    expect(help).toContain('list reads permissively');
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

  it('stays silent when a pause sentinel or any engine-activity field is set', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', '20260701T090000Z-m1-scan-r1'), { recursive: true });
    const manager = new StateManager(projectRoot);

    // Pause sentinel: someone drove the engine, so "frozen" does not apply.
    const pausePath = path.join(projectRoot, '.pause');
    fs.writeFileSync(pausePath, '{}\n', 'utf-8');
    expect(driftIssues(await statusJson(projectRoot)).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
    fs.rmSync(pausePath);

    // Non-empty workflow_outputs.
    const withOutputs = manager.readState() as RunState;
    withOutputs.workflow_outputs = {
      step1: {
        step_id: 'step1',
        tool: 'demo',
        runtime_status: 'completed',
        artifact_uri: null,
        additional_artifact_uris: [],
        summary_text: 'done',
        reason_code: null,
        recoverable: false,
        payload: null,
        payload_truncated: false,
      },
    };
    manager.saveState(withOutputs);
    expect(driftIssues(await statusJson(projectRoot)).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');

    // Non-empty artifacts pointer map.
    const withArtifacts = manager.readState() as RunState;
    withArtifacts.workflow_outputs = {};
    withArtifacts.artifacts = { some_artifact: 'artifacts/runs/x/file.json' };
    manager.saveState(withArtifacts);
    expect(driftIssues(await statusJson(projectRoot)).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
  });

  it('does not assert frozen-at-init about a root whose state file is absent', async () => {
    const projectRoot = makeTempProjectRoot();
    fs.mkdirSync(path.join(projectRoot, '.nullius'), { recursive: true });
    const runDir = path.join(projectRoot, 'artifacts', 'runs', '20260701T090000Z-m1-scan-r1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'result.json'), '{}\n', 'utf-8');

    const exportView = await handleOrchRunExport({
      project_root: projectRoot,
      _confirm: true,
      include_state: true,
      include_artifacts: true,
    } as Parameters<typeof handleOrchRunExport>[0]) as Record<string, unknown>;
    expect(exportView.state_missing).toBe(true);
    const drift = exportView.project_surface_drift as { issues?: Array<Record<string, unknown>> } | null;
    expect((drift?.issues ?? []).map(issue => issue.code)).not.toContain('EXECUTION_MODE_UNDECLARED_LOOKS_FILE_MODE');
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

    const engineRoot = makeTempProjectRoot();
    await initRuntimeOnly(engineRoot, ['--mode=engine']);
    expect(planFocusWarningCodes(await statusJson(engineRoot))).toContain('RECOVERY_PLAN_FOCUS_UNAVAILABLE');

    const fileModeRoot = makeTempProjectRoot();
    await initRuntimeOnly(fileModeRoot, ['--mode=file']);
    expect(planFocusWarningCodes(await statusJson(fileModeRoot))).not.toContain('RECOVERY_PLAN_FOCUS_UNAVAILABLE');
  });

  it('renders undeclared mode and invalid ledger lines in the human status text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), 'garbage line\n', 'utf-8');

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], io)).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('execution_mode: undeclared');
    expect(text).toContain('decisions: 0 decided, 0 open');
    expect(text).toContain('decisions_invalid_lines: 1');
  });

  it('leaves engine state untouched by file mode and open decisions', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=file']);
    await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'Open question that must not gate anything'], makeIo(projectRoot).io);

    const payload = await statusJson(projectRoot);
    expect(payload.run_status).toBe('idle');
    expect(payload.pending_approval).toBeNull();
    const state = new StateManager(projectRoot).readState();
    expect(state.run_status).toBe('idle');
    expect(state.gate_satisfied).toEqual({});
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
