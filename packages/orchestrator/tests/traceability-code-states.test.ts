import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidityEventV1 } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent } from '../src/validity-ledger.js';
import { captureRunOrigin } from '../src/run-origin.js';
import { backfillRunOrigins } from '../src/trace-backfill.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';

/** Code states organize runs with an exact tracked-tree identity by their
 *  recorded snapshot trees — the version narrative of an exploratory
 *  session reconstructed from stamps alone. Slug families are a display
 *  grouping of one-off slugs into concept stems. */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-states-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf-8' });
}

function stampNow(runId: string, capturedAt: string): void {
  fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', runId), { recursive: true });
  const origin = captureRunOrigin(projectRoot, runId) as unknown as Record<string, unknown>;
  origin.captured_at_utc = capturedAt;
  appendValidityEvent(projectRoot, buildValidityEvent({
    event: 'stamp',
    run_id: runId,
    actor: 't',
    reason: null,
    event_id: origin.event_id as string,
    ts_utc: capturedAt,
    stamp: origin as ValidityEventV1['stamp'],
  }));
}

describe('code states from recorded snapshot trees', () => {
  it('groups runs by tree in capture order and diffs adjacent states on research files only', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');

    stampNow('20260808-m1-r001-alpha-probe', '2026-08-08T10:00:00.000Z');
    stampNow('20260808-m1-r002-alpha-refine', '2026-08-08T10:30:00.000Z');

    // The research tree evolves (uncommitted tracked edit → new snapshot tree).
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    stampNow('20260808-m1-r003-beta-scan', '2026-08-08T11:00:00.000Z');

    const view = buildTraceabilityView(projectRoot);

    expect(view.runs.code_states).toHaveLength(2);
    const [first, second] = view.runs.code_states;
    expect(first!.run_ids).toEqual(['20260808-m1-r001-alpha-probe', '20260808-m1-r002-alpha-refine']);
    expect(first!.run_count).toBe(2);
    expect(first!.changed_from_previous).toBeUndefined();
    expect(second!.run_ids).toEqual(['20260808-m1-r003-beta-scan']);
    expect(second!.changed_from_previous).toBeDefined();
    const changed = second!.changed_from_previous!;
    if (!('files' in changed)) throw new Error(`diff unavailable: ${JSON.stringify(changed)}`);
    expect(changed.total).toBe(1);
    expect(changed.files).toEqual(['solver.py']);
    expect(changed.run_artifact_changes).toBe(0);

    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('## Code states');
    // "exact" stays reserved for the exact grades; the grouping speaks of
    // the tracked-tree identity (head_plus_untracked runs belong — their
    // TRACKED tree is exactly known).
    expect(prose).toContain('3 stamped run(s) with an exact tracked-tree identity span 2 code-state episode(s)');
    expect(prose).not.toContain('exactly-stamped');
  });

  it('a returned-to tree forms a NEW revisited episode with the return transition visible', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');

    stampNow('20260808-m1-r001-alpha-probe', '2026-08-08T10:00:00.000Z');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    stampNow('20260808-m1-r002-beta-scan', '2026-08-08T11:00:00.000Z');
    // The session REVERTS the edit and runs again on the original tree.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    const solver = path.join(projectRoot, 'solver.py');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(solver, future, future);
    stampNow('20260808-m1-r003-alpha-return', '2026-08-08T12:00:00.000Z');

    const view = buildTraceabilityView(projectRoot);

    // A → B → A is THREE episodes, not two cohorts: folding the return
    // into the first occurrence would erase the B→A transition.
    expect(view.runs.code_states).toHaveLength(3);
    expect(view.runs.code_states[0]!.run_ids).toEqual(['20260808-m1-r001-alpha-probe']);
    expect(view.runs.code_states[1]!.run_ids).toEqual(['20260808-m1-r002-beta-scan']);
    expect(view.runs.code_states[2]!.run_ids).toEqual(['20260808-m1-r003-alpha-return']);
    expect(view.runs.code_states[0]!.tree).toBe(view.runs.code_states[2]!.tree);
    expect(view.runs.code_states[2]!.revisited).toBe(true);
    const returnDiff = view.runs.code_states[2]!.changed_from_previous!;
    if (!('files' in returnDiff)) throw new Error('return diff unavailable');
    expect(returnDiff.files).toEqual(['solver.py']);

    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('(revisited)');
  });

  it('folds tracked run-artifact churn out of the research diff (projects that commit their runs)', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    // NO .gitignore: this project tracks its run artifacts, so a previous
    // run's outputs are tracked churn between states.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');

    stampNow('20260808-m1-r001-alpha-probe', '2026-08-08T10:00:00.000Z');
    // Between states: one research edit plus a prior run's output landing.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    fs.writeFileSync(
      path.join(projectRoot, 'artifacts', 'runs', '20260808-m1-r001-alpha-probe', 'outputs.json'),
      '{}',
    );
    git('add', '-A');
    stampNow('20260808-m1-r002-beta-scan', '2026-08-08T11:00:00.000Z');

    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.code_states).toHaveLength(2);
    const changed = view.runs.code_states[1]!.changed_from_previous!;
    if (!('files' in changed)) throw new Error('diff unavailable');
    expect(changed.total).toBe(1);
    expect(changed.files).toEqual(['solver.py']);
    expect(changed.run_artifact_changes).toBeGreaterThanOrEqual(1);

    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('1 research file(s) changed (solver.py)');
    expect(prose).toContain('run-artifact change(s)');
  });

  it('orders states by first capture time even when stamps arrive out of order', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');

    // The LATER code state gets stamped first (ledger insertion order must
    // not be mistaken for chronology).
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    stampNow('20260808-m1-r003-beta-scan', '2026-08-08T11:00:00.000Z');
    // The tree returns to the earlier content; its runs carry earlier times.
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    stampNow('20260808-m1-r001-alpha-probe', '2026-08-08T10:00:00.000Z');

    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.code_states).toHaveLength(2);
    expect(view.runs.code_states[0]!.run_ids).toEqual(['20260808-m1-r001-alpha-probe']);
    expect(view.runs.code_states[0]!.first_captured_at).toBe('2026-08-08T10:00:00.000Z');
    expect(view.runs.code_states[1]!.run_ids).toEqual(['20260808-m1-r003-beta-scan']);
  });

  it('aligned/unbound stamps stay outside the classification, counted as inexact', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    const head = git('rev-parse', 'HEAD').trim();

    void head;
    stampNow('20260808-m1-r001-alpha-probe', '2026-08-08T10:00:00.000Z');
    // A legacy run with no stamp, retro-bound by the real backfill →
    // aligned_heuristic, exactly the class that has no exact tree.
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', '20260101T000000Z-m0-legacy-r1'), { recursive: true });
    backfillRunOrigins(projectRoot);

    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.code_states).toHaveLength(1);
    expect(view.runs.code_states_excluded_inexact).toBe(1);
  });
});

describe('slug families display grouping', () => {
  it('clusters one-off slugs by their two-word stem with validity tallies', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    for (const runId of [
      '20260808-m1-r001-branch-bypass-derivation',
      '20260808-m1-r002-branch-bypass-lift-prototype',
      '20260808-m1-r003-branch-bypass-lift-analysis',
      '20260808-m1-r004-root-locus-diagnostic',
      '20260808-m1-r005-root-locus-corridor-planner',
    ]) {
      fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', runId), { recursive: true });
    }
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void',
      run_id: '20260808-m1-r002-branch-bypass-lift-prototype',
      actor: 't',
      reason: 'script failed before producing output',
    }));

    const view = buildTraceabilityView(projectRoot);

    const families = Object.fromEntries(view.runs.slug_families.map(entry => [entry.family, entry]));
    expect(families['branch-bypass']).toMatchObject({ runs: 3, void: 1, superseded: 0 });
    expect(families['root-locus']).toMatchObject({ runs: 2, void: 0 });
    // Sorted by size, largest family first.
    expect(view.runs.slug_families[0]!.family).toBe('branch-bypass');

    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('slug families (display grouping): branch-bypass (3, 1 void), root-locus (2)');
  });
});

describe('adjacent-diff computation cap', () => {
  it('episodes beyond the cap carry an explicit not-computed marker, never a silently absent diff', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'V = 0\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    // 15 distinct trees → 15 episodes → adjacent pairs beyond the cap of 12.
    for (let index = 1; index <= 15; index += 1) {
      fs.writeFileSync(path.join(projectRoot, 'solver.py'), `V = ${index}\n`);
      stampNow(
        `20260808-m1-r${String(index).padStart(3, '0')}-step-${index}`,
        `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`,
      );
    }

    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.code_states).toHaveLength(15);
    const within = view.runs.code_states[12]!.changed_from_previous!;
    expect('files' in within).toBe(true);
    const beyond = view.runs.code_states[13]!.changed_from_previous!;
    if ('files' in beyond) throw new Error('expected the beyond-cap episode to carry a not-computed marker');
    expect(beyond.unavailable).toContain('not computed');
    // Every episode past the first says SOMETHING about its predecessor.
    for (const state of view.runs.code_states.slice(1)) {
      expect(state.changed_from_previous).toBeDefined();
    }
  });
});

describe('tie handling at episode boundaries (review r2)', () => {
  it('equal capture times order by stamp ULID (truthful mint order) and mark the boundary uncertain', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');

    const SAME_INSTANT = '2026-08-08T10:00:00.000Z';
    // Mint order (the ULIDs) is A then B; the wall clock cannot tell them
    // apart. The narrative must follow mint order and SAY the boundary is
    // a tie — never present the invented alternative as chronology.
    stampNow('20260808-m1-r001-alpha-probe', SAME_INSTANT);
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    stampNow('20260808-m1-r002-beta-scan', SAME_INSTANT);

    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.code_states).toHaveLength(2);
    expect(view.runs.code_states[0]!.run_ids).toEqual(['20260808-m1-r001-alpha-probe']);
    expect(view.runs.code_states[1]!.run_ids).toEqual(['20260808-m1-r002-beta-scan']);
    expect(view.runs.code_states[1]!.order_uncertain).toBe(true);
    expect(view.runs.code_states[0]!.order_uncertain).toBeUndefined();

    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('(order uncertain');
  });

  it('a same-instant A→B→A keeps its return transition (mint order, not any invented key)', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');

    const SAME_INSTANT = '2026-08-08T10:00:00.000Z';
    stampNow('20260808-m1-r001-alpha-probe', SAME_INSTANT);
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    stampNow('20260808-m1-r002-beta-scan', SAME_INSTANT);
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    const solver = path.join(projectRoot, 'solver.py');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(solver, future, future);
    stampNow('20260808-m1-r003-alpha-return', SAME_INSTANT);

    const view = buildTraceabilityView(projectRoot);
    // ANY ordering key other than mint order (tree, run id, …) puts the two
    // same-tree points adjacent and folds A→B→A into two episodes,
    // erasing the return — exactly the fabrication under review.
    expect(view.runs.code_states).toHaveLength(3);
    expect(view.runs.code_states.map(state => state.run_ids[0])).toEqual([
      '20260808-m1-r001-alpha-probe',
      '20260808-m1-r002-beta-scan',
      '20260808-m1-r003-alpha-return',
    ]);
    expect(view.runs.code_states[2]!.revisited).toBe(true);
  });

  it('distinct capture times carry no uncertainty marker', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c1');
    stampNow('20260808-m1-r001-alpha-probe', '2026-08-08T10:00:00.000Z');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'VERSION = 2\n');
    stampNow('20260808-m1-r002-beta-scan', '2026-08-08T11:00:00.000Z');

    const view = buildTraceabilityView(projectRoot);
    expect(view.runs.code_states[1]!.order_uncertain).toBeUndefined();
  });
});

describe('project-level run-root untracked split (review r2)', () => {
  it('the code-revision line splits out how many untracked paths sit under the run roots', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, 'solver.py'), 'x = 1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'run-a'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-a', 'out.json'), '{}');
    fs.writeFileSync(path.join(projectRoot, 'notes.md'), 'n\n');

    const view = buildTraceabilityView(projectRoot);
    expect(view.git.untracked_count).toBe(2);
    expect(view.git.untracked_under_run_roots).toBe(1);
    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('2 untracked file(s) pending a track-or-ignore decision (1 of these under the run roots)');
  });
});
