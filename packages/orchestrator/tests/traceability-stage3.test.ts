import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintUlid } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger, resolveRunIdReference, stripRunRootPrefix } from '../src/validity-ledger.js';
import {
  backfillRunOrigins,
  confirmRoundChains,
  proposeRoundChains,
  runIdEpochSeconds,
  CHAIN_PROPOSAL_RELATIVE_PATH,
} from '../src/trace-backfill.js';
import { checkNotebookStaleness } from '../src/notebook-staleness.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';
import { captureRunOrigin } from '../src/run-origin.js';
import { runTraceCommand, type TraceParsed } from '../src/cli-trace.js';
import { checkChains, setCurrentResult, validateResultRegistry, type ResultRegistryRow } from '../src/result-registry.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-stage3-'));
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
function mkRun(runId: string): void {
  fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', runId), { recursive: true });
}

describe('runIdEpochSeconds (both id shapes, nominal detection)', () => {
  it('parses full and short ids and flags hand-rounded times as nominal', () => {
    expect(runIdEpochSeconds('20260806T171530Z-m9-x-r1')).toEqual({
      epoch: Date.parse('2026-08-06T17:15:30Z') / 1000, nominal: false,
    });
    expect(runIdEpochSeconds('20260806T170000Z-m9-x-r1')?.nominal).toBe(true);
    expect(runIdEpochSeconds('20260806-m9-x-r1')).toEqual({
      epoch: Date.parse('2026-08-06T00:00:00Z') / 1000, nominal: true,
    });
    expect(runIdEpochSeconds('blind')).toBeNull();
  });
});

describe('trace backfill (D8)', () => {
  it('aligns, flags nominal, reports unbound, and never touches validity', () => {
    initRepo(projectRoot);
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    const c2 = commitAt(projectRoot, '2026-08-03T10:00:00Z', 'b.txt');
    mkRun('20260802T121530Z-m1-alpha-r1'); // between c1 and c2 → c1 (real time)
    mkRun('20260804T000000Z-m1-beta-r1'); // nominal midnight after c2 → c2
    mkRun('20260731T090000Z-m1-early-r1'); // predates history → unbound
    mkRun('blind'); // unparseable → unbound
    const result = backfillRunOrigins(projectRoot);
    expect(result.aligned).toBe(2);
    expect(result.unbound).toBe(2);
    const view = readValidityLedger(projectRoot);
    const alpha = view.runs.get('20260802T121530Z-m1-alpha-r1');
    const alphaOrigin = alpha!.origin as unknown as Record<string, unknown>;
    expect(alphaOrigin.binding_quality).toBe('aligned_heuristic');
    expect(alphaOrigin.aligned_commit).toBe(c1);
    expect((alphaOrigin.alignment as { nominal_timestamp: boolean }).nominal_timestamp).toBe(false);
    const beta = view.runs.get('20260804T000000Z-m1-beta-r1');
    const betaOrigin = beta!.origin as unknown as Record<string, unknown>;
    expect(betaOrigin.aligned_commit).toBe(c2);
    expect((betaOrigin.alignment as { nominal_timestamp: boolean }).nominal_timestamp).toBe(true);
    const early = view.runs.get('20260731T090000Z-m1-early-r1');
    expect((early!.origin as unknown as Record<string, unknown>).binding_quality).toBe('unbound');
    // Validity untouched: everything stays active, nothing superseded.
    for (const run of view.runs.values()) expect(run.validity).toBe('active');
    // Mirrors written next to the runs.
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', '20260802T121530Z-m1-alpha-r1', 'run_origin.json'))).toBe(true);
    // Second invocation skips everything (idempotent).
    const again = backfillRunOrigins(projectRoot);
    expect(again.skipped).toBe(4);
    expect(again.aligned + again.unbound).toBe(0);
  });
});

describe('round-chain proposal and confirmation (D3)', () => {
  it('proposes only undecided chain pairs and confirms exactly what the file says', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260801T110000Z-m1-alpha-r1');
    mkRun('20260802T110000Z-m1-alpha-r2');
    mkRun('20260803T110000Z-m1-alpha-r3');
    mkRun('20260801T120000Z-m1-solo-r1'); // single round: no chain
    // A run someone already decided about is skipped — including one that a
    // reinstate put BACK to active (the decision, not the state, is what the
    // proposal must not relitigate).
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '20260801T110000Z-m1-alpha-r1', actor: 't', reason: 'already decided',
    }));
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'reinstate', run_id: '20260801T110000Z-m1-alpha-r1', actor: 't', reason: 'decided again: it stands',
      ts_utc: '2100-01-01T00:00:00Z',
    }));
    const { proposals } = proposeRoundChains(projectRoot);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.supersede).toEqual([
      { old_run_id: '20260802T110000Z-m1-alpha-r2', new_run_id: '20260803T110000Z-m1-alpha-r3' },
    ]);
    // User edits the proposal (keeps it as-is here) and confirms.
    const { appended } = confirmRoundChains(projectRoot, 'tester');
    expect(appended).toBe(1);
    const view = readValidityLedger(projectRoot);
    expect(view.runs.get('20260802T110000Z-m1-alpha-r2')?.validity).toBe('superseded');
    expect(view.runs.get('20260802T110000Z-m1-alpha-r2')?.superseded_by).toBe('20260803T110000Z-m1-alpha-r3');
    // Confirming again is idempotent.
    expect(confirmRoundChains(projectRoot, 'tester').appended).toBe(0);
  });

  it('respects user deletions from the proposal file', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260801T110000Z-m1-alpha-r1');
    mkRun('20260802T110000Z-m1-alpha-r2');
    proposeRoundChains(projectRoot);
    const proposalPath = path.join(projectRoot, CHAIN_PROPOSAL_RELATIVE_PATH);
    const parsed = JSON.parse(fs.readFileSync(proposalPath, 'utf-8')) as { proposals: unknown[] };
    parsed.proposals = []; // user rejects everything
    fs.writeFileSync(proposalPath, JSON.stringify(parsed));
    expect(confirmRoundChains(projectRoot, 'tester').appended).toBe(0);
    expect(readValidityLedger(projectRoot).runs.get('20260801T110000Z-m1-alpha-r1')?.validity ?? 'active').toBe('active');
  });
});

describe('notebook staleness checker (D5)', () => {
  function registerResult(runId: string, artifact: string): void {
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- RESULT_REGISTRY_START -->',
      '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
      '|---|---|---|---|---|---|',
      '<!-- RESULT_REGISTRY_END -->',
      '',
    ].join('\n'));
    setCurrentResult(projectRoot, { resultId: 'the-result', runId, artifactRelPath: artifact });
  }
  function stampReal(runId: string): void {
    mkRun(runId);
    const origin = captureRunOrigin(projectRoot, runId);
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'stamp', run_id: runId, actor: 't', reason: null,
      event_id: (origin as { event_id: string }).event_id,
      stamp: origin as ValidityEventV1['stamp'],
    }));
  }

  it('classifies all six outcomes decidably', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    stampReal('run-1');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'v.json'), '{}');
    const c2 = commitAt(projectRoot, '2026-08-02T10:00:00Z', 'b.txt');
    // Re-stamp at c2 for the registered run so the baseline is c2.
    fs.rmSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1'), { recursive: true });
    stampReal('run-2');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-2', 'v.json'), '{}');
    registerResult('run-2', 'artifacts/runs/run-2/v.json');
    // A superseded run for the citation step.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: 'dead-run', actor: 't', reason: 'withdrawn',
    }));
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# Notebook',
      '## Cites dead work',
      `<!-- written-against: ${c2} -->`,
      '<!-- cites-runs: dead-run -->',
      'text',
      '## Never stamped',
      'text',
      '## Unresolvable stamp',
      '<!-- written-against: deadbeef00 -->',
      'text',
      '## Behind current',
      `<!-- written-against: ${c1} -->`,
      'text',
      '## Fully current',
      `<!-- written-against: ${c2} -->`,
      'text',
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    const byHeading = Object.fromEntries(report.sections.map(section => [section.heading, section]));
    expect(byHeading['Cites dead work']!.class).toBe('stale');
    expect(byHeading['Cites dead work']!.cause).toContain('cites-superseded-run');
    expect(byHeading['Never stamped']!.class).toBe('unstamped');
    expect(byHeading['Unresolvable stamp']!.class).toBe('incomparable');
    expect(byHeading['Behind current']!.class).toBe('stale');
    expect(byHeading['Behind current']!.cause).toContain('stamp-behind');
    expect(byHeading['Fully current']!.class).toBe('current');
  });

  it('qualifies currency against head_plus_untracked identities and reports sentinels', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    fs.writeFileSync(path.join(projectRoot, 'untracked-research.py'), 'x = 1');
    stampReal('run-u'); // untracked file present → head_plus_untracked
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-u', 'v.json'), '{}');
    registerResult('run-u', 'artifacts/runs/run-u/v.json');
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# Notebook',
      '## Section',
      `<!-- written-against: ${c1} -->`,
      'text',
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    expect(report.sections[0]!.class).toBe('current-modulo-untracked');
  });
});

describe('stage-3 r1 review locks', () => {
  it('confirm-chains honors decisions made AFTER the proposal (no relitigation)', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260801T110000Z-m1-alpha-r1');
    mkRun('20260802T110000Z-m1-alpha-r2');
    proposeRoundChains(projectRoot);
    // Between proposal and confirmation, a human decides: r1 stands.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '20260801T110000Z-m1-alpha-r1', actor: 'human', reason: 'decided',
    }));
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'reinstate', run_id: '20260801T110000Z-m1-alpha-r1', actor: 'human', reason: 'it stands',
      ts_utc: '2100-01-01T00:00:00Z',
    }));
    const result = confirmRoundChains(projectRoot, 'tester');
    expect(result.appended).toBe(0);
    expect(result.skippedDecided).toBe(1);
    expect(readValidityLedger(projectRoot).runs.get('20260801T110000Z-m1-alpha-r1')?.validity).toBe('active');
  });

  it('quarantined runs (divergent ledger ids) are never proposed', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260801T110000Z-m1-alpha-r1');
    mkRun('20260802T110000Z-m1-alpha-r2');
    const sharedId = mintUlid();
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({ schema_id: 'validity_event_v1', event_id: sharedId, event: 'void', run_id: '20260801T110000Z-m1-alpha-r1', reason: 'A', actor: 't', ts_utc: '2026-08-01T12:00:00Z' }),
      JSON.stringify({ schema_id: 'validity_event_v1', event_id: sharedId, event: 'supersede', run_id: '20260801T110000Z-m1-alpha-r1', by_run_id: 'x', reason: 'B', actor: 't', ts_utc: '2026-08-01T12:00:00Z' }),
    ].join('\n') + '\n');
    // The divergent pair is excluded from `events` but assigns worst-state
    // validity — the exact path where an event-only check re-proposes it.
    const { proposals } = proposeRoundChains(projectRoot);
    expect(proposals).toHaveLength(0);
  });

  it('a failed ledger append removes the just-written backfill mirror (no orphan)', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260802T121530Z-m1-alpha-r1');
    // Hold the ledger lock so the append fails closed.
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(`${ledgerPath}.lock`, JSON.stringify({ pid: 99999, ts: 'held' }));
    try {
      expect(() => backfillRunOrigins(projectRoot)).toThrow(/ledger is locked/);
    } finally {
      fs.rmSync(`${ledgerPath}.lock`, { force: true });
    }
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', '20260802T121530Z-m1-alpha-r1', 'run_origin.json'))).toBe(false);
  });

  it('fenced ## lines are content, not section headings', () => {
    initRepo(projectRoot);
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# Notebook',
      '## Real section',
      `<!-- written-against: ${c1} -->`,
      'text',
      '```markdown',
      '## Fenced fake section',
      '<!-- written-against: deadbeef00 -->',
      '```',
      'more text of the real section',
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.heading).toBe('Real section');
    // The fenced fake stamp must not have overridden the real one — with an
    // empty baseline set the real stamp resolves and classifies current.
    expect(report.sections[0]!.class).toBe('current');
  });

  it('a mixed-delimiter fence does not expose a quoted section heading', () => {
    initRepo(projectRoot);
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# Notebook',
      '## Real section',
      `<!-- written-against: ${c1} -->`,
      '~~~',
      '```',
      '## Quoted section',
      '<!-- written-against: deadbeef00 -->',
      '~~~',
      'more text of the real section',
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]!.heading).toBe('Real section');
  });

  it('a vanished mirror is divergence unless the ledger recorded run_dir_unwritable', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260802T121530Z-m1-alpha-r1');
    backfillRunOrigins(projectRoot);
    fs.rmSync(path.join(projectRoot, 'artifacts', 'runs', '20260802T121530Z-m1-alpha-r1', 'run_origin.json'));
    const view = buildTraceabilityView(projectRoot);
    expect(view.warnings.mirror_divergence).toContain('20260802T121530Z-m1-alpha-r1');
    // A run whose ledger payload says run_dir_unwritable legitimately has no
    // mirror and is NOT flagged.
    const unwritableId = mintUlid();
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'stamp', run_id: 'legacy-unwritable', actor: 't', reason: null, event_id: unwritableId,
      stamp: {
        schema_id: 'run_origin_v1', event_id: unwritableId, run_id: 'legacy-unwritable',
        captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'unbound',
        baseline_commit: null, no_repo_reason: 'legacy', run_dir_unwritable: true,
        dirty: { tracked_modified: 0, untracked_count: 0 },
      } as ValidityEventV1['stamp'],
    }));
    mkRun('legacy-unwritable');
    const view2 = buildTraceabilityView(projectRoot);
    expect(view2.warnings.mirror_divergence).not.toContain('legacy-unwritable');
  });
});

describe('stage-3 r1 native-seat locks', () => {
  it('a malformed registry line contributes a sentinel: no unqualified current over a corrupt registry', () => {
    initRepo(projectRoot);
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- RESULT_REGISTRY_START -->',
      '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
      '|---|---|---|---|---|---|',
      '| `broken` | too | many | cells | in | this | row |',
      '<!-- RESULT_REGISTRY_END -->',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# N', '## Section', `<!-- written-against: ${c1} -->`, 'text',
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    expect(report.sections[0]!.class).toBe('incomparable');
    expect(report.sections[0]!.cause).toContain('unbindable-result-row');
  });

  it('snapshot-marker mismatch between row and stamp is a reported issue', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('run-1');
    const origin = captureRunOrigin(projectRoot, 'run-1'); // clean → no snapshot
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'stamp', run_id: 'run-1', actor: 't', reason: null,
      event_id: (origin as { event_id: string }).event_id,
      stamp: origin as ValidityEventV1['stamp'],
    }));
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'v.json'), '{}');
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- RESULT_REGISTRY_START -->',
      '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
      '|---|---|---|---|---|---|',
      '<!-- RESULT_REGISTRY_END -->',
    ].join('\n'));
    setCurrentResult(projectRoot, { resultId: 'r', runId: 'run-1', artifactRelPath: 'artifacts/runs/run-1/v.json' });
    // Hand-add a spurious +snapshot marker to the run cell.
    const indexPath = path.join(projectRoot, 'project_index.md');
    const text = fs.readFileSync(indexPath, 'utf-8');
    fs.writeFileSync(indexPath, text.replace(/(@ [0-9a-f]{12})`/, '$1+snapshot`'));
    const state = validateResultRegistry(projectRoot);
    expect(state.issues.some(entry => entry.code === 'result_row_snapshot_marker_mismatch')).toBe(true);
  });

  it('the clean prefix chained into a cycle is marked defective too', () => {
    // Pure-function fixture: no other per-row defect can mask the
    // prefix-marking path (the integration fixture's artifact-missing issue
    // did exactly that in the first mutation round).
    const row = (id: string, supersedes: string, supersededBy: string): ResultRegistryRow => ({
      result_id: id, description: `[${id}](x.md)`, artifact_target: 'x.md',
      artifact_sha256: '0'.repeat(64), run_id: `run-${id}`, effective_commit: null,
      has_snapshot: false, has_untracked: false, supersedes, superseded_by: supersededBy,
    });
    const issues: Array<{ code: string; message: string; path: string }> = [];
    const defective = new Set<string>();
    checkChains([row('e', 'c', 'none'), row('c', 'd', 'e'), row('d', 'c', 'c')], issues, defective);
    expect(issues.some(entry => entry.code === 'cyclic_result_supersession')).toBe(true);
    expect(defective.has('e')).toBe(true);
  });

  it('carried-forward multi-link descriptions are refused on update', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    for (const runId of ['run-1', 'run-2']) {
      mkRun(runId);
      const origin = captureRunOrigin(projectRoot, runId);
      appendValidityEvent(projectRoot, buildValidityEvent({
        event: 'stamp', run_id: runId, actor: 't', reason: null,
        event_id: (origin as { event_id: string }).event_id,
        stamp: origin as ValidityEventV1['stamp'],
      }));
      fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'v.json'), '{}');
    }
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- RESULT_REGISTRY_START -->',
      '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
      '|---|---|---|---|---|---|',
      '<!-- RESULT_REGISTRY_END -->',
    ].join('\n'));
    setCurrentResult(projectRoot, { resultId: 'r', runId: 'run-1', artifactRelPath: 'artifacts/runs/run-1/v.json' });
    // Hand-edit a second link into the description cell.
    const indexPath = path.join(projectRoot, 'project_index.md');
    const text = fs.readFileSync(indexPath, 'utf-8');
    fs.writeFileSync(indexPath, text.replace('[r](artifacts/runs/run-1/v.json)', '[r](artifacts/runs/run-1/v.json) and [x](other.md)'));
    expect(() => setCurrentResult(projectRoot, {
      resultId: 'r', runId: 'run-2', artifactRelPath: 'artifacts/runs/run-2/v.json',
    })).toThrow(/at most one link/);
  });

  it('the alignment timeline excludes the machinery refs (no self-alignment to pinned snapshots)', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    // Pin a much-later commit under the machinery namespace; alignment must
    // NOT see it.
    const later = commitAt(projectRoot, '2026-08-05T10:00:00Z', 'b.txt');
    execFileSync('git', ['-C', projectRoot, 'update-ref', 'refs/nullius/runs/other-run', later]);
    execFileSync('git', ['-C', projectRoot, 'reset', '-q', '--hard', 'HEAD~1']);
    // The later commit survives only via the machinery ref now.
    mkRun('20260806T121530Z-m1-alpha-r1');
    backfillRunOrigins(projectRoot);
    const view = readValidityLedger(projectRoot);
    const origin = view.runs.get('20260806T121530Z-m1-alpha-r1')!.origin as unknown as Record<string, unknown>;
    expect(origin.aligned_commit).not.toBe(later);
  });
});

describe('stage-3 r2 review locks', () => {
  it('a named-scope-only supersession does not shield a run from proposals', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('20260801T110000Z-m1-alpha-r1');
    mkRun('20260802T110000Z-m1-alpha-r2');
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'supersede', run_id: '20260801T110000Z-m1-alpha-r1', by_run_id: 'x',
      actor: 't', reason: 'partial only', scope: 'budget_only',
    }));
    const { proposals } = proposeRoundChains(projectRoot);
    // The run is still ACTIVE (scoped events never decide validity), so the
    // round chain is still proposed.
    expect(proposals).toHaveLength(1);
  });

  it('fenced stamps and citations never reach classification', () => {
    initRepo(projectRoot);
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: 'dead-run', actor: 't', reason: 'withdrawn',
    }));
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# N',
      '## Section',
      `<!-- written-against: ${c1} -->`,
      '```markdown',
      '<!-- cites-runs: dead-run -->',
      '<!-- written-against: deadbeef00 -->',
      '```',
      'text',
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    // The fenced dead citation and fake stamp are content: the real stamp
    // resolves and the section classifies current (empty baseline set).
    expect(report.sections[0]!.class).toBe('current');
  });

  it('stamp CLI restores a pre-existing mirror when the append fails', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'artifacts/\n');
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    mkRun('the-run');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'the-run', 'run_origin.json'), '{"legacy":"mirror"}');
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.writeFileSync(`${ledgerPath}.lock`, JSON.stringify({ pid: 99999, ts: 'held' }));
    const out: string[] = [];
    const err: string[] = [];
    try {
      expect(() => runTraceCommand(projectRoot, {
        action: 'stamp', target: 'artifacts/runs/the-run', eventId: null,
        by: null, reason: null, scope: null, actor: 'test', deps: {},
      }, { cwd: projectRoot, stdout: (t: string) => { out.push(t); }, stderr: (t: string) => { err.push(t); } }))
        .toThrow(/ledger is locked/);
    } finally {
      fs.rmSync(`${ledgerPath}.lock`, { force: true });
    }
    expect(fs.readFileSync(path.join(projectRoot, 'artifacts', 'runs', 'the-run', 'run_origin.json'), 'utf-8'))
      .toBe('{"legacy":"mirror"}');
  });
});

describe('stage-3 r2 native-seat locks', () => {
  it('with multiple stamps the LAST one is authoritative (section-end convention)', () => {
    initRepo(projectRoot);
    const c1 = commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# N',
      '## Section',
      '<!-- written-against: deadbeef00 -->',
      'prose discussing an earlier example stamp',
      `<!-- written-against: ${c1} -->`,
    ].join('\n'));
    const report = checkNotebookStaleness(projectRoot);
    expect(report.sections[0]!.class).toBe('current');
  });

  it('a later clean prefix reaching an already-processed cycle is defective too', () => {
    const row = (id: string, supersedes: string, supersededBy: string): ResultRegistryRow => ({
      result_id: id, description: `[${id}](x.md)`, artifact_target: 'x.md',
      artifact_sha256: '0'.repeat(64), run_id: `run-${id}`, effective_commit: null,
      has_snapshot: false, has_untracked: false, supersedes, superseded_by: supersededBy,
    });
    const issues: Array<{ code: string; message: string; path: string }> = [];
    const defective = new Set<string>();
    // Walk order: e first (marks the cycle), THEN f whose chain reaches the
    // done cycle — first-walker-only marking would let f escape.
    checkChains([
      row('e', 'c', 'none'), row('c', 'd', 'e'), row('d', 'c', 'c'), row('f', 'd', 'none'),
    ], issues, defective);
    expect(defective.has('f')).toBe(true);
    // Transitive one hop deeper: g reaches DONE non-cyclic e, which is
    // defective-as-prefix — g must be tainted too (codex r3 fixture).
    const issues2: Array<{ code: string; message: string; path: string }> = [];
    const defective2 = new Set<string>();
    checkChains([
      row('e', 'c', 'none'), row('c', 'd', 'e'), row('d', 'c', 'c'), row('g', 'e', 'none'),
    ], issues2, defective2);
    expect(defective2.has('g')).toBe(true);
  });

  it('a row missing its leading pipe is reported, not silently invisible', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- RESULT_REGISTRY_START -->',
      '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
      '|---|---|---|---|---|---|',
      'r1 | [r](x.md) | `' + '0'.repeat(64) + '` | `run` | `none` | `none` |',
      '<!-- RESULT_REGISTRY_END -->',
    ].join('\n'));
    const state = validateResultRegistry(projectRoot);
    expect(state.issues.some(entry => entry.code === 'malformed_result_row'
      && entry.message.includes('non-table line'))).toBe(true);
  });

  it('marker mismatch fires in the missing-marker direction too', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'dirty');
    mkRun('snap-run');
    const origin = captureRunOrigin(projectRoot, 'snap-run'); // dirty tracked → snapshot
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'stamp', run_id: 'snap-run', actor: 't', reason: null,
      event_id: (origin as { event_id: string }).event_id,
      stamp: origin as ValidityEventV1['stamp'],
    }));
    const effective = String((origin as unknown as Record<string, unknown>).snapshot_commit).slice(0, 12);
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '<!-- RESULT_REGISTRY_START -->',
      '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
      '|---|---|---|---|---|---|',
      // Row records the snapshot sha but DROPS the +snapshot marker.
      `| \`r\` | [r](x.md) | \`${'0'.repeat(64)}\` | \`snap-run @ ${effective}\` | \`none\` | \`none\` |`,
      '<!-- RESULT_REGISTRY_END -->',
    ].join('\n'));
    const state = validateResultRegistry(projectRoot);
    expect(state.issues.some(entry => entry.code === 'result_row_snapshot_marker_mismatch'
      && entry.message.includes('lacks'))).toBe(true);
  });
});

describe('round-cap warning and mirror divergence in the view (D9 + hook)', () => {
  it('warns past the slug threshold and on mirrors diverging from the ledger', () => {
    initRepo(projectRoot);
    commitAt(projectRoot, '2026-08-01T10:00:00Z', 'a.txt');
    for (let round = 1; round <= 6; round += 1) {
      mkRun(`2026080${round}T100000Z-m1-hot-topic-r${round}`);
    }
    backfillRunOrigins(projectRoot);
    // Diverge one mirror by hand.
    const mirrorPath = path.join(projectRoot, 'artifacts', 'runs', '20260801T100000Z-m1-hot-topic-r1', 'run_origin.json');
    const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf-8')) as Record<string, unknown>;
    mirror.binding_quality = 'exact_clean';
    fs.writeFileSync(mirrorPath, JSON.stringify(mirror));
    const view = buildTraceabilityView(projectRoot);
    expect(view.warnings.round_cap.some(cap => cap.slug === 'hot-topic' && cap.runs === 6)).toBe(true);
    expect(view.warnings.mirror_divergence).toContain('20260801T100000Z-m1-hot-topic-r1');
    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('ROUND CAP');
    expect(prose).toContain('MIRROR DIVERGENCE');
    expect(prose).toContain('trust the ledger');
  });
});

describe('validity verbs: run-id normalization, existence gate, landing receipts', () => {
  function collectIo(): { io: { cwd: string; stdout: (t: string) => void; stderr: (t: string) => void }; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { cwd: projectRoot, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
  }
  const verbArgs = (action: 'void' | 'supersede' | 'reinstate', target: string, by: string | null = null): TraceParsed => ({
    action, target, by, reason: 'fixture reason', scope: null,
    actor: 'test', eventId: null, recordOnly: false, deps: {},
  });

  it('void with a run-root path (tab completion shape) lands on the bare id and reports the landing validity', () => {
    mkRun('20260810-m2-r376-count');
    const { io, out } = collectIo();
    const code = runTraceCommand(projectRoot, verbArgs('void', 'artifacts/runs/20260810-m2-r376-count/'), io);
    expect(code).toBe(0);
    const view = readValidityLedger(projectRoot);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]!.run_id).toBe('20260810-m2-r376-count');
    expect(view.runs.get('20260810-m2-r376-count')!.validity).toBe('void');
    const receipt = out.join('');
    expect(receipt).toContain('validity now: void');
    expect(receipt).toContain('normalized from');
  });

  it('void refuses an id neither disk nor ledger knows, naming the nearest real ids, and appends nothing', () => {
    mkRun('20260810-m2-r376-count');
    mkRun('20260810-m2-r377-count-replay');
    const { io, err } = collectIo();
    const code = runTraceCommand(projectRoot, verbArgs('void', '20260810-m2-r376-covnt'), io);
    expect(code).toBe(1);
    const message = err.join('');
    expect(message).toContain('names no run directory and no ledger entry');
    expect(message).toContain('20260810-m2-r376-count');
    expect(readValidityLedger(projectRoot).events).toHaveLength(0);
  });

  it('supersede normalizes --by too, and refuses an unknown --by without appending', () => {
    mkRun('20260810-m2-r376-count');
    mkRun('20260811-m2-r412-rectangle');
    const { io } = collectIo();
    const code = runTraceCommand(
      projectRoot,
      verbArgs('supersede', '20260810-m2-r376-count', 'artifacts/runs/20260811-m2-r412-rectangle'),
      io,
    );
    expect(code).toBe(0);
    const view = readValidityLedger(projectRoot);
    expect(view.events[0]!.by_run_id).toBe('20260811-m2-r412-rectangle');
    expect(view.runs.get('20260810-m2-r376-count')!.superseded_by).toBe('20260811-m2-r412-rectangle');

    const bad = collectIo();
    const badCode = runTraceCommand(
      projectRoot,
      verbArgs('supersede', '20260810-m2-r376-count', 'artifacts/runs/20260811-m2-r999-nowhere'),
      bad.io,
    );
    expect(badCode).toBe(1);
    expect(bad.err.join('')).toContain('--by');
    expect(readValidityLedger(projectRoot).events).toHaveLength(1);
  });

  it('a ledger-known id whose directory is gone stays addressable (archived runs must accept verbs)', () => {
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '20260701-m0-r001-gone', actor: 'test', reason: 'archived away',
    }));
    const { io, out } = collectIo();
    const code = runTraceCommand(projectRoot, verbArgs('reinstate', '20260701-m0-r001-gone'), io);
    expect(code).toBe(0);
    expect(out.join('')).toContain('validity now: active');
  });

  it('the ledger writer itself refuses path-shaped ids in run_id and by_run_id (backstop for every caller)', () => {
    expect(() => appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: 'artifacts/runs/20260810-m2-r376-count', actor: 'test', reason: 'stray',
    }))).toThrow(/path-shaped/);
    expect(() => appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'supersede', run_id: '20260810-m2-r376-count', actor: 'test', reason: 'stray',
      by_run_id: 'artifacts/runs/20260811-m2-r412-rectangle',
    }))).toThrow(/path-shaped/);
  });

  it('stripRunRootPrefix strips exactly the recognizable run-root shapes', () => {
    expect(stripRunRootPrefix('20260810-m2-r376-count')).toBe('20260810-m2-r376-count');
    expect(stripRunRootPrefix('artifacts/runs/20260810-m2-r376-count')).toBe('20260810-m2-r376-count');
    expect(stripRunRootPrefix('team/runs/20260810-m2-r376-count/')).toBe('20260810-m2-r376-count');
    expect(stripRunRootPrefix('./artifacts/runs/20260810-m2-r376-count')).toBe('20260810-m2-r376-count');
    expect(stripRunRootPrefix('artifacts\\runs\\20260810-m2-r376-count')).toBe('20260810-m2-r376-count');
    expect(stripRunRootPrefix('some/other/path')).toBeNull();
    expect(stripRunRootPrefix('artifacts/runs/nested/deeper')).toBeNull();
    expect(stripRunRootPrefix('')).toBeNull();
  });

  it('resolveRunIdReference refuses absolute paths outside the project root', () => {
    const resolved = resolveRunIdReference(projectRoot, '/somewhere/else/artifacts/runs/x', { verb: 'trace void', role: 'run id' });
    expect(resolved.kind).toBe('rejected');
    expect((resolved as { message: string }).message).toContain('outside the project root');
  });
});

describe('validity verbs: dot references and plain files never satisfy the existence gate (codex r1)', () => {
  it("'.' and '..' are refused everywhere: strip, resolver, and the writer backstop", () => {
    expect(stripRunRootPrefix('.')).toBeNull();
    expect(stripRunRootPrefix('..')).toBeNull();
    expect(stripRunRootPrefix('./')).toBeNull();
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs'), { recursive: true });
    const resolved = resolveRunIdReference(projectRoot, '.', { verb: 'trace void', role: 'run id' });
    expect(resolved.kind).toBe('rejected');
    expect(() => appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '.', actor: 'test', reason: 'stray',
    }))).toThrow(/directory reference/);
  });

  it('a plain file directly on a run root does not count as an existing run', () => {
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', '.gitattributes'), 'x\n');
    const resolved = resolveRunIdReference(projectRoot, '.gitattributes', { verb: 'trace void', role: 'run id' });
    expect(resolved.kind).toBe('rejected');
    expect((resolved as { message: string }).message).toContain('names no run directory and no ledger entry');
  });
});
