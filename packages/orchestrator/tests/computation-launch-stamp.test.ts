import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { mintUlid } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import { executeComputationManifest } from '../src/computation/index.js';
import { runTraceCommand } from '../src/cli-trace.js';
import { mirrorRollbackAction } from '../src/run-stamp.js';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from '../src/validity-ledger.js';
import {
  cleanupRegisteredDirs,
  createManifest,
  createPythonStep,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
} from './executeManifestTestUtils.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

function initRepo(dir: string): void {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
}
function commitAll(dir: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'c']);
}

const OK_SCRIPT = "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.json').write_text('{\"ok\": true}\\n', encoding='utf-8')\n";

function stageComputation(runDir: string): string {
  createPythonStep(runDir, 'scripts/write_ok.py', OK_SCRIPT);
  return createManifest(runDir, {
    schema_version: 1,
    entry_point: { script: 'scripts/write_ok.py', tool: 'python' },
    steps: [
      {
        id: 'write_ok',
        tool: 'python',
        script: 'scripts/write_ok.py',
        expected_outputs: ['outputs/ok.json'],
      },
    ],
    environment: { python_version: '3.11', platform: 'any' },
    dependencies: {},
  });
}

function setupStampableRun(projectRoot: string, runId: string): { runDir: string; manifestPath: string } {
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = stageComputation(runDir);
  const manager = initRunState(projectRoot, runId);
  markA3Satisfied(manager, 'A3-0001');
  return { runDir, manifestPath };
}

function ledgerStampEvents(projectRoot: string, runId: string) {
  const view = readValidityLedger(projectRoot);
  return view.events.filter(event => event.event === 'stamp' && event.run_id === runId);
}

describe('computation front door launch stamp', () => {
  it('stamps the run at launch: origin_stamp in the result, mirror on disk, one ledger event', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-auto-stamp';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    commitAll(projectRoot);

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });

    expect(result.status).toBe('completed');
    const stamp = (result as { origin_stamp?: { status: string; binding_quality?: string; event_id?: string } }).origin_stamp;
    expect(stamp?.status).toBe('stamped');
    // The tree was committed clean at launch; state.json churn from run
    // bookkeeping may appear as a tracked snapshot — both grades are exact.
    expect(['exact_clean', 'exact_tracked_snapshot']).toContain(stamp?.binding_quality);
    const mirror = path.join(runDir, 'run_origin.json');
    expect(fs.existsSync(mirror)).toBe(true);
    const events = ledgerStampEvents(projectRoot, runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe(stamp?.event_id);
  });

  it('dry_run neither stamps nor touches the ledger', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-dry-nostamp';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    commitAll(projectRoot);

    const result = await executeComputationManifest({ dryRun: true, manifestPath, projectRoot, runDir, runId });

    expect(result.status).toBe('dry_run');
    expect((result as { origin_stamp?: unknown }).origin_stamp).toBeUndefined();
    expect(fs.existsSync(path.join(runDir, 'run_origin.json'))).toBe(false);
    expect(readValidityLedger(projectRoot).exists).toBe(false);
  });

  it('an approval-required outcome does not stamp (nothing executed)', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-approval-nostamp';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const manifestPath = stageComputation(runDir);
    initRunState(projectRoot, runId); // A3 NOT satisfied…
    // …and the machine gate is opt-in, so opt in to make approval required.
    fs.writeFileSync(
      path.join(projectRoot, '.nullius', 'approval_policy.json'),
      JSON.stringify({ schema_version: 1, mode: 'safe', require_approval_for: { compute_runs: true } }),
    );
    commitAll(projectRoot);

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });

    expect(result.status).toBe('requires_approval');
    expect((result as { origin_stamp?: unknown }).origin_stamp).toBeUndefined();
    expect(fs.existsSync(path.join(runDir, 'run_origin.json'))).toBe(false);
    expect(readValidityLedger(projectRoot).exists).toBe(false);
  });

  it('a run dir outside the stampable roots is skipped with the containment reason, no ledger write', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-outside-roots';
    const runDir = path.join(projectRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const manifestPath = stageComputation(runDir);
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });

    expect(result.status).toBe('completed');
    const stamp = (result as { origin_stamp?: { status: string; reason?: string } }).origin_stamp;
    expect(stamp?.status).toBe('skipped');
    expect(stamp?.reason).toContain('artifacts/runs');
    expect(fs.existsSync(path.join(runDir, 'run_origin.json'))).toBe(false);
    expect(readValidityLedger(projectRoot).exists).toBe(false);
  });

  it('without a git repository the stamp is honest: recorded as unbound, never invented', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runId = 'run-no-repo';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });

    expect(result.status).toBe('completed');
    const stamp = (result as { origin_stamp?: { status: string; binding_quality?: string } }).origin_stamp;
    expect(stamp?.status).toBe('stamped');
    expect(stamp?.binding_quality).toBe('unbound');
    expect(ledgerStampEvents(projectRoot, runId)).toHaveLength(1);
  });

  it('a same-tree relaunch does not append a second stamp event (no conflicting-stamps noise)', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-relaunch-same';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    commitAll(projectRoot);

    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect((first as { origin_stamp?: { status: string } }).origin_stamp?.status).toBe('stamped');

    const second = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    const stamp = (second as { origin_stamp?: { status: string } }).origin_stamp;
    expect(stamp?.status).toBe('already_stamped');
    expect(ledgerStampEvents(projectRoot, runId)).toHaveLength(1);
    const view = readValidityLedger(projectRoot);
    expect(view.runs.get(runId)?.conflicting_stamps).toBe(false);
  });

  it('a relaunch on CHANGED tracked code reports stale_stamp and refuses to silently rebind', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-relaunch-changed';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    commitAll(projectRoot);

    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect((first as { origin_stamp?: { status: string } }).origin_stamp?.status).toBe('stamped');

    // The code that will produce the rerun's results is no longer the code
    // the recorded stamp describes.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    commitAll(projectRoot);

    const second = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    const stamp = (second as { origin_stamp?: { status: string; detail?: string } }).origin_stamp;
    expect(stamp?.status).toBe('stale_stamp');
    expect(stamp?.detail).toContain('fresh run id');
    expect(ledgerStampEvents(projectRoot, runId)).toHaveLength(1);
  });

  it('a stamp failure is carried in the result and does not block the computation', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-stamp-fails';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    commitAll(projectRoot);
    // Poison the ledger path: a directory where the ledger FILE must go
    // makes the append throw while the computation itself is untouched.
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl'), { recursive: true });

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });

    expect(result.status).toBe('completed');
    const stamp = (result as { origin_stamp?: { status: string; error?: string } }).origin_stamp;
    expect(stamp?.status).toBe('failed');
    expect(typeof stamp?.error).toBe('string');
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'ok.json'))).toBe(true);
  });
});

describe('run identity and stamp idempotency hardening (review r1)', () => {
  it('refuses a runId that does not equal the run directory basename (one run, one identity)', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runDir = path.join(projectRoot, 'artifacts', 'runs', 'run-B');
    fs.mkdirSync(runDir, { recursive: true });
    const manifestPath = stageComputation(runDir);
    const manager = initRunState(projectRoot, 'run-A');
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);

    await expect(
      executeComputationManifest({ manifestPath, projectRoot, runDir, runId: 'run-A' }),
    ).rejects.toThrow(/run_id must equal the run directory basename/);
    // Dry-run is validation, so it refuses too.
    await expect(
      executeComputationManifest({ dryRun: true, manifestPath, projectRoot, runDir, runId: 'run-A' }),
    ).rejects.toThrow(/run_id must equal the run directory basename/);
    expect(readValidityLedger(projectRoot).exists).toBe(false);
  });

  it('appendValidityEvent onlyIfRunUnstamped skips inside the lock when a stamp exists', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const mk = (eventId: string) => buildValidityEvent({
      event: 'stamp',
      run_id: 'run-guarded',
      actor: 't',
      reason: null,
      event_id: eventId,
      stamp: {
        schema_id: 'run_origin_v1',
        event_id: eventId,
        run_id: 'run-guarded',
        captured_at_utc: '2026-08-08T00:00:00Z',
        binding_quality: 'unbound',
        baseline_commit: null,
        dirty: { tracked_modified: 0, untracked_count: 0 },
        no_repo_reason: 'test fixture',
      } as ValidityEventV1['stamp'],
    });
    const first = mk(mintUlid());
    expect(appendValidityEvent(projectRoot, first, { onlyIfRunUnstamped: true })).toBe('appended');
    // A DIFFERENT stamp event for the same run is skipped by the guard…
    expect(appendValidityEvent(projectRoot, mk(mintUlid()), { onlyIfRunUnstamped: true }))
      .toBe('skipped_run_already_stamped');
    // …while the crash-retry of the SAME event stays a no-op success.
    expect(appendValidityEvent(projectRoot, first, { onlyIfRunUnstamped: true })).toBe('already_present');
    const view = readValidityLedger(projectRoot);
    expect(view.events.filter(e => e.event === 'stamp' && e.run_id === 'run-guarded')).toHaveLength(1);
    expect(view.runs.get('run-guarded')?.conflicting_stamps).toBe(false);
  });

  it('the CLI verb is idempotent after a front-door auto-stamp: same tree exits 0 without a second event, changed tree refuses', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-cli-idem';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    commitAll(projectRoot);
    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect((first as { origin_stamp?: { status: string } }).origin_stamp?.status).toBe('stamped');

    const io = { cwd: projectRoot, out: [] as string[], err: [] as string[] };
    const cliIo = { cwd: projectRoot, stdout: (t: string) => io.out.push(t), stderr: (t: string) => io.err.push(t) };
    const parsed = {
      action: 'stamp' as const,
      target: path.join('artifacts', 'runs', runId),
      by: null, reason: null, scope: null, actor: 't', eventId: null, deps: {},
    };
    // Same tree: the manual follow-up an agent runs from the skill
    // instruction is a benign no-op, not a conflicting-stamps factory.
    expect(runTraceCommand(projectRoot, parsed, cliIo)).toBe(0);
    expect(io.out.join('')).toContain('already stamped');
    expect(ledgerStampEvents(projectRoot, runId)).toHaveLength(1);
    expect(readValidityLedger(projectRoot).runs.get(runId)?.conflicting_stamps).toBe(false);

    // Changed research code: the manual verb refuses instead of rebinding.
    fs.writeFileSync(path.join(projectRoot, 'changed.py'), 'x = 1\n');
    commitAll(projectRoot);
    expect(runTraceCommand(projectRoot, parsed, cliIo)).toBe(1);
    expect(io.err.join('')).toContain('DIFFERENT tracked code tree');
    expect(ledgerStampEvents(projectRoot, runId)).toHaveLength(1);
  });
});

describe('confirmation-round regressions (review r2)', () => {
  it('the identity check and the stamper agree under a symlinked project root', async () => {
    const realRoot = makeTmpDir();
    registerCleanup(realRoot);
    initRepo(realRoot);
    const linkRoot = `${realRoot}-link`;
    fs.symlinkSync(realRoot, linkRoot);
    registerCleanup(linkRoot);
    const runDir = path.join(realRoot, 'artifacts', 'runs', 'run-B');
    fs.mkdirSync(runDir, { recursive: true });
    const manifestPath = stageComputation(runDir);
    const manager = initRunState(linkRoot, 'run-A');
    markA3Satisfied(manager, 'A3-0001');
    commitAll(realRoot);

    // projectRoot given through the symlink alias, runDir through the real
    // path, runId mismatching the basename: the stamper's realpath predicate
    // calls this INSIDE the run root, so the identity check must refuse it
    // with the same resolution semantics — a lexical comparison here would
    // wave it through and stamp run-B while the result records run-A.
    await expect(
      executeComputationManifest({ manifestPath, projectRoot: linkRoot, runDir, runId: 'run-A' }),
    ).rejects.toThrow(/run_id must equal the run directory basename/);
    expect(readValidityLedger(linkRoot).exists).toBe(false);
  });

  it('mirror rollback undoes only this invocation\'s bytes (a concurrent winner\'s mirror is left alone)', () => {
    // Loser wrote OUR bytes and nothing changed since → roll back (remove
    // what we created / restore what preceded us).
    expect(mirrorRollbackAction('ours', 'ours', null)).toBe('remove');
    expect(mirrorRollbackAction('ours', 'ours', 'previous')).toBe('restore_previous');
    // The race winner replaced the mirror after us → leave the winner's
    // file untouched (removing it would orphan a successful stamp that
    // just reported mirror_written).
    expect(mirrorRollbackAction('winners', 'ours', null)).toBe('leave');
    expect(mirrorRollbackAction('winners', 'ours', 'previous')).toBe('leave');
    // File vanished entirely → nothing of ours to undo.
    expect(mirrorRollbackAction(null, 'ours', 'previous')).toBe('leave');
  });
});

describe('re-entry untracked-delta grading (review r1 of the version batch)', () => {
  it('an exact stamp followed by a NEW project-level script refuses re-entry; execution metabolism does not', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-delta-guard';
    const { runDir, manifestPath } = setupStampableRun(projectRoot, runId);
    commitAll(projectRoot);

    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect((first as { origin_stamp?: { status: string } }).origin_stamp?.status).toBe('stamped');

    // Execution metabolism alone (outputs, status files, logs written by
    // the first run) must NOT trip the delta guard: same tree relaunch
    // stays a benign no-op.
    const second = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect((second as { origin_stamp?: { status: string } }).origin_stamp?.status).toBe('already_stamped');

    // A new UNTRACKED project-level script is a code-bearing delta: the
    // recorded exact grade no longer describes what a relaunch executes.
    fs.writeFileSync(path.join(projectRoot, 'new_helper.py'), 'h = 1\n');
    const third = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    const stamp = (third as { origin_stamp?: { status: string; detail?: string } }).origin_stamp;
    expect(stamp?.status).toBe('stale_stamp');
    expect(stamp?.detail).toContain('untracked path(s)');
    expect(stamp?.detail).toContain('Commit the new files or use a fresh run id');
    // Nothing was appended in any of this.
    expect(ledgerStampEvents(projectRoot, runId)).toHaveLength(1);

    // The manual CLI verb refuses identically.
    const io = { out: [] as string[], err: [] as string[] };
    const cliIo = { cwd: projectRoot, stdout: (t: string) => io.out.push(t), stderr: (t: string) => io.err.push(t) };
    const code = runTraceCommand(projectRoot, {
      action: 'stamp' as const,
      target: path.join('artifacts', 'runs', runId),
      by: null, reason: null, scope: null, actor: 't', eventId: null, deps: {},
    }, cliIo);
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('no longer describes the tree');
  });
});
