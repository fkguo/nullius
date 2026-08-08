import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mintUlid } from '@nullius/shared';
import { openRetryAttempt, removeEmptyDirTree, stampRunDirectory } from '../src/run-stamp.js';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from '../src/validity-ledger.js';
import { setCurrentResult, validateResultRegistry } from '../src/result-registry.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';
import {
  cleanupRegisteredDirs,
  createManifest,
  createPythonStep,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
} from './executeManifestTestUtils.js';
import { executeComputationManifest } from '../src/computation/index.js';
import { runCli } from '../src/cli.js';
import { stampComputationLaunch } from '../src/computation/launch-stamp.js';

/** Negative controls for the attempt–run separation: the retriable boundary
 *  refuses everything that is content territory, the honest paths cost one
 *  command (or zero at the front door), and every retained output still
 *  binds to the exact code of the attempt that produced it. */

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

function makeStampedRun(runId: string): { projectRoot: string; runDir: string } {
  const projectRoot = makeTmpDir();
  registerCleanup(projectRoot);
  initRepo(projectRoot);
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'seed\n');
  commitAll(projectRoot);
  const stamped = stampRunDirectory(projectRoot, runDir, { actor: 'test' });
  expect(stamped.kind).toBe('stamped');
  return { projectRoot, runDir };
}

function writeFailedStatus(runDir: string, errors: string[] = ['step exploded']): void {
  fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'computation', 'execution_status.json'),
    JSON.stringify({ status: 'failed', errors }),
  );
}

describe('the retry loop (hand path)', () => {
  it('closes the failed attempt, quarantines runner products, opens attempt 2 with a fresh sibling-ref binding', () => {
    const runId = 'run-crash-loop';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    fs.mkdirSync(path.join(runDir, 'computation', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'workspace', 'partial.tsv'), '1\t2\n');
    // The operator's fix is COMMITTED — git-tracked files are part of the
    // captured tree and never quarantined (moving one would dirty the very
    // tree the fresh capture binds).
    fs.writeFileSync(path.join(runDir, 'fixed_script.jl'), 'x = 1\n');
    execFileSync('git', ['-C', projectRoot, 'add', path.join('artifacts', 'runs', runId, 'fixed_script.jl')]);
    execFileSync('git', ['-C', projectRoot, 'commit', '-q', '-m', 'fix']);

    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.closedOrdinal).toBe(1);
    expect(result.openedOrdinal).toBe(2);
    expect(result.previousOutcome).toBe('failed');
    expect(result.evidence.method).toBe('execution_status');
    expect(result.evidence.execution_status_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Products archived, never deleted; inputs untouched.
    expect(fs.existsSync(path.join(runDir, 'attempts', 'attempt-1', 'computation', 'execution_status.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'attempts', 'attempt-1', 'computation', 'workspace', 'partial.tsv'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'execution_status.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'fixed_script.jl'))).toBe(true);

    const view = readValidityLedger(projectRoot);
    const entry = view.runs.get(runId)!;
    expect(entry.attempts.latest_ordinal).toBe(2);
    expect(entry.attempts.crash_retry_count).toBe(1);
    expect(entry.attempts.latest_failed).toBe(false);
    expect(entry.attempts.chain_defect).toBe(false);
    expect((entry.origin as { attempt_ordinal?: number }).attempt_ordinal).toBe(2);
    // The mirror shows the CURRENT binding.
    const mirror = JSON.parse(fs.readFileSync(path.join(runDir, 'run_origin.json'), 'utf-8')) as { attempt_ordinal?: number };
    expect(mirror.attempt_ordinal).toBe(2);
    // Per-attempt snapshot pins live in the sibling namespace when dirty
    // trees are involved; a clean tree needs no pin — assert no D/F error
    // occurred by taking a THIRD attempt with a dirty tree.
    writeFailedStatus(runDir);
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'tracked modification\n');
    const second = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(second.kind).toBe('retried');
    const refs = execFileSync('git', ['-C', projectRoot, 'for-each-ref', '--format=%(refname)', 'refs/nullius/'], { encoding: 'utf-8' });
    expect(refs).toContain(`refs/nullius/attempts/${runId}/3`);
  });

  it('missing self-heal: an empty surface advances the chain at zero ceremony and consumes no crash budget', () => {
    const runId = 'run-missing-heal';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.previousOutcome).toBe('missing');
    expect(result.evidence.method).toBe('outputs_scan');
    const entry = readValidityLedger(projectRoot).runs.get(runId)!;
    expect(entry.attempts.latest_ordinal).toBe(2);
    expect(entry.attempts.crash_retry_count).toBe(0);
  });

  it('hand-run residue without execution status requires a recorded declaration', () => {
    const runId = 'run-hand-residue';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.writeFileSync(path.join(runDir, 'half_written.tsv'), '1\n');
    const refused = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') expect(refused.message).toContain('--reason');
    const declared = openRetryAttempt(projectRoot, runDir, { actor: 'test', reason: 'crashed mid-write, no retained result' });
    expect(declared.kind).toBe('retried');
    if (declared.kind !== 'retried') return;
    expect(declared.previousOutcome).toBe('declared_no_result');
    expect(declared.evidence.method).toBe('declared');
  });

  it('record-only books the crash without opening a new attempt, and clears the crashed-unretried ambient list', () => {
    const runId = 'run-record-only';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test', recordOnly: true });
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.openedOrdinal).toBe(null);
    const entry = readValidityLedger(projectRoot).runs.get(runId)!;
    expect(entry.attempts.latest_ordinal).toBe(1);
    expect(entry.attempts.latest_failed).toBe(true);
    // A second retry from the closed head is refused (the closure exists).
    const again = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(again.kind).toBe('rejected');
  });
});

describe('the machine-narrow boundary (refusals)', () => {
  it('a COMPLETED execution refuses — content territory', () => {
    const runId = 'run-completed-refuse';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'execution_status.json'), JSON.stringify({ status: 'completed' }));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('content territory');
  });

  it('a results-registry row naming the run refuses — a consumed result never takes the cheap path', () => {
    const runId = 'run-registry-refuse';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.writeFileSync(path.join(runDir, 'value.json'), '{"v": 1}\n');
    // Seed the registry block the way a scaffolded project carries it.
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '# Index', '',
      '<!-- RESULT_REGISTRY_START -->',
      '| Result | Run | Artifact | SHA-256 | Supersedes | Superseded by |',
      '| --- | --- | --- | --- | --- | --- |',
      '<!-- RESULT_REGISTRY_END -->', '',
    ].join('\n'));
    setCurrentResult(projectRoot, { resultId: 'headline', runId, artifactRelPath: `artifacts/runs/${runId}/value.json` });
    writeFailedStatus(runDir);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('results registry');
  });

  it('a DECIDED (voided) run refuses', () => {
    const runId = 'run-decided-refuse';
    const { projectRoot, runDir } = makeStampedRun(runId);
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: runId, actor: 'test', reason: 'content was wrong',
    }));
    writeFailedStatus(runDir);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('DECIDED');
  });

  it('a heuristic (aligned) binding refuses — no exact identity to chain from', () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-aligned-refuse';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'seed\n');
    commitAll(projectRoot);
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'stamp', run_id: runId, actor: 'backfill', reason: null,
      stamp: {
        schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
        captured_at_utc: new Date().toISOString(), binding_quality: 'aligned_heuristic',
        baseline_commit: null,
        aligned_commit: 'a'.repeat(40),
        alignment: { window_prev_s: 3600, window_next_s: null },
        dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
      } as never,
    }));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('aligned_heuristic');
  });

  it('the manifest crash budget refuses past max_attempts, and the ceremony is named', () => {
    const runId = 'run-budget-refuse';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'manifest.json'), JSON.stringify({ max_attempts: 2 }));
    writeFailedStatus(runDir);
    const first = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(first.kind).toBe('retried'); // execution 2 of 2 allowed
    writeFailedStatus(runDir);
    const second = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(second.kind).toBe('rejected');
    if (second.kind === 'rejected') expect(second.message).toContain('crash budget');
  });
});

describe('chain integrity', () => {
  it('a concurrent-retry race loses cleanly: the in-lock chain-head guard skips the second append', () => {
    const runId = 'run-race';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    const winner = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(winner.kind).toBe('retried');
    // A stale writer that still believes the head is ordinal 1:
    const outcome = appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: runId, actor: 'test', reason: 'stale racer',
      attempt: {
        closes_ordinal: 1,
        previous_outcome: 'failed',
        evidence: { method: 'declared', detail: 'stale' },
        quarantined_to: null,
        supersedes_attempt_event: null,
        origin: null,
      },
    } as never), { onlyIfAttemptChainHead: true });
    expect(outcome).toBe('skipped_attempt_not_chain_head');
  });

  it('a plain stamp claiming an ordinal above 1 is a conservative chain defect', () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runId = 'run-forged-ordinal';
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'stamp', run_id: runId, actor: 'test', reason: null,
      stamp: {
        schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
        captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
        baseline_commit: null,
        no_repo_reason: 'test fixture',
        dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
        attempt_ordinal: 2,
      } as never,
    }));
    const entry = readValidityLedger(projectRoot).runs.get(runId)!;
    expect(entry.attempts.chain_defect).toBe(true);
  });

  it('legacy ledgers read byte-equivalently: crash-void triplets stay voids, attempts default to ordinal 1', () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    for (const [suffix, voided] of [['a', true], ['b', true], ['c', false]] as const) {
      const runId = `20260808-m1-r00${suffix}-legacy`;
      appendValidityEvent(projectRoot, buildValidityEvent({
        event: 'stamp', run_id: runId, actor: 'legacy', reason: null,
        stamp: {
          schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
          captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
          baseline_commit: null,
          no_repo_reason: 'legacy fixture',
          dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
        } as never,
      }));
      if (voided) {
        appendValidityEvent(projectRoot, buildValidityEvent({
          event: 'void', run_id: runId, actor: 'legacy', reason: 'crash retry minted a new id (pre-attempt era)',
        }));
      }
    }
    const view = readValidityLedger(projectRoot);
    expect(view.runs.get('20260808-m1-r00a-legacy')!.validity).toBe('void');
    expect(view.runs.get('20260808-m1-r00c-legacy')!.validity).toBe('active');
    for (const entry of view.runs.values()) {
      expect(entry.attempts.latest_ordinal).toBe(1);
      expect(entry.attempts.closures).toHaveLength(0);
      expect(entry.attempts.chain_defect).toBe(false);
    }
  });
});

describe('chain rooting and link resolution (r3)', () => {
  it('an attempt event with NO initial stamp cannot mint a clean binding — rooted chains only', () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    const runId = 'run-rootless-chain';
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: runId, actor: 'forger', reason: 'no stamp ever existed',
      attempt: {
        closes_ordinal: 1,
        previous_outcome: 'failed',
        evidence: { method: 'declared', detail: 'forged' },
        quarantined_to: null,
        supersedes_attempt_event: mintUlid(),
        origin: {
          schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
          captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
          baseline_commit: null,
          no_repo_reason: 'fixture',
          dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
          attempt_ordinal: 2,
        },
      },
    } as never));
    const entry = readValidityLedger(projectRoot).runs.get(runId)!;
    expect(entry.attempts.chain_defect).toBe(true);
  });

  it('a closure whose supersedes link does not resolve to the ordinal opener is a chain defect', () => {
    const runId = 'run-forged-link';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    const first = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(first.kind).toBe('retried');
    // Hand-append a closure of ordinal 2 whose predecessor link names a
    // random ULID instead of the attempt event that opened ordinal 2.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: runId, actor: 'forger', reason: 'wrong predecessor',
      attempt: {
        closes_ordinal: 2,
        previous_outcome: 'failed',
        evidence: { method: 'declared', detail: 'forged link' },
        quarantined_to: null,
        supersedes_attempt_event: mintUlid(),
        origin: {
          schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
          captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
          baseline_commit: null,
          no_repo_reason: 'fixture',
          dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
          attempt_ordinal: 3,
        },
      },
    } as never));
    const entry = readValidityLedger(projectRoot).runs.get(runId)!;
    expect(entry.attempts.chain_defect).toBe(true);
    // And the boundary refuses to chain from the defect:
    writeFailedStatus(runDir);
    const refused = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') expect(refused.message).toContain('chain');
  });
});

describe('quarantine covers the full product surface (r3)', () => {
  it('checkpoints, declared outputs, and terminal artifacts all move; manifest and scripts stay', () => {
    const runId = 'run-checkpoint-launder';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const computation = path.join(runDir, 'computation');
    fs.mkdirSync(path.join(computation, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(computation, 'manifest.json'), JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'scripts/main.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/main.py', expected_outputs: ['scripts/diag.json'] }],
    }));
    fs.writeFileSync(path.join(computation, 'scripts', 'main.py'), 'print(1)\n');
    // The laundering vector: a checkpoint the runner-era code wrote outside
    // the four runner entries, plus a declared output under scripts/, plus
    // a terminal artifact — none were covered by an entry-name allowlist.
    fs.writeFileSync(path.join(computation, 'units.checkpoint'), 'unit-1 done\n');
    fs.writeFileSync(path.join(computation, 'scripts', 'diag.json'), '{"partial": true}\n');
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'artifacts', 'partial_table.json'), '{"rows": 3}\n');
    writeFailedStatus(runDir);

    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    const archive = path.join(runDir, 'attempts', 'attempt-1');
    expect(fs.existsSync(path.join(archive, 'computation', 'units.checkpoint'))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'computation', 'scripts', 'diag.json'))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'artifacts', 'partial_table.json'))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'computation', 'execution_status.json'))).toBe(true);
    // Live surface: nothing of attempt 1 remains to ride into attempt 2…
    expect(fs.existsSync(path.join(computation, 'units.checkpoint'))).toBe(false);
    expect(fs.existsSync(path.join(computation, 'scripts', 'diag.json'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'artifacts', 'partial_table.json'))).toBe(false);
    // …while the relaunch inputs are intact.
    expect(fs.existsSync(path.join(computation, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(computation, 'scripts', 'main.py'))).toBe(true);
  });

  it('a manifest relocated outside computation/ is still seen: completed refuses, failed quarantines', () => {
    const runId = 'run-relocated-workspace';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const work = path.join(runDir, 'work');
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'scripts/main.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/main.py', expected_outputs: [] }],
    }));
    fs.writeFileSync(path.join(work, 'scripts', 'main.py'), 'print(1)\n');
    fs.writeFileSync(path.join(work, 'execution_status.json'), JSON.stringify({ status: 'completed' }));
    const refused = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') expect(refused.message).toContain('COMPLETED');

    fs.writeFileSync(path.join(work, 'execution_status.json'), JSON.stringify({ status: 'failed', errors: ['boom'] }));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.evidence.method).toBe('execution_status');
    expect(fs.existsSync(path.join(runDir, 'attempts', 'attempt-1', 'work', 'execution_status.json'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'execution_status.json'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'scripts', 'main.py'))).toBe(true);
  });

  it('two live status files are ambiguous evidence — refused, never arbitrated', () => {
    const runId = 'run-two-statuses';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    fs.mkdirSync(path.join(runDir, 'work'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'work', 'execution_status.json'), JSON.stringify({ status: 'failed', errors: ['x'] }));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('ambiguous');
  });
});

describe('crash-window recovery and honest fallbacks (r3)', () => {
  it('a stale orphan staging (append never landed) is restored, then re-quarantined by the next retry', () => {
    const runId = 'run-orphan-staging';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    // Debris of a crashed prior retry: staged logs whose event id never
    // reached the ledger, older than the in-flight window.
    const orphanRel = path.join('attempts', `.staging-${mintUlid()}`);
    fs.mkdirSync(path.join(runDir, orphanRel, 'computation', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(runDir, orphanRel, 'computation', 'logs', 'attempt.log'), 'died mid-move\n');
    const stale = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(path.join(runDir, orphanRel), stale, stale);

    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    // The orphan is gone; its contents ended up in the REAL attempt archive
    // (restored to the live surface, then quarantined with everything else).
    expect(fs.existsSync(path.join(runDir, orphanRel))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'attempts', 'attempt-1', 'computation', 'logs', 'attempt.log'))).toBe(true);
  });

  it('an empty failure message still records non-empty evidence (schema-valid after side effects)', () => {
    const runId = 'run-empty-error';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir, ['']);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.evidence.detail).toBe('execution status records failure');
  });

  it('the missing self-heal is capped: a run id churning without ever executing is sent to a fresh id', () => {
    const runId = 'run-heal-churn';
    const { projectRoot, runDir } = makeStampedRun(runId);
    for (let i = 0; i < 5; i += 1) {
      const healed = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
      expect(healed.kind).toBe('retried');
      if (healed.kind === 'retried') expect(healed.previousOutcome).toBe('missing');
    }
    const refused = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') expect(refused.message).toContain('churning');
  });
});

describe('confirmation-round regressions (review r4)', () => {
  it('the canonical terminal artifact field (execution_status) blocks completed-result laundering', () => {
    const runId = 'run-canonical-artifact';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    // Exactly what computation/result.ts writes for a completed run —
    // no `status`, no `ok`, only `execution_status`.
    fs.writeFileSync(
      path.join(runDir, 'artifacts', 'computation_result_v1.json'),
      JSON.stringify({ schema_version: 1, run_id: runId, execution_status: 'completed' }),
    );
    writeFailedStatus(runDir); // the laundering edit
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('COMPLETED');
  });

  it('an origin-bearing second closure of an already-closed ordinal conflicts; its binding never promotes', () => {
    const runId = 'run-smuggled-origin';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    const recordOnly = openRetryAttempt(projectRoot, runDir, { actor: 'test', recordOnly: true, reason: 'booked' });
    expect(recordOnly.kind).toBe('retried');
    const view = readValidityLedger(projectRoot);
    const recordedClosure = view.events.find(event => event.event === 'attempt' && event.run_id === runId)!;
    const recordedAttempt = (recordedClosure as { attempt?: Record<string, unknown> }).attempt!;
    // Forge a second closure of ordinal 1 with IDENTICAL non-origin fields
    // but an embedded ordinal-2 origin — the smuggle the origin-excluded
    // closure identity used to admit.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: runId, actor: 'forger', reason: recordedClosure.reason ?? 'booked',
      attempt: {
        ...recordedAttempt,
        origin: {
          schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
          captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
          baseline_commit: null,
          no_repo_reason: 'forged',
          dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
          attempt_ordinal: 2,
        },
      },
    } as never));
    const after = readValidityLedger(projectRoot).runs.get(runId)!;
    expect(after.attempts.conflicting_attempts).toBe(true);
    expect(after.attempts.latest_ordinal).toBe(1);
    expect((after.origin as { attempt_ordinal?: number } | null)?.attempt_ordinal ?? 1).toBe(1);
  });

  it('a FRESH unrecorded staging refuses the retry — never misread as an empty surface', () => {
    const runId = 'run-fresh-staging';
    const { projectRoot, runDir } = makeStampedRun(runId);
    // A sibling retry staged the products moments ago and has not appended.
    const freshRel = path.join('attempts', `.staging-${mintUlid()}`);
    fs.mkdirSync(path.join(runDir, freshRel, 'computation'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, freshRel, 'computation', 'execution_status.json'),
      JSON.stringify({ status: 'failed', errors: ['staged by sibling'] }),
    );
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('staging');
  });

  it('declared dependency inputs (lock files, data files) survive quarantine', () => {
    const runId = 'run-declared-inputs';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const computation = path.join(runDir, 'computation');
    fs.mkdirSync(path.join(computation, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(computation, 'manifest.json'), JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'scripts/main.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/main.py', expected_outputs: [] }],
      dependencies: { lock_files: ['requirements.lock'], data_files: ['data/input.csv'] },
    }));
    fs.writeFileSync(path.join(computation, 'scripts', 'main.py'), 'print(1)\n');
    fs.writeFileSync(path.join(computation, 'requirements.lock'), 'numpy==2.0\n');
    fs.mkdirSync(path.join(computation, 'data'), { recursive: true });
    fs.writeFileSync(path.join(computation, 'data', 'input.csv'), '1,2\n');
    writeFailedStatus(runDir);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    expect(fs.existsSync(path.join(computation, 'requirements.lock'))).toBe(true);
    expect(fs.existsSync(path.join(computation, 'data', 'input.csv'))).toBe(true);
    expect(fs.existsSync(path.join(computation, 'execution_status.json'))).toBe(false);
  });

  it('a workspace at depth five is discovered — the boundary is never blind to a deep manifest', () => {
    const runId = 'run-deep-workspace';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const deep = path.join(runDir, 'a', 'b', 'c', 'd', 'e');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'execution_status.json'), JSON.stringify({ status: 'completed' }));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('COMPLETED');
  });
});

describe('confirmation-round regressions (review r5)', () => {
  it('a stale staging whose ordinal was closed by a sibling is PROMOTED to that archive, never restored live', () => {
    const runId = 'run-promote-not-restore';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const headSha = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const view0 = readValidityLedger(projectRoot);
    const stampEventId = view0.events.find(event => event.event === 'stamp' && event.run_id === runId)!.event_id;
    // A sibling retry closed ordinal 1 (missing) and opened ordinal 2 with
    // an exact binding; OUR crashed invocation's staging (products of
    // attempt 1) survived it.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: runId, actor: 'sibling', reason: 'sibling won the race',
      attempt: {
        closes_ordinal: 1,
        previous_outcome: 'missing',
        evidence: { method: 'outputs_scan', detail: 'surface empty at its read' },
        quarantined_to: null,
        supersedes_attempt_event: stampEventId,
        origin: {
          schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: runId,
          captured_at_utc: new Date().toISOString(), binding_quality: 'exact_clean',
          baseline_commit: headSha,
          dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
          attempt_ordinal: 2,
        },
      },
    } as never));
    const staleRel = path.join('attempts', `.staging-${mintUlid()}-o1`);
    fs.mkdirSync(path.join(runDir, staleRel, 'computation', 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(runDir, staleRel, 'computation', 'outputs', 'partial.tsv'), '1\n');
    const stale = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(path.join(runDir, staleRel), stale, stale);
    // Attempt 2 then crashed with a status file on the live surface.
    writeFailedStatus(runDir);

    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    if (result.kind !== 'retried') return;
    expect(result.closedOrdinal).toBe(2);
    // The stale products landed in ATTEMPT 1's canonical archive — they
    // never touched the live surface now bound to attempt 2+.
    expect(fs.existsSync(path.join(runDir, 'attempts', 'attempt-1', 'computation', 'outputs', 'partial.tsv'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'partial.tsv'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, staleRel))).toBe(false);
  });

  it('the A3 approvals audit trail survives quarantine', () => {
    const runId = 'run-approvals-survive';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'approvals', 'A3-0001'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'approvals', 'A3-0001', 'approval_packet_v1.json'), '{"gate_id":"A3"}\n');
    writeFailedStatus(runDir);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    expect(fs.existsSync(path.join(runDir, 'approvals', 'A3-0001', 'approval_packet_v1.json'))).toBe(true);
  });

  it('the registry READ side keeps saying what the write side refuses: a later resultless head marks the row', () => {
    const runId = 'run-registry-readside';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.writeFileSync(path.join(runDir, 'value.json'), '{"v": 1}\n');
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '# Index', '',
      '<!-- RESULT_REGISTRY_START -->',
      '| Result | Run | Artifact | SHA-256 | Supersedes | Superseded by |',
      '| --- | --- | --- | --- | --- | --- |',
      '<!-- RESULT_REGISTRY_END -->', '',
    ].join('\n'));
    setCurrentResult(projectRoot, { resultId: 'headline', runId, artifactRelPath: `artifacts/runs/${runId}/value.json` });
    // Registered clean; NOW a record-only closure books the head attempt
    // as resultless (e.g. a union merge landed it).
    const view = readValidityLedger(projectRoot);
    const stampEventId = view.events.find(event => event.event === 'stamp' && event.run_id === runId)!.event_id;
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: runId, actor: 'test', reason: 'booked resultless after registration',
      attempt: {
        closes_ordinal: 1,
        previous_outcome: 'declared_no_result',
        evidence: { method: 'declared', detail: 'booked resultless after registration' },
        quarantined_to: null,
        supersedes_attempt_event: stampEventId,
        origin: null,
      },
    } as never));
    const validated = validateResultRegistry(projectRoot, readValidityLedger(projectRoot));
    expect(validated.issues.some(entry => entry.code === 'result_run_latest_attempt_failed')).toBe(true);
  });

  it('a boundary that cannot RULE refuses the launch — never fail-open into execution', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-boundary-throw';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(runDir, 'scripts/ok.py', 'import sys\nsys.exit(3)\n');
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/ok.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/ok.py', expected_outputs: ['outputs/never.json'] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);
    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(first.status).toBe('failed');
    // Change the tracked tree, then jam the ledger lock: the boundary
    // cannot rule, so the relaunch must refuse rather than execute.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'V = 2\n');
    commitAll(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl.lock'), { recursive: true });
    await expect(executeComputationManifest({ manifestPath, projectRoot, runDir, runId }))
      .rejects.toThrow(/could not rule/);
    fs.rmSync(path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl.lock'), { recursive: true, force: true });
  });
});

describe('confirmation-round regressions (review r6)', () => {
  it('a removed status file cannot route a completed run past the front-door refusal — the terminal artifact rules', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-artifact-witness-frontdoor';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(
      runDir,
      'scripts/ok.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.json').write_text('{}', encoding='utf-8')\n",
    );
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/ok.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/ok.py', expected_outputs: ['outputs/ok.json'] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);
    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(first.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'))).toBe(true);
    // Remove the status file and change the tree: without the terminal
    // witness this would fall to a non-blocking stale warning and execute.
    fs.rmSync(path.join(runDir, 'computation', 'execution_status.json'));
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'V = 2\n');
    commitAll(projectRoot);
    await expect(executeComputationManifest({ manifestPath, projectRoot, runDir, runId }))
      .rejects.toThrow(/terminal result artifact records a COMPLETED/);
  });

  it('crashed_unretried excludes a run whose crash budget is exhausted', () => {
    const runId = 'run-hint-budget';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'manifest.json'), JSON.stringify({ max_attempts: 1 }));
    writeFailedStatus(runDir);
    // The entrance would refuse (1-attempt budget, first execution spent);
    // the ambient hint must not advertise the refusing verb.
    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.crashed_unretried).not.toContain(runId);
  });

  it('a dot-prefixed workspace is discovered: its COMPLETED status refuses instead of reading as residue', () => {
    const runId = 'run-dot-workspace';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, '.work'), { recursive: true });
    fs.writeFileSync(path.join(runDir, '.work', 'execution_status.json'), JSON.stringify({ status: 'completed' }));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test', reason: 'should not matter' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('COMPLETED');
  });

  it('a head_plus_untracked binding registers with the +untracked qualifier, and dropping it is a read-side defect', () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-untracked-marker';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'seed\n');
    commitAll(projectRoot);
    // An untracked helper is present at capture: the binding is
    // head_plus_untracked — exact tracked identity, uncaptured extras.
    fs.writeFileSync(path.join(projectRoot, 'helper.py'), 'h = 1\n');
    const stamped = stampRunDirectory(projectRoot, runDir, { actor: 'test' });
    expect(stamped.kind).toBe('stamped');
    if (stamped.kind !== 'stamped') return;
    expect((stamped.origin as unknown as { binding_quality?: string }).binding_quality).toBe('head_plus_untracked');
    fs.writeFileSync(path.join(runDir, 'value.json'), '{"v": 1}\n');
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '# Index', '',
      '<!-- RESULT_REGISTRY_START -->',
      '| Result | Run | Artifact | SHA-256 | Supersedes | Superseded by |',
      '| --- | --- | --- | --- | --- | --- |',
      '<!-- RESULT_REGISTRY_END -->', '',
    ].join('\n'));
    setCurrentResult(projectRoot, { resultId: 'headline', runId, artifactRelPath: `artifacts/runs/${runId}/value.json` });
    const indexText = fs.readFileSync(path.join(projectRoot, 'project_index.md'), 'utf-8');
    expect(indexText).toContain('+untracked');
    const clean = validateResultRegistry(projectRoot, readValidityLedger(projectRoot));
    expect(clean.issues.some(entry => entry.code === 'result_row_untracked_marker_mismatch')).toBe(false);
    // The qualifier survives into BOTH render surfaces of `nullius current`
    // — JSON and prose — never presenting the binding as fully exact.
    const view = buildTraceabilityView(projectRoot);
    expect(view.results.current[0]?.has_untracked).toBe(true);
    expect(renderTraceabilityProse(view)).toContain('+untracked');
    // A hand edit that drops the qualifier renders the binding as fully
    // exact — the read side must say so.
    fs.writeFileSync(
      path.join(projectRoot, 'project_index.md'),
      indexText.replace('+untracked', ''),
    );
    const validated = validateResultRegistry(projectRoot, readValidityLedger(projectRoot));
    expect(validated.issues.some(entry => entry.code === 'result_row_untracked_marker_mismatch')).toBe(true);
  });

  it('a grading throw refuses the relaunch of an already-stamped run — never fail-open into execution', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-grading-throw';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(
      runDir,
      'scripts/ok.py',
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.json').write_text('{}', encoding='utf-8')\n",
    );
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/ok.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/ok.py', expected_outputs: ['outputs/ok.json'] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);
    const first = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(first.status).toBe('completed');
    const artifactBytes = fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8');
    // A held index.lock makes the grading probe's `git stash create`
    // throw; the completed run must be REFUSED, not overwritten.
    fs.writeFileSync(path.join(projectRoot, '.git', 'index.lock'), '');
    try {
      await expect(executeComputationManifest({ manifestPath, projectRoot, runDir, runId }))
        .rejects.toThrow(/could not grade|terminal result artifact/);
    } finally {
      fs.rmSync(path.join(projectRoot, '.git', 'index.lock'), { force: true });
    }
    // The completed evidence is untouched.
    expect(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')).toBe(artifactBytes);
  });

  it('a RUNNING status under a changed tree refuses the relaunch (declare the stall or wait)', () => {
    const runId = 'run-running-refusal';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'execution_status.json'), JSON.stringify({ status: 'running' }));
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'changed tracked code\n');
    execFileSync('git', ['-C', projectRoot, 'add', '-A']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-q', '-m', 'change']);
    const stamp = stampComputationLaunch(projectRoot, runDir);
    expect(stamp.status).toBe('refused_relaunch');
    if (stamp.status === 'refused_relaunch') expect(stamp.detail).toContain('RUNNING');
  });

  it('a recovery collision parks the staging remainder — never a permanent .staging jam', () => {
    const runId = 'run-staging-jam';
    const { projectRoot, runDir } = makeStampedRun(runId);
    // Live surface holds a REGENERATED status file…
    writeFailedStatus(runDir);
    // …and a stale orphan staging holds the OLD one at the same path:
    // restore collides file-vs-file and must park, not jam.
    const orphanId = mintUlid();
    const orphanRel = path.join('attempts', `.staging-${orphanId}-o1`);
    fs.mkdirSync(path.join(runDir, orphanRel, 'computation'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, orphanRel, 'computation', 'execution_status.json'),
      JSON.stringify({ status: 'failed', errors: ['older attempt'] }),
    );
    const stale = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(path.join(runDir, orphanRel), stale, stale);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('retried');
    expect(fs.existsSync(path.join(runDir, orphanRel))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'attempts', `unattributed-${orphanId}`, 'computation', 'execution_status.json'))).toBe(true);
  });

  it('an UNREADABLE terminal artifact refuses every consumer — truncation and dangling links cannot launder', () => {
    const runId = 'run-unreadable-witness';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const artifactPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(artifactPath, '{"execution_status": "comp');
    writeFailedStatus(runDir);
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('unreadable');
    // A DANGLING SYMLINK is an entry that exists but resolves nowhere —
    // existsSync would call it absent; the witness must call it unreadable.
    fs.rmSync(artifactPath);
    fs.symlinkSync('no-such-target.json', artifactPath);
    const symlinked = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(symlinked.kind).toBe('rejected');
    if (symlinked.kind === 'rejected') expect(symlinked.message).toContain('unreadable');
    // The ambient hint never advertises the refusing verb…
    expect(buildTraceabilityView(projectRoot).runs.crashed_unretried).not.toContain(runId);
    // …and the changed-tree relaunch fork refuses on the same witness.
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'changed for relaunch\n');
    execFileSync('git', ['-C', projectRoot, 'add', '-A']);
    execFileSync('git', ['-C', projectRoot, 'commit', '-q', '-m', 'change']);
    const relaunch = stampComputationLaunch(projectRoot, runDir);
    expect(relaunch.status).toBe('refused_relaunch');
    if (relaunch.status === 'refused_relaunch') expect(relaunch.detail).toContain('unreadable');
    // A FAILED terminal artifact (what every front-door crash writes) is
    // NOT a refusal — the entrance admits it as ordinary residue.
    fs.rmSync(artifactPath);
    fs.writeFileSync(
      artifactPath,
      JSON.stringify({ schema_version: 1, run_id: runId, execution_status: 'failed' }),
    );
    const admitted = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(admitted.kind).toBe('retried');
  });

  it('a truncated workspace discovery refuses to rule instead of misreading the surface', () => {
    const runId = 'run-discovery-truncated';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    const bulk = path.join(runDir, 'bulk');
    fs.mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 10_100; i += 1) fs.mkdirSync(path.join(bulk, `d${i}`));
    const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.message).toContain('truncated');
    // Clean the bulk INSIDE the test's own (raised) timeout — leaving 10k
    // directories to the afterEach hook trips vitest's 10s hookTimeout
    // under full-suite parallel load.
    fs.rmSync(bulk, { recursive: true, force: true });
  }, 120_000); // 10k mkdirs + the bounded walk are slow under full-suite parallel load

  it('the hint resolves a DETACHED budget manifest exactly like the entrance', () => {
    const runId = 'run-hint-detached-budget';
    const { projectRoot, runDir } = makeStampedRun(runId);
    // Status in one workspace, the SOLE manifest in another: the entrance
    // falls back to the single manifest anywhere and refuses the budget —
    // the hint must resolve it the same way and not list the run.
    writeFailedStatus(runDir);
    fs.mkdirSync(path.join(runDir, 'other'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'other', 'manifest.json'), JSON.stringify({ max_attempts: 1 }));
    const entrance = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(entrance.kind).toBe('rejected');
    if (entrance.kind === 'rejected') expect(entrance.message).toContain('crash budget');
    expect(buildTraceabilityView(projectRoot).runs.crashed_unretried).not.toContain(runId);
  });

  it('an all-moves-failed abort leaves NO .staging skeleton behind', () => {
    const runId = 'run-abort-no-skeleton';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const work = path.join(runDir, 'work');
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    // The manifest credits inputs, forcing PER-FILE moves inside work/
    // (a workspace without inputs would move as one whole directory,
    // which only needs write permission on the PARENT).
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'scripts/main.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/main.py', expected_outputs: [] }],
    }));
    fs.writeFileSync(path.join(work, 'scripts', 'main.py'), 'print(1)\n');
    fs.writeFileSync(path.join(work, 'execution_status.json'), JSON.stringify({ status: 'failed', errors: ['x'] }));
    // Read-only workspace: evidence reads fine (r-x) but the per-file
    // rename out of it fails → moved === 0, and the mkdir skeleton must
    // not survive to lock the retry the message advises.
    fs.chmodSync(work, 0o555);
    try {
      const aborted = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
      expect(aborted.kind).toBe('rejected');
      if (aborted.kind === 'rejected') expect(aborted.message).toContain('cannot quarantine');
      const attemptsDir = path.join(runDir, 'attempts');
      const leftovers = fs.existsSync(attemptsDir)
        ? fs.readdirSync(attemptsDir).filter(name => name.startsWith('.staging-'))
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      fs.chmodSync(work, 0o755);
    }
    // The advised remedy works IMMEDIATELY — no in-flight lockout.
    const retried = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(retried.kind).toBe('retried');
  });

  it('an unreadable ledger with a stamp mirror present refuses the launch (pre-read fail-closed)', () => {
    const runId = 'run-ledger-poisoned-mirror';
    const { projectRoot, runDir } = makeStampedRun(runId);
    expect(fs.existsSync(path.join(runDir, 'run_origin.json'))).toBe(true);
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    const ledgerBytes = fs.readFileSync(ledgerPath);
    fs.rmSync(ledgerPath);
    fs.mkdirSync(ledgerPath); // a directory where the ledger FILE must be
    try {
      const stamp = stampComputationLaunch(projectRoot, runDir);
      expect(stamp.status).toBe('refused_relaunch');
      if (stamp.status === 'refused_relaunch') expect(stamp.detail).toContain('could not read the ledger');
      // A DANGLING mirror symlink is still a witness (an entry exists) —
      // the refusal must not degrade to existsSync semantics.
      fs.rmSync(path.join(runDir, 'run_origin.json'));
      fs.symlinkSync('no-such-mirror.json', path.join(runDir, 'run_origin.json'));
      const dangling = stampComputationLaunch(projectRoot, runDir);
      expect(dangling.status).toBe('refused_relaunch');
    } finally {
      fs.rmdirSync(ledgerPath);
      fs.writeFileSync(ledgerPath, ledgerBytes);
    }
  });

  it('a genuinely fresh run with an EMPTY migrated attempts/ dir keeps never-blocks under a broken ledger', () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-fresh-empty-attempts';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'attempts'), { recursive: true }); // empty skeleton, no stamp ever
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'seed\n');
    commitAll(projectRoot);
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.mkdirSync(ledgerPath, { recursive: true }); // poisoned before any stamp exists
    try {
      const stamp = stampComputationLaunch(projectRoot, runDir);
      // No witness of any prior execution → the never-blocks doctrine
      // stands: a bookkeeping failure is carried, not a refusal.
      expect(stamp.status).toBe('failed');
      // A NON-EMPTY attempts/ flips it to the refusal.
      fs.mkdirSync(path.join(runDir, 'attempts', 'attempt-1'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'attempts', 'attempt-1', 'residue.txt'), 'x\n');
      const witnessed = stampComputationLaunch(projectRoot, runDir);
      expect(witnessed.status).toBe('refused_relaunch');
    } finally {
      fs.rmdirSync(ledgerPath);
    }
  });

  it('the zero-move skeleton cleanup never deletes a sibling\'s staged content (empty dirs only)', () => {
    const scratch = makeTmpDir();
    registerCleanup(scratch);
    const staging = path.join(scratch, '.staging-demo');
    fs.mkdirSync(path.join(staging, 'a', 'empty1', 'empty2'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'b'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'b', 'staged-product.json'), '{"kept": true}\n');
    removeEmptyDirTree(staging);
    // The empty chain is gone; the branch holding content survives whole.
    expect(fs.existsSync(path.join(staging, 'a'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'b', 'staged-product.json'))).toBe(true);
    expect(fs.existsSync(staging)).toBe(true);
  });

  it('the `result set-current` CLI echo carries the +untracked qualifier', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-cli-echo-untracked';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'seed\n');
    commitAll(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'helper.py'), 'h = 1\n'); // untracked at capture
    expect(stampRunDirectory(projectRoot, runDir, { actor: 'test' }).kind).toBe('stamped');
    fs.writeFileSync(path.join(runDir, 'value.json'), '{"v": 1}\n');
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '# Index', '',
      '<!-- RESULT_REGISTRY_START -->',
      '| Result | Run | Artifact | SHA-256 | Supersedes | Superseded by |',
      '| --- | --- | --- | --- | --- | --- |',
      '<!-- RESULT_REGISTRY_END -->', '',
    ].join('\n'));
    const out: string[] = [];
    const code = await runCli(
      ['result', 'set-current', 'headline', '--run', runId, '--artifact', `artifacts/runs/${runId}/value.json`],
      { cwd: projectRoot, stdout: (text: string) => out.push(text), stderr: (text: string) => out.push(text) },
    );
    expect(code).toBe(0);
    expect(out.join('')).toContain('+untracked');
  });

  it('a product that CANNOT be quarantined aborts admission — never left live under the next binding', () => {
    const runId = 'run-unmovable-product';
    const { projectRoot, runDir } = makeStampedRun(runId);
    const computation = path.join(runDir, 'computation');
    fs.mkdirSync(path.join(computation, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(computation, 'manifest.json'), JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'scripts/main.py', tool: 'python' },
      steps: [{ id: 's', tool: 'python', script: 'scripts/main.py', expected_outputs: [] }],
    }));
    fs.writeFileSync(path.join(computation, 'scripts', 'main.py'), 'print(1)\n');
    // A stray product inside the scripts dir (which recursion enters
    // because it holds an input), then the dir is made read-only so the
    // per-file move fails.
    fs.writeFileSync(path.join(computation, 'scripts', 'stray.json'), '{"partial": true}\n');
    writeFailedStatus(runDir);
    fs.chmodSync(path.join(computation, 'scripts'), 0o555);
    try {
      const result = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.message).toContain('cannot quarantine');
      // Nothing half-moved: the status file went back to the live surface.
      expect(fs.existsSync(path.join(computation, 'execution_status.json'))).toBe(true);
      expect(fs.existsSync(path.join(computation, 'scripts', 'stray.json'))).toBe(true);
    } finally {
      fs.chmodSync(path.join(computation, 'scripts'), 0o755);
    }
  });
});

describe('front-door preflight', () => {
  it('a failing preflight aborts BEFORE any capture: no stamp, no ledger', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-preflight-abort';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(runDir, 'scripts/broken.py', 'this is not python at all (\n');
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/broken.py', tool: 'python' },
      preflight: ['python3', '-m', 'py_compile', '{entry}'],
      steps: [{ id: 's', tool: 'python', script: 'scripts/broken.py', expected_outputs: [] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);

    await expect(executeComputationManifest({ manifestPath, projectRoot, runDir, runId }))
      .rejects.toThrow(/preflight refused the entry source/);
    expect(fs.existsSync(path.join(runDir, 'run_origin.json'))).toBe(false);
    expect(readValidityLedger(projectRoot).exists).toBe(false);
  });

  it('the preflight command passes the same blocked-command gate as every step', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-preflight-blocked';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(runDir, 'scripts/ok.py', 'print(1)\n');
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/ok.py', tool: 'python' },
      preflight: ['chmod', '777', '{entry}'],
      steps: [{ id: 's', tool: 'python', script: 'scripts/ok.py', expected_outputs: [] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');
    commitAll(projectRoot);
    await expect(executeComputationManifest({ manifestPath, projectRoot, runDir, runId }))
      .rejects.toThrow(/[Bb]locked command/);
    expect(readValidityLedger(projectRoot).exists).toBe(false);
  });

  it('the A3 approval packet lists the preflight command — approval covers everything that executes', async () => {
    const projectRoot = makeTmpDir();
    registerCleanup(projectRoot);
    initRepo(projectRoot);
    const runId = 'run-preflight-packet';
    const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    createPythonStep(runDir, 'scripts/ok.py', 'print(1)\n');
    const manifestPath = createManifest(runDir, {
      schema_version: 1,
      entry_point: { script: 'scripts/ok.py', tool: 'python' },
      preflight: ['python3', '-m', 'py_compile', '{entry}'],
      steps: [{ id: 's', tool: 'python', script: 'scripts/ok.py', expected_outputs: [] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    initRunState(projectRoot, runId); // A3 NOT satisfied…
    fs.writeFileSync(
      path.join(projectRoot, '.nullius', 'approval_policy.json'),
      JSON.stringify({ schema_version: 1, mode: 'safe', require_approval_for: { compute_runs: true } }),
    );
    commitAll(projectRoot);
    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('requires_approval');
    // The packet JSON must name the substituted preflight argv. Packets
    // land under the run's approvals/ directory.
    const packets: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.json')) packets.push(child);
      }
    };
    walk(path.join(runDir, 'approvals'));
    const packetWithPreflight = packets.some((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { commands?: string[] };
        return (parsed.commands ?? []).some(command => command.startsWith('[preflight] ') && command.includes('py_compile'));
      } catch {
        return false;
      }
    });
    expect(packetWithPreflight).toBe(true);
  });
});

describe('ambient hints only where they can be followed (r3)', () => {
  it('crashed_unretried lists only runs the retry entrance would admit', () => {
    const runId = 'run-hint-admissible';
    const { projectRoot, runDir } = makeStampedRun(runId);
    writeFailedStatus(runDir);
    // A second, UNSTAMPED failed run: the retry verb would refuse it, so
    // the ambient hint must not send the operator there.
    const ghostDir = path.join(projectRoot, 'artifacts', 'runs', 'run-hint-unstamped');
    fs.mkdirSync(path.join(ghostDir, 'computation'), { recursive: true });
    fs.writeFileSync(
      path.join(ghostDir, 'computation', 'execution_status.json'),
      JSON.stringify({ status: 'failed', errors: ['x'] }),
    );
    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.crashed_unretried).toContain(runId);
    expect(view.runs.crashed_unretried).not.toContain('run-hint-unstamped');
  });

  it('a relocated workspace is seen by the crashed scan too', () => {
    const runId = 'run-hint-relocated';
    const { projectRoot, runDir } = makeStampedRun(runId);
    fs.mkdirSync(path.join(runDir, 'work'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'work', 'execution_status.json'),
      JSON.stringify({ status: 'failed', errors: ['x'] }),
    );
    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.crashed_unretried).toContain(runId);
  });
});
