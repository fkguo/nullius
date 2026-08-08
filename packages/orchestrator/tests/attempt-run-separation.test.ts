import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mintUlid } from '@nullius/shared';
import { openRetryAttempt, stampRunDirectory } from '../src/run-stamp.js';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from '../src/validity-ledger.js';
import { setCurrentResult } from '../src/result-registry.js';
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
    // The operator's fix lives outside the runner write surface and stays.
    fs.writeFileSync(path.join(runDir, 'fixed_script.jl'), 'x = 1\n');

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
    } as never), { onlyIfAttemptChainHead: { closesOrdinal: 1 } });
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
});
