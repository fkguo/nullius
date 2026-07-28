import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { renderHelp } from '../src/cli-help.js';
import { readDecisionsLedger } from '../src/decisions-ledger.js';
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
  // The minted form, stated here independently of the module: ten Crockford
  // base32 characters of millisecond timestamp (the leading one carries the
  // two padding bits of a 48-bit count, hence 0-7) then sixteen random ones.
  // I, L, O, and U are absent from the alphabet and lowercase is not the
  // canonical spelling, so no id can be written two ways.
  const DECISION_ID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
  // A fixed instant for the tests that pin the clock.
  const FIXED_MS = 1785196800000;
  const FIXED_TS = '2026-07-28T00:00:00Z';

  /** A hand-written id in the minted form, for fixtures that need one. */
  function fixtureId(suffix: string, time = '01K3ZQJ5R0'): string {
    return `${time}${suffix.padStart(16, '0')}`;
  }
  const ID_A = fixtureId('1');
  const ID_B = fixtureId('2');
  const ID_C = fixtureId('3');
  const ID_D = fixtureId('4');

  /** The id the CLI just minted, checked against the canonical form. */
  function mintedId(stdout: string, label: 'recorded' | 'pending'): string {
    const match = new RegExp(`^${label}: (.+)$`, 'm').exec(stdout);
    expect(match, `no "${label}:" line in ${JSON.stringify(stdout)}`).not.toBeNull();
    const id = String(match?.[1] ?? '');
    expect(id).toMatch(DECISION_ID_PATTERN);
    return id;
  }

  /** Record one entry through the CLI and return its minted id. */
  async function recordDecision(
    projectRoot: string,
    action: 'record' | 'pending',
    text: string,
    extra: string[] = [],
  ): Promise<string> {
    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', action, text, ...extra], io)).toBe(0);
    return mintedId(stdout.join(''), action === 'record' ? 'recorded' : 'pending');
  }

  function ledgerFilePath(projectRoot: string): string {
    return path.join(projectRoot, '.nullius', 'decisions.jsonl');
  }

  function writeLedger(projectRoot: string, lines: Array<Record<string, unknown> | string>): void {
    const text = lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
    fs.writeFileSync(ledgerFilePath(projectRoot), `${text}\n`, 'utf-8');
  }

  it('mints ids in the canonical form and records both kinds', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    const decided = await recordDecision(projectRoot, 'record', 'Adopt the larger cutoff for the scattering length', ['--by', 'FKG']);
    const pending = await recordDecision(projectRoot, 'pending', 'Freeze the bibliography before the next milestone?');
    expect(decided).not.toBe(pending);

    const lines = readDecisionLines(projectRoot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: decided, kind: 'decided', by: 'FKG', resolves: null });
    expect(lines[1]).toMatchObject({ id: pending, kind: 'pending', by: 'user' });

    const eventTypes = readLedgerEvents(projectRoot).map(event => event.event_type);
    expect(eventTypes).toContain('decision_recorded');
    expect(eventTypes).toContain('decision_pending_recorded');
  });

  it('keeps ids distinct across two divergent copies of the tracked ledger', async () => {
    // `.nullius/decisions.jsonl` is version-controlled, so every branch works
    // on its own copy: two branches each recording one decision are both
    // appending "the next line" of the same ancestor file. An id derived from
    // a local scan gives both the same name, and the merge then holds two
    // different decisions called D38 with nothing reporting it.
    const ancestorRoot = makeTempProjectRoot();
    await initRuntimeOnly(ancestorRoot);
    const ancestorId = await recordDecision(ancestorRoot, 'pending', 'Question raised before the branches diverged');
    const ancestorLedger = fs.readFileSync(ledgerFilePath(ancestorRoot), 'utf-8');

    const branchRoots = [makeTempProjectRoot(), makeTempProjectRoot()];
    const branchIds: string[] = [];
    for (const [index, branchRoot] of branchRoots.entries()) {
      await initRuntimeOnly(branchRoot);
      // Each branch starts from the identical committed ledger.
      fs.writeFileSync(ledgerFilePath(branchRoot), ancestorLedger, 'utf-8');
      branchIds.push(await recordDecision(branchRoot, 'record', `Decision recorded on branch ${index + 1}`));
    }
    expect(branchIds[0]).not.toBe(branchIds[1]);

    // The merge: the shared ancestor line once, then each branch's own
    // appended tail — what a union merge of an append-only log yields, and
    // what a hand-resolved conflict keeping both sides yields too.
    const mergedRoot = makeTempProjectRoot();
    await initRuntimeOnly(mergedRoot);
    const branchTails = branchRoots.map(branchRoot =>
      fs.readFileSync(ledgerFilePath(branchRoot), 'utf-8').slice(ancestorLedger.length));
    fs.writeFileSync(ledgerFilePath(mergedRoot), ancestorLedger + branchTails.join(''), 'utf-8');

    const merged = readDecisionsLedger(mergedRoot);
    expect(merged.duplicate_ids).toEqual([]);
    expect(merged.invalid_lines).toBe(0);
    expect(merged.records.map(record => record.id)).toEqual([ancestorId, ...branchIds]);

    // Both branches' decisions survive the merge as distinct entries, and the
    // question carried across the divergence is still closable by name.
    const resolve = makeIo(mergedRoot);
    expect(await runCli([`--project-root=${mergedRoot}`, 'decision', 'record', 'Answered after the merge', '--resolves', ancestorId], resolve.io)).toBe(0);
    expect(resolve.stdout.join('')).toContain(`resolved: ${ancestorId}`);
    const payload = await statusJson(mergedRoot);
    expect(payload.decision_ledger).toMatchObject({ open_count: 0, decided_count: 3, duplicate_id_count: 0 });
  }, 20000);

  it('mints distinct ids for two roots recording in the same millisecond', async () => {
    // Uniqueness must not rest on the clock: two branches recording at the
    // same instant share the timestamp half of the id and are separated only
    // by the 80 random bits.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
    try {
      const ids: string[] = [];
      const roots = [makeTempProjectRoot(), makeTempProjectRoot()];
      for (const root of roots) {
        await initRuntimeOnly(root);
        ids.push(await recordDecision(root, 'record', 'Recorded at the very same instant'));
      }
      expect(ids[0]?.slice(0, 10)).toBe(ids[1]?.slice(0, 10));
      expect(ids[0]).not.toBe(ids[1]);
      // The record's ts comes from the same clock read as its id, so the two
      // never straddle a second boundary.
      expect(readDecisionLines(roots[0]!)[0]).toMatchObject({ ts: FIXED_TS });
    } finally {
      clock.mockRestore();
    }
  });

  it('orders minted ids lexicographically by recording millisecond', async () => {
    // Sorting a merged ledger by id has to reproduce chronological order to
    // the millisecond. Inside ONE millisecond the ids are unordered by
    // construction (the tail is random, not a sequence) — that is the honest
    // scope of the claim, and the reason every offset below is distinct.
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const clock = vi.spyOn(Date, 'now');
    const ids: string[] = [];
    try {
      for (const offset of [0, 1, 1000, 86_400_000]) {
        clock.mockReturnValue(FIXED_MS + offset);
        ids.push(await recordDecision(projectRoot, 'record', `Entry recorded ${offset} ms in`));
      }
    } finally {
      clock.mockRestore();
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  }, 20000);

  it('fails closed on a ledger carrying one id twice', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'first question', by: 'user', resolves: null },
      { id: ID_B, ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'an unrelated question', by: 'user', resolves: null },
      { id: ID_A, ts: '2026-07-10T00:00:02Z', kind: 'pending', text: 'a second question wearing the first id', by: 'user', resolves: null },
    ]);

    // list refuses to hand the ledger back as if it were sound.
    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(1);
    const listText = list.stdout.join('');
    expect(listText).toContain('duplicate_ids: 1 (one id, more than one entry in .nullius/decisions.jsonl)');
    expect(listText).toContain(`- "${ID_A}" on lines 1, 3`);
    expect(listText).toContain('repair: keep the first occurrence of each id, reissue every later one');

    const json = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], json.io)).toBe(1);
    const parsed = JSON.parse(json.stdout.join('')) as {
      duplicate_ids: Array<{ id: string; lines: number[] }>;
      invalid_lines: number;
      records: Array<{ id: string }>;
    };
    expect(parsed.duplicate_ids).toEqual([{ id: ID_A, lines: [1, 3] }]);
    // The later occurrence still stays out of the read model, so what the
    // command reports is unambiguous even while the file is not.
    expect(parsed.records.map(record => record.id)).toEqual([ID_A, ID_B]);
    expect(parsed.invalid_lines).toBe(1);

    // The receipt reports the same collision and gates nothing.
    const payload = await statusJson(projectRoot);
    const ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger.duplicate_id_count).toBe(1);
    expect(ledger.duplicate_ids).toEqual([{ id: ID_A, lines: [1, 3] }]);
    expect(ledger.duplicate_ids_omitted).toBe(0);
    const statusText = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], statusText.io)).toBe(0);
    expect(statusText.stdout.join('')).toContain('decisions_duplicate_ids: 1 (one id on more than one entry in .nullius/decisions.jsonl; --resolves cannot name one of them)');
    expect(statusText.stdout.join('')).toContain(`- "${ID_A}" on lines 1, 3`);

    // The operation the ledger exists to guarantee refuses the ambiguous name
    // instead of silently closing whichever entry the read model kept.
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'an answer', '--resolves', ID_A], makeIo(projectRoot).io),
    ).rejects.toThrow(`--resolves ${ID_A} is ambiguous: .nullius/decisions.jsonl carries that id on lines 1, 3`);

    // Only the ambiguous reference is refused: recording continues, and the
    // id that is NOT duplicated still resolves.
    const fresh = await recordDecision(projectRoot, 'record', 'An unrelated decision recorded anyway');
    expect(fresh).not.toBe(ID_A);
    const resolve = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'closing the unambiguous one', '--resolves', ID_B], resolve.io)).toBe(0);
    expect(resolve.stdout.join('')).toContain(`resolved: ${ID_B}`);
  }, 20000);

  it('reports collisions in a ledger written by the superseded counter', async () => {
    // What the local counter produced once two branches were merged: two
    // different decisions both named D38. Those ids are not in the minted
    // form, so their lines are quarantined — and the collision is still named
    // rather than disappearing into the invalid-line count.
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: 'D38', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'branch one question', by: 'user', resolves: null },
      // A blank line in between: reported line numbers are physical.
      '',
      { id: 'D38', ts: '2026-07-10T00:00:01Z', kind: 'decided', text: 'branch two decision', by: 'user', resolves: null },
    ]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(1);
    const parsed = JSON.parse(list.stdout.join('')) as {
      duplicate_ids: Array<{ id: string; lines: number[] }>;
      invalid_lines: number;
      records: unknown[];
    };
    expect(parsed.duplicate_ids).toEqual([{ id: 'D38', lines: [1, 3] }]);
    expect(parsed.invalid_lines).toBe(2);
    expect(parsed.records).toHaveLength(0);

    const ledger = (await statusJson(projectRoot)).decision_ledger as Record<string, unknown>;
    expect(ledger.duplicate_id_count).toBe(1);
    expect(ledger.invalid_lines).toBe(2);
  });

  it('resolves a pending question and surfaces open items in the receipt', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    const question = await recordDecision(projectRoot, 'pending', 'Which sign convention for the isospin projection?');

    let payload = await statusJson(projectRoot);
    let ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger).toMatchObject({ decided_count: 0, pending_count: 1, open_count: 1 });
    expect(ledger.open_items).toMatchObject([{ id: question, text: 'Which sign convention for the isospin projection?' }]);

    const resolve = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Keep the convention as derived; audit closed', '--resolves', question, '--by', 'FKG'], resolve.io)).toBe(0);
    const answer = mintedId(resolve.stdout.join(''), 'recorded');
    expect(resolve.stdout.join('')).toContain(`resolved: ${question}`);

    payload = await statusJson(projectRoot);
    ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger).toMatchObject({ decided_count: 1, pending_count: 1, open_count: 0 });
    expect(ledger.latest_decided).toMatchObject({ id: answer, resolves: question, by: 'FKG' });

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as Record<string, unknown>;
    expect(parsed.open_ids).toEqual([]);
    expect(Array.isArray(parsed.records) && parsed.records.length === 2).toBe(true);
  });

  it('rejects invalid resolve targets and empty text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const decided = await recordDecision(projectRoot, 'record', 'A standalone decision');

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', ID_A], makeIo(projectRoot).io),
    ).rejects.toThrow('does not match any recorded decision id');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', decided], makeIo(projectRoot).io),
    ).rejects.toThrow('points at a decided entry');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'x', '--resolves', decided], makeIo(projectRoot).io),
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
    await recordDecision(projectRoot, 'record', 'A valid decision');
    fs.appendFileSync(ledgerFilePath(projectRoot), 'not json at all\n', 'utf-8');

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
    const manual = { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'Manually added question', by: 'user', resolves: null };
    fs.writeFileSync(ledgerFilePath(projectRoot), JSON.stringify(manual), 'utf-8');

    const appended = await recordDecision(projectRoot, 'record', 'Recorded after the manual edit');

    const lines = readDecisionLines(projectRoot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: ID_A, kind: 'pending' });
    expect(lines[1]).toMatchObject({ id: appended, kind: 'decided' });

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
    const ids = lines.map(line => String(line.id));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(DECISION_ID_PATTERN);
    expect(readDecisionsLedger(projectRoot).duplicate_ids).toEqual([]);
  }, 20000);

  it('quarantines ids that are not in the minted form', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      // The superseded counter's form.
      { id: 'D42', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'counter id', by: 'user', resolves: null },
      // Lowercase: Crockford decoding is case-insensitive, so admitting it
      // would give one entry two spellings.
      { id: ID_A.toLowerCase(), ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'lowercase id', by: 'user', resolves: null },
      // Letters the alphabet excludes because they read as digits.
      { id: `${ID_A.slice(0, 25)}I`, ts: '2026-07-10T00:00:02Z', kind: 'pending', text: 'excluded letter', by: 'user', resolves: null },
      // Leading character past the timestamp's padding bits.
      { id: `8${ID_A.slice(1)}`, ts: '2026-07-10T00:00:03Z', kind: 'pending', text: 'timestamp overflow', by: 'user', resolves: null },
      // Too short.
      { id: ID_A.slice(0, 25), ts: '2026-07-10T00:00:04Z', kind: 'pending', text: 'truncated id', by: 'user', resolves: null },
    ]);

    const list = makeIo(projectRoot);
    // The counter-form id makes this ledger a migration case, so the read
    // command fails closed on it.
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(1);
    const parsed = JSON.parse(list.stdout.join('')) as {
      invalid_lines: number;
      records: unknown[];
      superseded_ids: Array<{ id: string; line: number }>;
    };
    expect(parsed.invalid_lines).toBe(5);
    expect(parsed.records).toHaveLength(0);
    // Only the counter form is a migration; the other four are simply not ids
    // this ledger issues, and must not be misreported as reissuable entries.
    expect(parsed.superseded_ids).toEqual([{ id: 'D42', line: 1, field: 'id' }]);

    // Recording still works, and the fresh id is none of the rejected ones.
    const fresh = await recordDecision(projectRoot, 'record', 'Normal decision');
    expect(readDecisionsLedger(projectRoot).reserved_ids).toContain(fresh);
  });

  it('releases the append lock after a failed recording', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', ID_A], makeIo(projectRoot).io),
    ).rejects.toThrow('does not match any recorded decision id');
    expect(fs.existsSync(`${ledgerFilePath(projectRoot)}.lock`)).toBe(false);

    await recordDecision(projectRoot, 'record', 'Recovered after the failed attempt');
  });

  it('refuses to mint from a clock the record could not state, at the exact boundary', async () => {
    // The bound that matters is the RECORD's, not the id encoding's: 48 bits
    // of milliseconds reach the year 10889, but from the year 10000 onward
    // toISOString writes the expanded-year form (+010000-01-01T00:00:00Z),
    // which the reader's four-digit-year pattern rejects. Minting anywhere in
    // that ~900-year gap would append an entry the very next read quarantines
    // while the command reports success.
    const lastRecordableMs = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

    for (const tooLate of [lastRecordableMs + 1, 2 ** 48 - 1, Number.MAX_SAFE_INTEGER]) {
      const projectRoot = makeTempProjectRoot();
      await initRuntimeOnly(projectRoot);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(tooLate);
      try {
        await expect(
          runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'recorded under a broken clock'], makeIo(projectRoot).io),
        ).rejects.toThrow('outside the range a decision entry can record');
      } finally {
        clock.mockRestore();
      }
      expect(fs.existsSync(ledgerFilePath(projectRoot))).toBe(false);
    }

    // The bound is at the right place, not merely somewhere safe: the last
    // recordable instant still records, and reads back cleanly.
    const boundaryRoot = makeTempProjectRoot();
    await initRuntimeOnly(boundaryRoot);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(lastRecordableMs);
    let boundaryId: string;
    try {
      boundaryId = await recordDecision(boundaryRoot, 'pending', 'recorded at the last representable instant');
    } finally {
      clock.mockRestore();
    }
    expect(readDecisionLines(boundaryRoot)[0]).toMatchObject({ id: boundaryId, ts: '9999-12-31T23:59:59Z' });
    const snapshot = readDecisionsLedger(boundaryRoot);
    expect(snapshot.invalid_lines).toBe(0);
    expect(snapshot.records.map(record => record.id)).toEqual([boundaryId]);
  }, 20000);

  it('names entries still numbered by the superseded counter instead of dropping them into a generic count', async () => {
    // The migration path deserves the same treatment as a merge collision:
    // these entries leave the read model entirely — including a question that
    // was still open — so a bare invalid-line count would reproduce exactly
    // the silence that makes a collision dangerous.
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: 'D1', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'a question still open when the numbering changed', by: 'FKG', resolves: null },
      { id: 'D2', ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'another open question', by: 'user', resolves: null },
      { id: 'D3', ts: '2026-07-10T00:00:02Z', kind: 'decided', text: 'an answer', by: 'user', resolves: 'D1' },
    ]);

    // Four places carry an old number: three ids, plus the resolution on line
    // 3 still naming D1.
    const expectedSuperseded = [
      { id: 'D1', line: 1, field: 'id' },
      { id: 'D2', line: 2, field: 'id' },
      { id: 'D3', line: 3, field: 'id' },
      { id: 'D1', line: 3, field: 'resolves' },
    ];

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(1);
    const listText = list.stdout.join('');
    expect(listText).toContain('superseded_ids: 4 (numbers from the retired D<n> counter in .nullius/decisions.jsonl; not listed above and not resolvable)');
    expect(listText).toContain('- "D1" on line 1');
    expect(listText).toContain('- "D3" on line 3');
    expect(listText).toContain('- "D1" on line 3 (resolves)');
    expect(listText).toContain('repair: reissue each entry with a fresh id');

    const json = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], json.io)).toBe(1);
    expect((JSON.parse(json.stdout.join('')) as { superseded_ids: unknown }).superseded_ids).toEqual(expectedSuperseded);

    const ledger = (await statusJson(projectRoot)).decision_ledger as Record<string, unknown>;
    expect(ledger.superseded_id_count).toBe(4);
    expect(ledger.superseded_ids).toEqual(expectedSuperseded);
    expect(ledger.superseded_ids_omitted).toBe(0);
    // The open questions are genuinely gone from the counts — which is why the
    // receipt has to say so in its own words.
    expect(ledger.open_count).toBe(0);
    // ...and it must say it exactly: these lines ARE inside the invalid-line
    // count printed just above, so an unqualified "not counted above" would
    // read as seven problem lines where there are three.
    expect(ledger.invalid_lines).toBe(3);

    const statusText = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], statusText.io)).toBe(0);
    const receipt = statusText.stdout.join('');
    expect(receipt).toContain('decisions_invalid_lines: 3');
    expect(receipt).toContain('decisions_superseded_ids: 4 (numbers from the retired D<n> counter in .nullius/decisions.jsonl; on lines already inside decisions_invalid_lines above, absent from the decided/open counts — reissue each entry, repoint each resolution)');
    expect(receipt).toContain('- "D1" on line 1');
    expect(receipt).toContain('- "D1" on line 3 (resolves)');
    expect(receipt).not.toContain('not counted above');
  }, 20000);

  it('claims only the form the superseded counter could actually have issued', async () => {
    // "Reissue this entry" is a diagnosis, and it must be true. The old
    // counter allocated D1, D2, ... as positive safe integers without leading
    // zeros — it never produced D0, D01, or a value past 2^53. Reporting those
    // as superseded entries would prescribe a migration for an unrelated
    // malformed line and fail `decision list` closed on a false cause.
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const stamp = (index: number) => `2026-07-10T00:00:0${index}Z`;
    writeLedger(projectRoot, [
      { id: 'D1', ts: stamp(0), kind: 'pending', text: 'genuinely from the counter', by: 'user', resolves: null },
      { id: 'D0', ts: stamp(1), kind: 'pending', text: 'the counter never issued zero', by: 'user', resolves: null },
      { id: 'D01', ts: stamp(2), kind: 'pending', text: 'nor a leading zero', by: 'user', resolves: null },
      { id: 'D9007199254740993', ts: stamp(3), kind: 'pending', text: 'nor past the safe-integer range', by: 'user', resolves: null },
      { id: 'D999999', ts: stamp(4), kind: 'pending', text: 'a large but reachable number', by: 'user', resolves: null },
      { id: 'd5', ts: stamp(5), kind: 'pending', text: 'lowercase is not the counter form', by: 'user', resolves: null },
    ]);

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.superseded_ids).toEqual([
      { id: 'D1', line: 1, field: 'id' },
      { id: 'D999999', line: 5, field: 'id' },
    ]);
    // The four rejected shapes are still quarantined — they are simply not a
    // migration, and stay in the generic count with every other bad id.
    expect(snapshot.invalid_lines).toBe(6);
    expect(snapshot.records).toHaveLength(0);
  });

  it('names a resolves still pointing at a superseded number', async () => {
    // The mid-migration state: the pending entries have been reissued with
    // fresh ids, but a decided entry still names the old number. Its id is
    // canonical, so nothing about the id says anything is wrong — the stale
    // number appears only in `resolves`, and without reporting it the line
    // falls into the generic invalid-line count with `decision list` exiting 0
    // on a ledger that has quietly lost a resolution.
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'reissued question', by: 'user', resolves: null },
      { id: ID_B, ts: '2026-07-10T00:00:01Z', kind: 'decided', text: 'answer still pointing at the old number', by: 'user', resolves: 'D1' },
    ]);

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.superseded_ids).toEqual([{ id: 'D1', line: 2, field: 'resolves' }]);
    // A resolution target is a reference, not an identity: it must not be
    // reserved, and must not count as an occurrence of an id.
    expect(snapshot.reserved_ids).toEqual([ID_A, ID_B]);
    expect(snapshot.duplicate_ids).toEqual([]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(1);
    expect(list.stdout.join('')).toContain('- "D1" on line 2 (resolves)');

    const ledger = (await statusJson(projectRoot)).decision_ledger as Record<string, unknown>;
    expect(ledger.superseded_id_count).toBe(1);
    expect(ledger.superseded_ids).toEqual([{ id: 'D1', line: 2, field: 'resolves' }]);

    // In THIS state the repair is repointing, not reissuing: the entry D1 named
    // was already reissued, which is why only the resolution still carries the
    // old number. A receipt saying "reissue them" prescribes something already
    // done, and following it leaves the line quarantined and the question open.
    // Every operator surface must therefore carry both halves.
    const statusText = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], statusText.io)).toBe(0);
    const receipt = statusText.stdout.join('');
    expect(receipt).toContain('reissue each entry, repoint each resolution');
    expect(receipt).not.toMatch(/— reissue them\)/);
    expect(list.stdout.join('')).toContain('repoint any resolves naming the old one');
    expect(renderHelp('decision')).toContain('until each entry is reissued and each resolution repointed');
  }, 20000);

  it('stays quiet about superseded ids on a healthy ledger', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    await recordDecision(projectRoot, 'pending', 'a question recorded under the current numbering');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(0);
    expect(list.stdout.join('')).not.toContain('superseded_ids');
    const ledger = (await statusJson(projectRoot)).decision_ledger as Record<string, unknown>;
    expect(ledger.superseded_id_count).toBe(0);
    expect(readDecisionsLedger(projectRoot).superseded_ids).toEqual([]);
  });

  it('quotes a duplicated id so an invisible one still points somewhere', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A hand-edited line can carry an empty or whitespace-only id; unquoted,
    // the repair instruction would name nothing at all.
    writeLedger(projectRoot, [
      { id: '', ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'blank id', by: 'user', resolves: null },
      { id: '', ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'blank id again', by: 'user', resolves: null },
    ]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(1);
    expect(list.stdout.join('')).toContain('- "" on lines 1, 2');
  });

  it('repairs the tail in place, preserving the ledger file mode', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = ledgerFilePath(projectRoot);
    const manual = { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'no trailing newline', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, JSON.stringify(manual), 'utf-8');
    fs.chmodSync(ledgerPath, 0o600);

    await recordDecision(projectRoot, 'record', 'appended after repair');
    expect(readDecisionLines(projectRoot)).toHaveLength(2);
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600);
  });

  it('fails with a normal permission error on a read-only ledger instead of replacing it', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = ledgerFilePath(projectRoot);
    const manual = { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'read-only, no trailing newline', by: 'user', resolves: null };
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
    const lockPath = `${ledgerFilePath(projectRoot)}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid ?? 999999, ts: '2026-07-10T00:00:00Z' }), 'utf-8');

    // No automatic reclamation: the bounded wait expires and the error names
    // the lock file and the repair.
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'blocked by the stale lock'], makeIo(projectRoot).io),
    ).rejects.toThrow(/decisions ledger is locked \(.*decisions\.jsonl\.lock.*decision list --project-root .*remove that lock file and retry only if the entry is absent/s);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(ledgerFilePath(projectRoot))).toBe(false);

    // The documented repair: verify nothing is recording, remove, retry.
    fs.rmSync(lockPath);
    await recordDecision(projectRoot, 'record', 'recorded after the repair');
  }, 20000);

  it('quarantines forward and replayed resolutions instead of closing later questions', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A decided entry resolving a pending entry that appears LATER in the
    // file: sequential semantics must quarantine it, not reach forward and
    // close a question that was still open at that point.
    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'decided', text: 'answer to a question recorded later', by: 'user', resolves: ID_B },
      { id: ID_B, ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'the question it claims to answer', by: 'user', resolves: null },
    ]);

    const payload = await statusJson(projectRoot);
    const ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger.invalid_lines).toBe(1);
    expect(ledger.open_count).toBe(1);
    expect(ledger.open_items).toMatchObject([{ id: ID_B }]);

    // A replayed resolution of an already-closed pending is quarantined too.
    const replayRoot = makeTempProjectRoot();
    await initRuntimeOnly(replayRoot);
    writeLedger(replayRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'question', by: 'user', resolves: null },
      { id: ID_B, ts: '2026-07-10T00:00:01Z', kind: 'decided', text: 'first answer', by: 'user', resolves: ID_A },
      { id: ID_C, ts: '2026-07-10T00:00:02Z', kind: 'decided', text: 'replayed answer', by: 'user', resolves: ID_A },
    ]);
    const replayLedger = (await statusJson(replayRoot)).decision_ledger as Record<string, unknown>;
    expect(replayLedger.invalid_lines).toBe(1);
    expect(replayLedger.decided_count).toBe(1);
  });

  it('reserves the id of a quarantined line so a later record cannot wear it', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // Valid canonical id, structurally invalid record (empty text), then a
    // well-formed record claiming the same id.
    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: '', by: 'user', resolves: null },
      { id: ID_A, ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'reusing the quarantined id', by: 'user', resolves: null },
    ]);

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.reserved_ids).toEqual([ID_A]);
    expect(snapshot.records).toHaveLength(0);
    expect(snapshot.invalid_lines).toBe(2);
    expect(snapshot.duplicate_ids).toEqual([{ id: ID_A, lines: [1, 2] }]);
  });

  it('reserves the id visible on an unparseable crash tail', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A write interrupted mid-record: broken JSON, no trailing newline, but
    // the id bytes are visible and must stay reserved.
    fs.writeFileSync(ledgerFilePath(projectRoot), `{"id":"${ID_A}","ts":`, 'utf-8');

    const appended = await recordDecision(projectRoot, 'record', 'recorded after the crash tail');
    expect(appended).not.toBe(ID_A);

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.reserved_ids).toEqual([ID_A, appended]);
    expect(snapshot.invalid_lines).toBe(1);
    expect(snapshot.records.map(record => record.id)).toEqual([appended]);
  });

  it('reserves every id candidate on duplicate-key lines', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A malformed tail carrying TWO id candidates, then a parseable record
    // with duplicate id keys (JSON.parse keeps the last): both lines are
    // quarantined and every visible id stays reserved.
    const duplicateKeyRecord = `{"id":"${ID_C}","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"duplicate keys","by":"user","resolves":null,"id":"${ID_D}"}`;
    fs.writeFileSync(ledgerFilePath(projectRoot), `{"id":"${ID_A}","id":"${ID_B}","ts":\n${duplicateKeyRecord}\n`, 'utf-8');

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.reserved_ids).toEqual([ID_A, ID_B, ID_C, ID_D]);
    expect(snapshot.invalid_lines).toBe(2);
    expect(snapshot.duplicate_ids).toEqual([]);
    expect(snapshot.records).toHaveLength(0);
  });

  it('decodes JSON escapes when hunting id candidates and ignores nested ids', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const escapedIdKey = `{"id":"${ID_A}","\\u0069d":"${ID_B}","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"escaped duplicate key","by":"user","resolves":null}`;
    // ID_C with its final character written as a JSON escape.
    const escapedIdValue = `{"id":"${ID_C.slice(0, -1)}\\u003${ID_C.slice(-1)}","ts":`;
    fs.writeFileSync(
      ledgerFilePath(projectRoot),
      [
        // Duplicate id keys where the second is spelled with a JSON escape:
        // JSON.parse admits it as ID_B; the scanner sees both and quarantines.
        escapedIdKey,
        // A crash tail whose id value is escaped: still reserved.
        escapedIdValue,
        // A malformed line whose only id is NESTED: not a record identity,
        // reserves nothing.
        `{"meta":{"id":"${ID_D}"},"ts":`,
      ].join('\n') + '\n',
      'utf-8',
    );

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.reserved_ids).toEqual([ID_A, ID_B, ID_C]);
    expect(snapshot.reserved_ids).not.toContain(ID_D);
    expect(snapshot.invalid_lines).toBe(3);
    expect(snapshot.records).toHaveLength(0);
  });

  it('quarantines duplicate load-bearing fields that JSON.parse would silently collapse', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    fs.writeFileSync(
      ledgerFilePath(projectRoot),
      [
        // Duplicate authorship: last-member-wins would smuggle "Mallory" past
        // the malformed-authorship quarantine.
        `{"id":"${ID_A}","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"dup by","by":false,"by":"Mallory","resolves":null}`,
        // An honest pending entry, then a resolver with DUPLICATE resolves
        // members: which pending it closes must not depend on member order.
        `{"id":"${ID_B}","ts":"2026-07-10T00:00:01Z","kind":"pending","text":"real question","by":"user","resolves":null}`,
        `{"id":"${ID_C}","ts":"2026-07-10T00:00:02Z","kind":"decided","text":"dup resolves","by":"user","resolves":"${ID_A}","resolves":"${ID_B}"}`,
      ].join('\n') + '\n',
      'utf-8',
    );

    const payload = await statusJson(projectRoot);
    const ledger = payload.decision_ledger as Record<string, unknown>;
    expect(ledger.invalid_lines).toBe(2);
    // ID_B stays open: the ambiguous resolver was quarantined, not applied.
    expect(ledger.open_count).toBe(1);
    expect(ledger.open_items).toMatchObject([{ id: ID_B }]);
    expect(readDecisionsLedger(projectRoot).reserved_ids).toEqual([ID_A, ID_B, ID_C]);
  });

  it('does not reserve ids that appear after a malformed token', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // Garbage scalar BEFORE an id: everything past the malformation is
    // unreadable, so the id it appears to carry is not this line's identity
    // and must not be reserved on its behalf.
    writeLedger(projectRoot, [
      `{"junk":bogus,"id":"${ID_A}"}`,
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'the real owner of this id', by: 'user', resolves: null },
    ]);

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.reserved_ids).toEqual([ID_A]);
    expect(snapshot.invalid_lines).toBe(1);
    // The valid record keeps its id: nothing earlier claimed it.
    expect(snapshot.records.map(record => record.id)).toEqual([ID_A]);
    expect(snapshot.duplicate_ids).toEqual([]);
  });

  it('does not reserve ids guarded by malformed nested containers', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // Balanced but INVALID nested containers before an id: balanced braces are
    // not valid contents, so the scan stops there too.
    writeLedger(projectRoot, [
      `{"junk":{"x":bogus},"id":"${ID_A}"}`,
      `{"junk":[1,bogus,2],"id":"${ID_B}"}`,
    ]);

    const snapshot = readDecisionsLedger(projectRoot);
    expect(snapshot.reserved_ids).toEqual([]);
    expect(snapshot.invalid_lines).toBe(2);
  });

  it('salvages ids only from the valid UTF-8 prefix of an undecodable line', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // Invalid byte BEFORE an id: everything after the encoding error is
    // unreadable garbage and must not reserve anything.
    fs.writeFileSync(ledgerFilePath(projectRoot), Buffer.concat([
      Buffer.from('{"note":"', 'utf-8'),
      Buffer.from([0xff]),
      Buffer.from(`","id":"${ID_A}"}\n`, 'utf-8'),
    ]));
    expect(readDecisionsLedger(projectRoot).reserved_ids).toEqual([]);

    // An id BEFORE the invalid byte stays reserved.
    const orderedRoot = makeTempProjectRoot();
    await initRuntimeOnly(orderedRoot);
    fs.writeFileSync(ledgerFilePath(orderedRoot), Buffer.concat([
      Buffer.from(`{"id":"${ID_A}","note":"`, 'utf-8'),
      Buffer.from([0xff]),
      Buffer.from('"}\n', 'utf-8'),
    ]));
    expect(readDecisionsLedger(orderedRoot).reserved_ids).toEqual([ID_A]);
  });

  it('quarantines malformed timestamps and whitespace-only text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: ID_A, ts: 'yesterday-ish', kind: 'pending', text: 'bad timestamp', by: 'user', resolves: null },
      { id: ID_B, ts: '2026-07-10T00:00:00+08:00', kind: 'pending', text: 'non-UTC offset', by: 'user', resolves: null },
      { id: ID_C, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: '   \t  ', by: 'user', resolves: null },
    ]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    expect(parsed.invalid_lines).toBe(3);
    expect(parsed.records).toHaveLength(0);

    await recordDecision(projectRoot, 'record', 'well-formed record');
  });

  it('handles a huge valid prefix before one invalid byte without stalling', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // 4 MiB of VALID bytes before the single invalid byte: a per-byte
    // streaming decode would grind through millions of decoder calls before
    // reaching the error, while the single-pass validator finishes in
    // milliseconds.
    const validPrefix = Buffer.alloc(4 * 1024 * 1024, 0x61);
    fs.writeFileSync(ledgerFilePath(projectRoot), Buffer.concat([
      Buffer.from(`{"id":"${ID_A}","note":"`, 'utf-8'),
      validPrefix,
      Buffer.from([0xff]),
      Buffer.from('\n', 'utf-8'),
    ]));

    // Deterministic discriminator instead of wall-clock: the single-pass
    // validator decodes at most a handful of times per line (one failed
    // whole-line attempt + one prefix decode), while a per-byte streaming
    // recovery would call decode millions of times for this prefix.
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const snapshot = readDecisionsLedger(projectRoot);
      expect(snapshot.invalid_lines).toBe(1);
      // The id sits in the valid prefix, so it stays reserved.
      expect(snapshot.reserved_ids).toEqual([ID_A]);
      expect(decodeSpy.mock.calls.length).toBeLessThan(10);
    } finally {
      decodeSpy.mockRestore();
    }
    await recordDecision(projectRoot, 'record', 'still responsive');
  });

  it('quarantines calendar-invalid timestamps that Date.parse would normalize', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-02-29T00:00:00Z', kind: 'pending', text: 'not a leap year', by: 'user', resolves: null },
      { id: ID_B, ts: '2026-04-31T00:00:00Z', kind: 'pending', text: 'April has 30 days', by: 'user', resolves: null },
      { id: ID_C, ts: '2026-07-10T24:00:00Z', kind: 'pending', text: 'hour 24', by: 'user', resolves: null },
      // A real leap day stays valid.
      { id: ID_D, ts: '2028-02-29T00:00:00Z', kind: 'pending', text: 'genuine leap day', by: 'user', resolves: null },
    ]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: Array<{ id: string }> };
    expect(parsed.invalid_lines).toBe(3);
    expect(parsed.records.map(entry => entry.id)).toEqual([ID_D]);
  });

  it('rejects U+0085-only text and authorship that trim would miss', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', '\u0085\u0085'], makeIo(projectRoot).io),
    ).rejects.toThrow('decision text must not be empty');
    // U+FEFF alone is caught one layer earlier (the arg parser's trim DOES
    // remove FEFF); mixed with U+0085 it reaches — and fails — the module
    // predicate. Both layers fail closed.
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', '\ufeff'], makeIo(projectRoot).io),
    ).rejects.toThrow('requires the text');
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', '\ufeff\u0085'], makeIo(projectRoot).io),
    ).rejects.toThrow('decision text must not be empty');
    // U+FEFF-only authorship is not a name: it falls back to the default
    // instead of being trimmed to an empty string that rereading would
    // quarantine (a durably recorded decision must never vanish).
    await recordDecision(projectRoot, 'record', 'real decision', ['--by', '\ufeff']);
    expect(readDecisionLines(projectRoot)[0]).toMatchObject({ by: 'user' });
    fs.rmSync(ledgerFilePath(projectRoot));

    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: '\u0085', by: 'user', resolves: null },
      { id: ID_B, ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'real question', by: '\u0085', resolves: null },
    ]);
    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    expect((JSON.parse(list.stdout.join('')) as { invalid_lines: number }).invalid_lines).toBe(2);
  });

  it('keeps the terminator from hijacking help detection or the project root', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    // "--help" after the terminator is decision text, not a help request.
    const helpText = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', '--', '--help'], helpText.io)).toBe(0);
    mintedId(helpText.stdout.join(''), 'recorded');
    expect(readDecisionLines(projectRoot)[0]).toMatchObject({ text: '--help' });

    // "--project-root=..." after the terminator is data, not a retarget.
    const otherRoot = makeTempProjectRoot();
    const retarget = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', '--', `--project-root=${otherRoot}`], retarget.io)).toBe(0);
    expect(readDecisionLines(projectRoot)).toHaveLength(2);
    expect(fs.existsSync(path.join(otherRoot, '.nullius', 'decisions.jsonl'))).toBe(false);

    // Two conflicting explicit roots are ambiguous authority, not last-wins.
    await expect(
      runCli([`--project-root=${projectRoot}`, 'status', `--project-root=${otherRoot}`], makeIo(projectRoot).io),
    ).rejects.toThrow('duplicate --project-root');
  });

  it("records the literal probe flag as decision text after the terminator", async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    // Only the exact one/two-argument probe forms are a handshake; a longer
    // argv ending in the flag is ordinary data.
    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', '--', '--launcher-protocol'], record.io)).toBe(0);
    mintedId(record.stdout.join(''), 'recorded');
    expect(readDecisionLines(projectRoot)[0]).toMatchObject({ text: '--launcher-protocol' });
  });

  it('records text beginning with a hyphen after the end-of-options terminator', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);

    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', '--by', 'FKG', '--', '-keep the negative branch'], record.io)).toBe(0);
    mintedId(record.stdout.join(''), 'recorded');
    expect(readDecisionLines(projectRoot)[0]).toMatchObject({ text: '-keep the negative branch', by: 'FKG' });

    // Without the terminator a leading-hyphen text still errors clearly.
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', '-not an option'], makeIo(projectRoot).io),
    ).rejects.toThrow('unknown decision argument');
  });

  it('quarantines records whose persisted authorship is not an explicit nonempty string', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'pending', text: 'by is false', by: false, resolves: null },
      { id: ID_B, ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'by is blank', by: '   ', resolves: null },
      { id: ID_C, ts: '2026-07-10T00:00:02Z', kind: 'pending', text: 'by is missing', resolves: null },
    ]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    // Fabricating "user" for any of these would invent provenance.
    expect(parsed.invalid_lines).toBe(3);
    expect(parsed.records).toHaveLength(0);

    await recordDecision(projectRoot, 'record', 'clean record');
  });

  it('quarantines a non-ASCII-whitespace-only line instead of skipping it as blank', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A single 0xA0 byte (latin1 NBSP): lossy trimming would treat the line
    // as blank; fatal decoding must quarantine it.
    fs.writeFileSync(ledgerFilePath(projectRoot), Buffer.concat([Buffer.from([0xa0]), Buffer.from('\n', 'utf-8')]));

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
    const lockPath = `${ledgerFilePath(projectRoot)}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, ts: '2026-07-10T00:00:00Z' }), 'utf-8');
    const expectedQuoted = `'${projectRoot.replaceAll("'", "'\\''")}'`;
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'blocked'], makeIo(projectRoot).io),
    ).rejects.toThrow(`decision list --project-root ${expectedQuoted}`);
    fs.rmSync(lockPath);

    // Control characters in recorded text must not forge extra receipt
    // lines: C0 (newline, ESC), DEL, C1 (NEL), and the JS line separator all
    // render as explicit escapes.
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'pending', 'line one\nforged: looks-like-a-field\u001b[31m del:\u007f c1:\u0085 ls:\u2028end'], makeIo(projectRoot).io)).toBe(0);
    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], io)).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('line one\\nforged: looks-like-a-field\\u001b[31m del:\\u007f c1:\\u0085 ls:\\u2028end');
    expect(text).not.toContain('line one\nforged');
    expect(text).not.toContain('\u0085');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(0);
    expect(list.stdout.join('')).toContain('\\nforged');
    expect(list.stdout.join('')).toContain('\\u0085');
  }, 20000);

  it('quarantines lines with invalid or truncated UTF-8 instead of admitting mutated text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // A record whose text contains a raw invalid byte (0xff): lossy decoding
    // would silently turn it into U+FFFD and admit the mutated decision.
    const head = Buffer.from(`{"id":"${ID_A}","ts":"2026-07-10T00:00:00Z","kind":"pending","text":"corrupted `, 'utf-8');
    const tail = Buffer.from('","by":"user","resolves":null}\n', 'utf-8');
    // A second line ending in a truncated multibyte sequence (first byte of a
    // two-byte UTF-8 character).
    const truncated = Buffer.concat([
      Buffer.from(`{"id":"${ID_B}","ts":"2026-07-10T00:00:01Z","kind":"pending","text":"cut `, 'utf-8'),
      Buffer.from([0xc3]),
    ]);
    fs.writeFileSync(ledgerFilePath(projectRoot), Buffer.concat([head, Buffer.from([0xff]), tail, truncated]));

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    expect(parsed.invalid_lines).toBe(2);
    expect(parsed.records).toHaveLength(0);

    // Both quarantined ids stay reserved.
    expect(readDecisionsLedger(projectRoot).reserved_ids).toEqual([ID_A, ID_B]);
    await recordDecision(projectRoot, 'record', 'clean text');
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

  it('rejects malformed resolves fields as invalid lines', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    writeLedger(projectRoot, [
      // Pending entries must not carry resolves.
      { id: ID_A, ts: '2026-07-10T00:00:01Z', kind: 'pending', text: 'pending with resolves', by: 'user', resolves: ID_B },
      // Malformed resolves value on a decided entry.
      { id: ID_B, ts: '2026-07-10T00:00:02Z', kind: 'decided', text: 'bad resolves', by: 'user', resolves: 'not-an-id' },
    ]);

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.stdout.join('')) as { invalid_lines: number; records: unknown[] };
    expect(parsed.invalid_lines).toBe(2);
    expect(parsed.records).toHaveLength(0);
    expect(readDecisionsLedger(projectRoot).reserved_ids).toEqual([ID_A, ID_B]);
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
    fs.writeFileSync(ledgerFilePath(projectRoot), 'garbage\n', 'utf-8');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(0);
    const text = list.stdout.join('');
    expect(text).toContain('no decisions recorded');
    expect(text).toContain('invalid_lines: 1');
  });

  it('reports duplicate ids even when no valid record survives', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    // Two quarantined lines wearing one id: the read model is empty, so the
    // collision would vanish entirely if only the records were reported.
    fs.writeFileSync(ledgerFilePath(projectRoot), `{"id":"${ID_A}","ts":\n{"id":"${ID_A}","ts":\n`, 'utf-8');

    const list = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'list'], list.io)).toBe(1);
    const text = list.stdout.join('');
    expect(text).toContain('no decisions recorded');
    expect(text).toContain(`- "${ID_A}" on lines 1, 2`);
  });

  it('surfaces the semantic error before touching a read-only unterminated ledger', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot);
    const ledgerPath = ledgerFilePath(projectRoot);
    const manual = { id: ID_A, ts: '2026-07-10T00:00:00Z', kind: 'decided', text: 'a decided entry', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, JSON.stringify(manual), 'utf-8'); // no trailing LF
    fs.chmodSync(ledgerPath, 0o444);
    try {
      // Validation runs before any byte is written: the resolve error wins,
      // not EACCES, and the unterminated tail stays byte-identical.
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'x', '--resolves', ID_A], makeIo(projectRoot).io),
      ).rejects.toThrow('points at a decided entry');
      expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(JSON.stringify(manual));
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }
  });

  it('renders a genuinely empty ledger and a ledger read error in the text status', async () => {
    const emptyRoot = makeTempProjectRoot();
    await initRuntimeOnly(emptyRoot);
    fs.writeFileSync(ledgerFilePath(emptyRoot), '', 'utf-8');
    const empty = makeIo(emptyRoot);
    expect(await runCli([`--project-root=${emptyRoot}`, 'status'], empty.io)).toBe(0);
    expect(empty.stdout.join('')).toContain('decisions: 0 decided, 0 open');

    const errorRoot = makeTempProjectRoot();
    await initRuntimeOnly(errorRoot);
    // A directory at the ledger path makes the read model fail structurally.
    fs.mkdirSync(ledgerFilePath(errorRoot));
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
    const question = await recordDecision(projectRoot, 'pending', 'A question with one answer');
    await recordDecision(projectRoot, 'record', 'First answer', ['--resolves', question]);

    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'Second answer', '--resolves', question], makeIo(projectRoot).io),
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
      mintedId(stdout.join(''), 'recorded');
      expect(stderr.join('')).toContain('ledger.jsonl mirror event failed');
      expect(readDecisionLines(projectRoot)).toHaveLength(1);
    } finally {
      fs.chmodSync(ledgerPath, 0o644);
    }
  });

  it('lists actions and the id contract in the decision command help', () => {
    const help = renderHelp('decision');
    expect(help).toContain('record "<what was decided>"');
    expect(help).toContain('pending "<open question>"');
    expect(help).toContain('list [--json]');
    expect(help).toContain('list reads permissively');
    // The superseded counter must not be advertised anywhere.
    expect(help).not.toContain('ids D1, D2');
    expect(help).toContain('chosen without coordination');
    expect(help).toContain('list exits non-zero and names the lines when the ledger carries an id twice');
    // Both halves of the migration must be advertised: an entry's own number
    // and a resolution still pointing at one.
    expect(help).toContain('from the superseded D<n> counter — an entry still numbered by it, or a resolution still');
    expect(help).toContain('until each entry is reissued and each resolution repointed');
    // The guarantee is probabilistic and must be stated WITH the condition
    // that bounds it. An absolute "cannot collide" is a false guarantee, and
    // so is a practical one ("no one will observe") — both would let a reader
    // conclude the duplicate check is redundant, which is exactly backwards.
    // Asserting the condition itself keeps a rewrite from dropping the scope
    // while leaving the reassuring half in place.
    expect(help).toContain('collide only if the same millisecond AND all 80 random bits coincide');
    expect(help).toContain('guarantee is probabilistic, not structural');
    expect(help).toContain('reported below rather than resolved silently');
    expect(help).not.toMatch(/cannot mint the same id|can never collide|guaranteed unique|no one will observe/);
    expect(help).toContain('Two ids minted inside one millisecond are unordered');
  });

  it('renders mode and open decisions in the human status text', async () => {
    const projectRoot = makeTempProjectRoot();
    await initRuntimeOnly(projectRoot, ['--mode=file']);
    const question = await recordDecision(projectRoot, 'pending', 'Adopt the refit or keep the published couplings?');

    const { io, stdout } = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'status'], io)).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('execution_mode: file');
    expect(text).toContain('decisions: 0 decided, 1 open');
    expect(text).toContain(`[open] ${question}`);
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
