import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Post-rename durability-failure injection (codex stage-3 r4 blocking
// finding): writeBytesAtomicDurable renames the temp file BEFORE its final
// parent-directory fsync, so a failure there throws to the caller while the
// destination already holds the new bytes. The mock below reproduces exactly
// that observable contract — bytes landed, error thrown — for the FIRST
// write to a run_origin.json mirror; every other write (including the
// restoration write) behaves normally. Both mirror writers must restore the
// pre-existing legacy mirror in that commit-uncertain case rather than
// leaving it clobbered with no ledger event behind it.

const faultState = { armed: false, fired: false };

vi.mock('@nullius/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nullius/shared')>();
  return {
    ...actual,
    writeBytesAtomicDurable: (filePath: string, bytes: string): void => {
      actual.writeBytesAtomicDurable(filePath, bytes);
      if (faultState.armed && !faultState.fired && filePath.endsWith('run_origin.json')) {
        faultState.fired = true;
        throw new Error('injected post-rename durability failure');
      }
    },
  };
});

// Imported AFTER the mock so their module graphs resolve the mocked shared.
import { runTraceCommand } from '../src/cli-trace.js';
import { backfillRunOrigins } from '../src/trace-backfill.js';
import { readValidityLedger } from '../src/validity-ledger.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-fault-'));
  faultState.armed = false;
  faultState.fired = false;
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function initRepo(dir: string): void {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
}
function commitAt(dir: string, isoDate: string, fileName: string): string {
  fs.writeFileSync(path.join(dir, fileName), isoDate);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', fileName], {
    env: { ...process.env, GIT_COMMITTER_DATE: isoDate, GIT_AUTHOR_DATE: isoDate },
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

describe('mirror write failing AFTER the rename landed (commit-uncertain)', () => {
  it('stamp restores the legacy mirror and records run_dir_unwritable', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    const runDir = path.join(projectRoot, 'artifacts', 'runs', 'the-run');
    fs.mkdirSync(runDir, { recursive: true });
    const mirrorPath = path.join(runDir, 'run_origin.json');
    fs.writeFileSync(mirrorPath, '{"legacy":"mirror"}');
    faultState.armed = true;
    const out: string[] = [];
    runTraceCommand(projectRoot, {
      action: 'stamp', target: 'artifacts/runs/the-run', eventId: null,
      by: null, reason: null, scope: null, actor: 'test', deps: {},
    }, { cwd: projectRoot, stdout: (t: string) => { out.push(t); }, stderr: () => {} });
    expect(faultState.fired).toBe(true);
    // The clobbered destination was restored to the legacy bytes even though
    // the writer reported failure — the rename had already replaced them.
    expect(fs.readFileSync(mirrorPath, 'utf-8')).toBe('{"legacy":"mirror"}');
    // The ledger event honestly records the mirror as unwritable.
    const view = readValidityLedger(projectRoot);
    const run = view.runs.get('the-run');
    expect(run?.stamped).toBe(true);
    expect((run?.origin as unknown as Record<string, unknown>).run_dir_unwritable).toBe(true);
  });

  it('backfill restores the legacy mirror and records run_dir_unwritable', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    const runDir = path.join(projectRoot, 'artifacts', 'runs', '20260802T121530Z-m1-alpha-r1');
    fs.mkdirSync(runDir, { recursive: true });
    const mirrorPath = path.join(runDir, 'run_origin.json');
    fs.writeFileSync(mirrorPath, '{"legacy":"hand-made"}');
    faultState.armed = true;
    const result = backfillRunOrigins(projectRoot);
    expect(faultState.fired).toBe(true);
    expect(result.aligned).toBe(1);
    expect(fs.readFileSync(mirrorPath, 'utf-8')).toBe('{"legacy":"hand-made"}');
    const view = readValidityLedger(projectRoot);
    const run = view.runs.get('20260802T121530Z-m1-alpha-r1');
    expect(run?.stamped).toBe(true);
    expect((run?.origin as unknown as Record<string, unknown>).run_dir_unwritable).toBe(true);
  });
});
