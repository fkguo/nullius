import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeComputationManifest } from '../src/computation/index.js';
import { readValidityLedger } from '../src/validity-ledger.js';
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
