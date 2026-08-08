import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureRunOrigin, isForeignRunPath } from '../src/run-origin.js';

/** Untracked demotion counts only what bears on THIS run's code identity:
 *  other runs' accumulated artifacts are foreign noise (the measured
 *  91-run chain demoted every stamp on its predecessors' outputs); the
 *  run's OWN uncommitted scripts remain a real, reported uncertainty. */

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
  });
});

describe('captureRunOrigin with foreign run artifacts on disk', () => {
  it('other runs\' outputs do not demote this run; its own uncommitted script still does', () => {
    initRepoWithCommit();
    // Accumulated outputs of two EARLIER runs (untracked).
    for (const other of ['run-a', 'run-b']) {
      const dir = path.join(projectRoot, 'artifacts', 'runs', other, 'outputs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'result.json'), '{}');
    }

    const clean = captureRunOrigin(projectRoot, 'run-now', { pin: false });
    expect(clean.binding_quality).toBe('exact_clean');
    expect((clean as unknown as { dirty: { untracked_count: number } }).dirty.untracked_count).toBe(0);

    // The run's OWN uncommitted script is a real code-identity uncertainty.
    const ownDir = path.join(projectRoot, 'artifacts', 'runs', 'run-now', 'computation', 'scripts');
    fs.mkdirSync(ownDir, { recursive: true });
    fs.writeFileSync(path.join(ownDir, 'compute.py'), 'y = 2\n');

    const own = captureRunOrigin(projectRoot, 'run-now', { pin: false });
    expect(own.binding_quality).toBe('head_plus_untracked');
    const dirty = (own as unknown as { dirty: { untracked_count: number; untracked_sample: string[] } }).dirty;
    expect(dirty.untracked_count).toBe(1);
    expect(dirty.untracked_sample[0]).toContain('run-now');
  });

  it('an untracked file outside every run root still demotes', () => {
    initRepoWithCommit();
    fs.writeFileSync(path.join(projectRoot, 'new-model.py'), 'z = 3\n');
    const origin = captureRunOrigin(projectRoot, 'run-now', { pin: false });
    expect(origin.binding_quality).toBe('head_plus_untracked');
  });

  it('a byte-identical revert still stamps exact_clean (stat-dirty index must not break the capture)', () => {
    initRepoWithCommit();
    // Edit, then revert to the committed bytes: the index is stat-dirty
    // while the content is clean — `git stash create` exits nonzero on its
    // first call in that state unless the stat cache is refreshed first.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'x = 2\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'x = 1\n');
    const origin = captureRunOrigin(projectRoot, 'run-after-revert', { pin: false });
    expect(origin.binding_quality).toBe('exact_clean');
  });
});
