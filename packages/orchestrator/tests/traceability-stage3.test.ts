import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintUlid } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from '../src/validity-ledger.js';
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
import { setCurrentResult } from '../src/result-registry.js';

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
