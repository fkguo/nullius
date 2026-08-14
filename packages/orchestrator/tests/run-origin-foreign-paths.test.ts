import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureRunOrigin, isForeignRunPath } from '../src/run-origin.js';

/** Foreign-run untracked paths (other runs' accumulated artifacts) are
 *  SPLIT OUT for reporting — never excluded from the count or the honesty
 *  grade: a foreign run directory can hold uncommitted executable files
 *  this run imports, and no machine test proves it does not. Over-counting
 *  is a conservative label; under-counting would be a false exact claim. */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-paths-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync('git', ['-C', projectRoot, ...args]);
}
function initRepoWithCommit(): void {
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'x = 1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'c');
}

describe('isForeignRunPath', () => {
  it('classifies run-root paths by ownership', () => {
    expect(isForeignRunPath('artifacts/runs/run-other/out.json', 'run-mine')).toBe(true);
    expect(isForeignRunPath('team/runs/tag-other/log.md', 'run-mine')).toBe(true);
    expect(isForeignRunPath('artifacts/runs/run-mine/computation/scripts/ok.py', 'run-mine')).toBe(false);
    expect(isForeignRunPath('team/runs/run-mine/notes.md', 'run-mine')).toBe(false);
    expect(isForeignRunPath('src/analysis.py', 'run-mine')).toBe(false);
    // A file directly ON the root is not inside any run directory.
    expect(isForeignRunPath('artifacts/runs/stray-file.txt', 'run-mine')).toBe(false);
    // Literal backslashes in a POSIX path are ordinary characters, not
    // separators: this is one root-level file, not a nested foreign path.
    expect(isForeignRunPath(String.raw`artifacts/runs/weird\name`, 'run-mine')).toBe(false);
  });
});

describe('captureRunOrigin with foreign run artifacts on disk', () => {
  it('foreign artifacts stay in the count and the grade, split out and sampled last', () => {
    initRepoWithCommit();
    // Accumulated outputs of two EARLIER runs (untracked).
    for (const other of ['run-a', 'run-b']) {
      const dir = path.join(projectRoot, 'artifacts', 'runs', other, 'outputs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'result.json'), '{}');
    }
    // The run's own uncommitted script — the signal path.
    const ownDir = path.join(projectRoot, 'artifacts', 'runs', 'run-now', 'computation', 'scripts');
    fs.mkdirSync(ownDir, { recursive: true });
    fs.writeFileSync(path.join(ownDir, 'compute.py'), 'y = 2\n');

    const origin = captureRunOrigin(projectRoot, 'run-now', { pin: false });
    // Conservative grade over the FULL set — foreign artifacts included.
    expect(origin.binding_quality).toBe('head_plus_untracked');
    const dirty = (origin as unknown as {
      dirty: { untracked_count: number; foreign_run_untracked?: number; untracked_sample: string[] };
    }).dirty;
    expect(dirty.untracked_count).toBe(3);
    expect(dirty.foreign_run_untracked).toBe(2);
    // The sample leads with the path that bears on THIS run's code identity.
    expect(dirty.untracked_sample[0]).toContain('run-now');
  });

  it('only foreign artifacts: grade still demotes (an imported foreign script cannot be ruled out)', () => {
    initRepoWithCommit();
    const dir = path.join(projectRoot, 'artifacts', 'runs', 'run-a', 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'helper.py'), 'h = 1\n');

    const origin = captureRunOrigin(projectRoot, 'run-now', { pin: false });
    expect(origin.binding_quality).toBe('head_plus_untracked');
    const dirty = (origin as unknown as { dirty: { untracked_count: number; foreign_run_untracked?: number } }).dirty;
    expect(dirty.untracked_count).toBe(1);
    expect(dirty.foreign_run_untracked).toBe(1);
  });

  it('an untracked file outside every run root still demotes and is not counted foreign', () => {
    initRepoWithCommit();
    fs.writeFileSync(path.join(projectRoot, 'new-model.py'), 'z = 3\n');
    const origin = captureRunOrigin(projectRoot, 'run-now', { pin: false });
    expect(origin.binding_quality).toBe('head_plus_untracked');
    const dirty = (origin as unknown as { dirty: { foreign_run_untracked?: number } }).dirty;
    expect(dirty.foreign_run_untracked).toBeUndefined();
  });

  it('a byte-identical revert still stamps exact_clean (stat-dirty index must not break the capture)', () => {
    initRepoWithCommit();
    // Edit, then revert to the committed bytes; force the mtime FORWARD so
    // the index is deterministically stat-dirty (same-second writes often
    // fall inside git's racy-clean handling and would make this lock
    // probabilistic — measured 39/40 survival without the forced mtime).
    const solver = path.join(projectRoot, 'solver.py');
    fs.writeFileSync(solver, 'x = 2\n');
    fs.writeFileSync(solver, 'x = 1\n');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(solver, future, future);
    const origin = captureRunOrigin(projectRoot, 'run-after-revert', { pin: false });
    expect(origin.binding_quality).toBe('exact_clean');
  });
});

describe('control-plane paths under .nullius/ are machine bookkeeping, never code drift', () => {
  it('untracked .nullius/backups/ (and friends) do not demote the binding quality', () => {
    initRepoWithCommit();
    fs.mkdirSync(path.join(projectRoot, '.nullius', 'backups', '20260808T000000Z'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'backups', '20260808T000000Z', 'AGENTS.md'), 'backup\n');
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'HARNESS_INVOCATION'), '{}\n');
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'run-clean'), { recursive: true });
    const origin = captureRunOrigin(projectRoot, 'run-clean', { pin: false });
    // The tool's own refresh backups previously held every later stamp at
    // head_plus_untracked until the qualifier stopped discriminating
    // (measured: 19/19 registered results qualified on one project).
    expect(origin.binding_quality).toBe('exact_clean');
    expect(origin.dirty.untracked_count).toBe(0);
  });

  it('a genuine research stray still demotes even when control-plane noise is present', () => {
    initRepoWithCommit();
    fs.mkdirSync(path.join(projectRoot, '.nullius', 'backups'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.nullius', 'backups', 'old.md'), 'backup\n');
    fs.writeFileSync(path.join(projectRoot, 'stray_analysis.py'), 'y = 2\n');
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'run-dirty'), { recursive: true });
    const origin = captureRunOrigin(projectRoot, 'run-dirty', { pin: false });
    expect(origin.binding_quality).toBe('head_plus_untracked');
    expect(origin.dirty.untracked_count).toBe(1);
    expect(origin.dirty.untracked_sample).toEqual(['stray_analysis.py']);
  });
});
