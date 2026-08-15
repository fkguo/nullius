import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRunIndexBlock,
  computeRunIndexProjection,
  refreshRunIndexBlock,
  renderRunIndexBlock,
  RUN_INDEX_END,
  RUN_INDEX_START,
} from '../src/run-index.js';
import { openRetryAttempt, stampRunDirectory } from '../src/run-stamp.js';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from '../src/validity-ledger.js';
import { parseResultRegistry, setCurrentResult, validateResultRegistry } from '../src/result-registry.js';
import { refreshNotebookCurrentState } from '../src/notebook-current-state.js';
import { refreshManagedBlock } from '../src/managed-block.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';
import { runCli } from '../src/cli.js';
import { runTraceCommand } from '../src/cli-trace.js';
import { cleanupRegisteredDirs, makeTmpDir, registerCleanup } from './executeManifestTestUtils.js';
import { mintUlid } from '@nullius/shared';

/** The run index: a per-family, honesty-loud map of every run directory,
 *  rendered from the ledger into a machine-owned block in project_index.md.
 *  Measured against the audit problem it exists for: 85/148 runs invisible
 *  to every planning document. */

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

const PLACEHOLDER_BLOCK = [
  RUN_INDEX_START,
  '(machine-maintained run index — rendered by `nullius index sync`; do not edit between these markers)',
  RUN_INDEX_END,
].join('\n');

function makeProject(options?: { withIndexFile?: boolean; git?: boolean }): string {
  const projectRoot = makeTmpDir();
  registerCleanup(projectRoot);
  if (options?.git !== false) {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'seed.txt'), 'seed\n');
  }
  if (options?.withIndexFile !== false) {
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '# Index', '',
      '<!-- RESULT_REGISTRY_START -->',
      '| Result | Run | Artifact | SHA-256 | Supersedes | Superseded by |',
      '| --- | --- | --- | --- | --- | --- |',
      '<!-- RESULT_REGISTRY_END -->', '',
      PLACEHOLDER_BLOCK, '',
    ].join('\n'));
  }
  // Committed AFTER the index file exists: an untracked project_index.md
  // would make every stamp head_plus_untracked and pollute the fixtures.
  if (options?.git !== false) commitAll(projectRoot);
  return projectRoot;
}

function mkRun(projectRoot: string, runId: string): string {
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function stampRun(projectRoot: string, runId: string): void {
  const stamped = stampRunDirectory(projectRoot, path.join('artifacts', 'runs', runId), { actor: 'test' });
  expect(stamped.kind).toBe('stamped');
}

function blockText(projectRoot: string): string {
  const text = fs.readFileSync(path.join(projectRoot, 'project_index.md'), 'utf-8');
  const start = text.indexOf(RUN_INDEX_START);
  const end = text.indexOf(RUN_INDEX_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + RUN_INDEX_END.length);
}

describe('projection and render', () => {
  it('groups runs by family with a validity split, latest run, and current-result markers', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-dstar-dk-scan');
    mkRun(projectRoot, '20260809-m1-r002-dstar-dk-scan');
    mkRun(projectRoot, '20260809-m1-r001-coulomb-probe');
    stampRunDirectory(projectRoot, path.join(projectRoot, 'artifacts', 'runs', '20260809-m1-r001-dstar-dk-scan'), { actor: 'test' });
    stampRunDirectory(projectRoot, path.join(projectRoot, 'artifacts', 'runs', '20260809-m1-r002-dstar-dk-scan'), { actor: 'test' });
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '20260809-m1-r001-dstar-dk-scan', actor: 'test', reason: 'wrong sign',
    }));
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', '20260809-m1-r002-dstar-dk-scan', 'value.json'), '{"v":1}\n');
    setCurrentResult(projectRoot, {
      resultId: 'headline',
      runId: '20260809-m1-r002-dstar-dk-scan',
      artifactRelPath: 'artifacts/runs/20260809-m1-r002-dstar-dk-scan/value.json',
    });

    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.run_directories).toBe(3);
    expect(projection.totals).toEqual({ active: 1, superseded: 0, void: 1, unclassified: 1, stamped: 2 });
    expect(projection.families.map(family => family.family)).toEqual(['dstar-dk', 'coulomb-probe']);
    const dstar = projection.families[0]!;
    expect(dstar).toMatchObject({ runs: 2, active: 1, void: 1, unclassified: 0 });
    expect(dstar.latest.run_id).toBe('20260809-m1-r002-dstar-dk-scan');
    expect(dstar.current_results).toEqual([{ result_id: 'headline', defective: false }]);

    const rendered = renderRunIndexBlock(projection);
    expect(rendered).toContain('| dstar-dk | 2 | 1 | 0 | 1 | 0 |');
    expect(rendered).toContain('[20260809-m1-r002-dstar-dk-scan](artifacts/runs/20260809-m1-r002-dstar-dk-scan/)');
    expect(rendered).toContain('★headline');
    expect(rendered).toContain('(unclassified)');
  });

  it('an empty project renders the honest empty state, never an empty table', () => {
    const projectRoot = makeProject();
    const rendered = renderRunIndexBlock(computeRunIndexProjection(projectRoot));
    expect(rendered).toContain('No run directories yet');
    expect(rendered).not.toContain('| Family |');
  });

  it('latest is the lexicographically highest run id — a stamped August run never outranks a September directory', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260801-m1-r001-legacy-chain');
    mkRun(projectRoot, '20260805-m1-r002-legacy-chain');
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.families[0]!.latest.run_id).toBe('20260805-m1-r002-legacy-chain');
    expect(projection.families[0]!.latest.validity).toBe('unclassified');
    // Mixed family: the OLDER run is stamped, the NEWER directory is not.
    // A capture-time-first key would send the browsing researcher to
    // August; the id key sends them to September (D3 as revised).
    stampRun(projectRoot, '20260801-m1-r001-legacy-chain');
    mkRun(projectRoot, '20260901-m1-r003-legacy-chain');
    const mixed = computeRunIndexProjection(projectRoot);
    expect(mixed.families[0]!.latest.run_id).toBe('20260901-m1-r003-legacy-chain');
    expect(mixed.families[0]!.latest.stamped).toBe(false);
  });

  it('defects render unconditionally: chain defects, ledger-only ids, and the +more cap', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-defect-run');
    // A rootless attempt event: chain defect on a run WITH a directory.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'attempt', run_id: '20260809-m1-r001-defect-run', actor: 'forger', reason: 'no stamp',
      attempt: {
        closes_ordinal: 1, previous_outcome: 'failed',
        evidence: { method: 'declared', detail: 'forged' },
        quarantined_to: null, supersedes_attempt_event: mintUlid(),
        origin: {
          schema_id: 'run_origin_v1', event_id: mintUlid(), run_id: '20260809-m1-r001-defect-run',
          captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
          baseline_commit: null, no_repo_reason: 'fixture',
          dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
          attempt_ordinal: 2,
        },
      },
    } as never));
    // Seven ledger-only ids: the defect list is the repair worklist, so it
    // renders in FULL — a "+N more" tail would hide work the reader is
    // being told to do.
    for (let index = 0; index < 7; index += 1) {
      appendValidityEvent(projectRoot, buildValidityEvent({
        event: 'void', run_id: `20260701-m0-r00${index}-gone-run`, actor: 'test', reason: 'directory removed',
      }));
    }
    const rendered = renderRunIndexBlock(computeRunIndexProjection(projectRoot));
    expect(rendered).toContain('1 attempt-chain defect(s): 20260809-m1-r001-defect-run');
    expect(rendered).toContain('7 ledger-only run id(s) with no directory:');
    expect(rendered).not.toContain('+2 more');
    for (let index = 0; index < 7; index += 1) {
      expect(rendered).toContain(`20260701-m0-r00${index}-gone-run`);
    }
    expect(rendered).toContain('see `nullius current`');
  });

  it('a stray supersede renders its verb and a normalized --by target (the field case had both sides path-shaped)', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260811-m2-r412-rectangle');
    mkRun(projectRoot, '20260811-m2-r414-closure-audit');
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      schema_id: 'validity_event_v1', event_id: mintUlid(), ts_utc: new Date().toISOString(),
      event: 'supersede', run_id: 'artifacts/runs/20260811-m2-r412-rectangle',
      by_run_id: 'artifacts/runs/20260811-m2-r414-closure-audit',
      actor: 'test', reason: 'replaced by the closure audit',
    })}\n`);
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([
      {
        recorded_id: 'artifacts/runs/20260811-m2-r412-rectangle',
        verb: 'supersede',
        subject: '20260811-m2-r412-rectangle',
        by_run_id: '20260811-m2-r414-closure-audit',
        scope: null,
      },
    ]);
    const rendered = renderRunIndexBlock(projection);
    expect(rendered).toContain(
      '- supersede artifacts/runs/20260811-m2-r412-rectangle → nullius trace supersede '
      + '20260811-m2-r412-rectangle --by 20260811-m2-r414-closure-audit --reason',
    );
    // Both stray sides are covered by the ruling line — neither repeats
    // as a ghost, and no verb is ever invented for the --by reference.
    expect(projection.defects.ledger_only).toEqual([]);
    expect(rendered).not.toContain('nullius trace reinstate');
  });

  it('a healthy subject whose --by alone is path-shaped still gets its supersede re-issued (one-sided field case)', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260811-m2-r412-rectangle');
    mkRun(projectRoot, '20260811-m2-r414-closure-audit');
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      schema_id: 'validity_event_v1', event_id: mintUlid(), ts_utc: new Date().toISOString(),
      event: 'supersede', run_id: '20260811-m2-r412-rectangle',
      by_run_id: 'artifacts/runs/20260811-m2-r414-closure-audit',
      actor: 'test', reason: 'replaced by the closure audit',
    })}\n`);
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([
      {
        recorded_id: 'artifacts/runs/20260811-m2-r414-closure-audit',
        verb: 'supersede',
        subject: '20260811-m2-r412-rectangle',
        by_run_id: '20260811-m2-r414-closure-audit',
        scope: null,
      },
    ]);
    expect(projection.defects.ledger_only).toEqual([]);
    expect(renderRunIndexBlock(projection)).toContain(
      '→ nullius trace supersede 20260811-m2-r412-rectangle --by 20260811-m2-r414-closure-audit --reason',
    );
  });

  it('a scoped stray ruling re-issues with its --scope, never as a fabricated reinstate', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260811-m2-r420-budget-run');
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      schema_id: 'validity_event_v1', event_id: mintUlid(), ts_utc: new Date().toISOString(),
      event: 'void', run_id: 'artifacts/runs/20260811-m2-r420-budget-run',
      actor: 'test', reason: 'budget annotation only', scope: 'budget-only',
    })}\n`);
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([
      {
        recorded_id: 'artifacts/runs/20260811-m2-r420-budget-run',
        verb: 'void',
        subject: '20260811-m2-r420-budget-run',
        by_run_id: null,
        scope: 'budget-only',
      },
    ]);
    const rendered = renderRunIndexBlock(projection);
    expect(rendered).toContain('--scope budget-only --reason');
    expect(rendered).not.toContain('reinstate');
  });

  it('a stamp-only stray subject gets NO re-issue line — no ruling ever existed to re-issue', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260811-m2-r421-stamped-run');
    const strayId = 'artifacts/runs/20260811-m2-r421-stamped-run';
    const eventId = mintUlid();
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      schema_id: 'validity_event_v1', event_id: eventId, ts_utc: new Date().toISOString(),
      event: 'stamp', run_id: strayId, actor: 'test', reason: null,
      stamp: {
        schema_id: 'run_origin_v1', event_id: eventId, run_id: strayId,
        captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
        baseline_commit: null, no_repo_reason: 'fixture',
        dirty: { tracked_modified: 0, untracked_count: 0, untracked_sample: [] },
      },
    })}\n`);
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([]);
    expect(projection.defects.ledger_only).toEqual([strayId]);
    expect(renderRunIndexBlock(projection)).not.toContain('nullius trace');
  });

  it('a ruling already re-issued cleanly on the bare side suppresses its repair line and its ghost entry', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260810-m2-r378-replay');
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      schema_id: 'validity_event_v1', event_id: mintUlid(), ts_utc: new Date().toISOString(),
      event: 'void', run_id: 'artifacts/runs/20260810-m2-r378-replay', actor: 'test', reason: 'stray',
    })}\n`);
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '20260810-m2-r378-replay', actor: 'test', reason: 're-issued against the bare id',
    }));
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([]);
    expect(projection.defects.ledger_only).toEqual([]);
    expect(renderRunIndexBlock(projection)).not.toContain('Misaddressed');
  });

  it('path-shaped ledger ids render the misaddressed-verdicts repair list instead of posing as ghost runs', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260810-m2-r378-replay');
    // Historical stray lines predate the writer's path-shape backstop, so
    // the fixture appends raw JSONL exactly as an old CLI recorded it.
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify({
      schema_id: 'validity_event_v1', event_id: mintUlid(), ts_utc: new Date().toISOString(),
      event: 'void', run_id: 'artifacts/runs/20260810-m2-r378-replay', actor: 'test', reason: 'meant for the real run',
    })}\n`);
    // A genuine ghost (bare id, no directory) must stay in the plain
    // ledger-only list — the split must not swallow it.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: '20260701-m0-r001-gone-run', actor: 'test', reason: 'directory removed',
    }));
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([
      {
        recorded_id: 'artifacts/runs/20260810-m2-r378-replay',
        verb: 'void',
        subject: '20260810-m2-r378-replay',
        by_run_id: null,
        scope: null,
      },
    ]);
    const rendered = renderRunIndexBlock(projection);
    expect(rendered).toContain('Misaddressed rulings');
    // The repair line is a complete command up to --reason (codex r2):
    // verb and bare id spelled out, reason left to the operator.
    expect(rendered).toContain(
      '- void artifacts/runs/20260810-m2-r378-replay → nullius trace void 20260810-m2-r378-replay --reason',
    );
    expect(rendered).toContain('1 ledger-only run id(s) with no directory: 20260701-m0-r001-gone-run');
    // The stray void landed on the path string, not the run: the family
    // row must still show the real directory unclassified, not void.
    const family = projection.families.find(f => f.latest.run_id === '20260810-m2-r378-replay');
    expect(family?.latest.validity).toBe('unclassified');
  });

  it('hostile directory names cannot break the table, the link, or the block structure', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-a|b]c');
    mkRun(projectRoot, '20260809-m1-r002-space (x)');
    mkRun(projectRoot, '20260809-m1-r003-scan#2?q');
    mkRun(projectRoot, '20260809-m1-r004-x\n## boom');
    const rendered = renderRunIndexBlock(computeRunIndexProjection(projectRoot));
    // Structural characters are escaped in cells and labels…
    expect(rendered).toContain('a\\|b\\]c');
    // …the link target is percent-encoded, never raw — including the
    // reserved # and ? that encodeURI leaves alone…
    expect(rendered).toContain('%20');
    expect(rendered).toContain('%28x%29');
    expect(rendered).toContain('%232');
    expect(rendered).toContain('%3F');
    // …and a NEWLINE in a basename cannot fabricate a heading or marker
    // LINE (the char is replaced, so the text stays inside its cell):
    // nothing in the rendered block may start a line as a heading, or the
    // interior whitelist would demote the machine's own markers to strays.
    expect(rendered.split('\n').some(line => /^ {0,3}#/.test(line))).toBe(false);
    // Every table row still has exactly the 8 declared columns (9 pipes).
    for (const line of rendered.split('\n').filter(candidate => candidate.startsWith('| '))) {
      expect(line.match(/(?<!\\)\|/g)!.length).toBe(9);
    }
  });

  it('a mixed-EOL file keeps the replaced block in its own EOL flavor', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-mixed-eol');
    expect(refreshRunIndexBlock(projectRoot).action).toBe('rewritten');
    const indexPath = path.join(projectRoot, 'project_index.md');
    // The block stays LF; one stray CRLF line is appended elsewhere.
    fs.appendFileSync(indexPath, 'stray CRLF line\r\n');
    mkRun(projectRoot, '20260809-m1-r002-mixed-eol');
    expect(refreshRunIndexBlock(projectRoot).action).toBe('rewritten');
    const block = blockText(projectRoot);
    expect(block.includes('\r\n')).toBe(false);
    expect(checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot)).in_sync).toBe(true);
  });

  it('a retried run shows its attempt ordinal in the latest cell', () => {
    const projectRoot = makeProject();
    const runDir = mkRun(projectRoot, '20260809-m1-r001-retry-family');
    stampRunDirectory(projectRoot, runDir, { actor: 'test' });
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'computation', 'execution_status.json'),
      JSON.stringify({ status: 'failed', errors: ['boom'] }),
    );
    const retried = openRetryAttempt(projectRoot, runDir, { actor: 'test' });
    expect(retried.kind).toBe('retried');
    // The retry hook refreshed the block on its own.
    expect(blockText(projectRoot)).toContain('(attempt 2)');
  });
});

describe('refresh, hooks, and staleness', () => {
  it('a stamp refreshes the block automatically (no registry gate — the index shows every run)', () => {
    const projectRoot = makeProject();
    const runDir = mkRun(projectRoot, '20260809-m1-r001-auto-hook');
    stampRunDirectory(projectRoot, runDir, { actor: 'test' });
    expect(blockText(projectRoot)).toContain('20260809-m1-r001-auto-hook');
    expect(checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot)).in_sync).toBe(true);
  });

  it('dual-channel staleness: hand edits and state drift name different reasons', () => {
    const projectRoot = makeProject();
    const runDir = mkRun(projectRoot, '20260809-m1-r001-stale-probe');
    stampRunDirectory(projectRoot, runDir, { actor: 'test' });
    // Channel 1: hand edit inside the markers (digest line intact).
    const indexPath = path.join(projectRoot, 'project_index.md');
    fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf-8').replace('1 active', '9 active'));
    const handEdit = checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot));
    expect(handEdit.in_sync).toBe(false);
    expect(handEdit.reason).toContain('hand edit');
    // Repair, then channel 2: the STATE moves under an unrefreshed block.
    expect(refreshRunIndexBlock(projectRoot).action).toBe('rewritten');
    mkRun(projectRoot, '20260809-m1-r002-stale-probe');
    const drift = checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot));
    expect(drift.in_sync).toBe(false);
    expect(drift.reason).toContain('run/ledger state changed');
  });

  it('a CRLF project_index stays in sync (EOL-normalized compare, EOL-preserving splice)', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-crlf-run');
    const indexPath = path.join(projectRoot, 'project_index.md');
    fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf-8').replace(/\n/g, '\r\n'));
    expect(refreshRunIndexBlock(projectRoot).action).toBe('rewritten');
    const text = fs.readFileSync(indexPath, 'utf-8');
    expect(text.includes('\r\n')).toBe(true);
    expect(checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot)).in_sync).toBe(true);
  });

  it('insertion lands before PROJECT_INDEX_AUTO when the block is absent, at EOF otherwise', () => {
    const projectRoot = makeProject({ withIndexFile: false });
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
      '# Index', '',
      '<!-- PROJECT_INDEX_AUTO_START -->',
      '<!-- PROJECT_INDEX_AUTO_END -->', '',
      '## Notes (manual)', '',
    ].join('\n'));
    expect(refreshRunIndexBlock(projectRoot, { insertIfMissing: true }).action).toBe('inserted');
    const text = fs.readFileSync(path.join(projectRoot, 'project_index.md'), 'utf-8');
    expect(text.indexOf(RUN_INDEX_START)).toBeLessThan(text.indexOf('PROJECT_INDEX_AUTO_START'));

    const eofRoot = makeProject({ withIndexFile: false });
    fs.writeFileSync(path.join(eofRoot, 'project_index.md'), '# Bare index\n');
    expect(refreshRunIndexBlock(eofRoot, { insertIfMissing: true }).action).toBe('inserted');
    const eofText = fs.readFileSync(path.join(eofRoot, 'project_index.md'), 'utf-8');
    expect(eofText.trimEnd().endsWith(RUN_INDEX_END)).toBe(true);
  });

  it('without insertIfMissing a blockless file is a skip, and duplicated markers refuse', () => {
    const projectRoot = makeProject({ withIndexFile: false });
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), '# Bare\n');
    const skipped = refreshRunIndexBlock(projectRoot);
    expect(skipped.action).toBe('skipped');
    expect(skipped.reason).toContain('nullius index sync');
    fs.writeFileSync(
      path.join(projectRoot, 'project_index.md'),
      `# Bare\n\n${PLACEHOLDER_BLOCK}\n\n${PLACEHOLDER_BLOCK}\n`,
    );
    const duplicated = refreshRunIndexBlock(projectRoot);
    expect(duplicated.action).toBe('skipped');
    expect(duplicated.reason).toContain('duplicated');
  });

  it('the traceability view carries the block status and the prose warns when out of sync', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-view-probe');
    stampRunDirectory(
      projectRoot, path.join(projectRoot, 'artifacts', 'runs', '20260809-m1-r001-view-probe'), { actor: 'test' },
    );
    const view = buildTraceabilityView(projectRoot);
    expect(view.run_index.block_found).toBe(true);
    expect(view.run_index.in_sync).toBe(true);
    mkRun(projectRoot, '20260809-m1-r002-view-probe');
    const staleView = buildTraceabilityView(projectRoot);
    expect(staleView.run_index.in_sync).toBe(false);
    expect(renderTraceabilityProse(staleView)).toContain('RUN INDEX OUT OF SYNC');
  });

  it('missing project_index.md is an honest skip, never a throw', () => {
    const projectRoot = makeProject({ withIndexFile: false });
    const outcome = refreshRunIndexBlock(projectRoot, { insertIfMissing: true });
    expect(outcome.action).toBe('skipped');
    expect(outcome.reason).toContain('project_index.md not found');
    const status = checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot));
    expect(status.project_index_found).toBe(false);
  });

  it('a project without a git repository still indexes (unbound runs are honest, not errors)', () => {
    const projectRoot = makeProject({ git: false });
    mkRun(projectRoot, '20260809-m1-r001-no-repo');
    const outcome = refreshRunIndexBlock(projectRoot);
    expect(outcome.action).toBe('rewritten');
    expect(blockText(projectRoot)).toContain('1 unclassified');
  });

  it('hook-coverage lock: every surface that refreshes the notebook block also refreshes the index', () => {
    // Source-level on purpose (the pattern the notebook lock proved):
    // removing only the index half of a shared hook must go red here.
    const src = path.join(__dirname, '..', 'src');
    const read = (name: string): string => fs.readFileSync(path.join(src, name), 'utf-8');
    const runStamp = read('run-stamp.ts');
    expect(runStamp).toContain("import { refreshRunIndexBlock } from './run-index.js'");
    // Two call sites: the shared stamp writer AND the retry entrance.
    expect((runStamp.match(/refreshRunIndexBlock\(projectRoot, \{ insertIfMissing: false \}\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
    const cliTrace = read('cli-trace.ts');
    expect(cliTrace).toContain('refreshRunIndexBlock(projectRoot, { insertIfMissing: false })');
    expect(read('cli.ts')).toContain('refreshRunIndexBlock(projectRoot, { insertIfMissing: false })');
    // cli-init has TWO call sites (full init and --runtime-only); a single
    // substring check would stay green if one were deleted.
    const cliInit = read('cli-init.ts');
    const initCalls = cliInit.match(/refreshRunIndexBlock\(repoRoot, \{ insertIfMissing: false \}\)/g) ?? [];
    expect(initCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('the SHIPPED scaffold template block adopts as-is (locked against the real file, not a copy)', () => {
    const templatePath = path.join(
      __dirname, '..', '..', 'project-contracts', 'src', 'project_contracts', 'scaffold_templates', 'project_index.md',
    );
    const template = fs.readFileSync(templatePath, 'utf-8');
    expect(template).toContain(RUN_INDEX_START);
    const projectRoot = makeProject({ withIndexFile: false });
    fs.writeFileSync(path.join(projectRoot, 'project_index.md'), template);
    mkRun(projectRoot, '20260809-m1-r001-template-adopt');
    // The real placeholder must pass the interior whitelist: a freshly
    // scaffolded project's first refresh rewrites, never reports strays.
    const outcome = refreshRunIndexBlock(projectRoot, { insertIfMissing: false });
    expect(outcome.action).toBe('rewritten');
    const status = checkRunIndexBlock(projectRoot, computeRunIndexProjection(projectRoot));
    expect(status.in_sync).toBe(true);
  });

  it('void and result registration both refresh the block (behavioral, not just the source lock)', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-hooked';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    // The stamp hook already refreshed the placeholder block in passing.
    expect(blockText(projectRoot)).toContain(runId);
    // Register a current result THROUGH THE CLI: the hook must land ★.
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    const out: string[] = [];
    return runCli(
      ['result', 'set-current', 'headline', '--run', runId, '--artifact', `artifacts/runs/${runId}/value.json`],
      { cwd: projectRoot, stdout: (text: string) => out.push(text), stderr: (text: string) => out.push(text) },
    ).then((code) => {
      expect(code).toBe(0);
      expect(blockText(projectRoot)).toContain('★headline');
      // Void the run THROUGH THE CLI VERB: the hook must move the count.
      const io = { cwd: projectRoot, stdout: () => {}, stderr: () => {} };
      const exit = runTraceCommand(projectRoot, {
        action: 'void', target: runId, by: null, reason: 'behavioral hook test', scope: null,
        actor: 'test', eventId: null, recordOnly: false, deps: {},
      } as never, io);
      expect(exit).toBe(0);
      const block = blockText(projectRoot);
      expect(block).toMatch(/\| 1 \| 0 \| 0 \| 1 \| 0 \|/);
      // The star must not present a result on a VOID run as clean currency.
      expect(block).toContain('\u2605headline (DEFECTIVE)');
    });
  });

  it('a basename carrying a literal registry marker cannot forge a second marker (angle brackets escape)', async () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-ok';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    mkRun(projectRoot, '20260809-m1-r002-x<!-- RESULT_REGISTRY_START -->');
    expect(refreshRunIndexBlock(projectRoot, { insertIfMissing: false }).action).toBe('rewritten');
    // The genuine registry still parses (exactly one marker pair)…
    const registry = parseResultRegistry(projectRoot);
    expect(registry.block_found).toBe(true);
    // …and registration through the CLI still works on the same file.
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    const code = await runCli(
      ['result', 'set-current', 'headline', '--run', runId, '--artifact', `artifacts/runs/${runId}/value.json`],
      { cwd: projectRoot, stdout: () => {}, stderr: () => {} },
    );
    expect(code).toBe(0);
    expect(blockText(projectRoot)).toContain('★headline');
  });

  it('the projection never re-hashes registered artifacts (parse-only, revert-sensitive)', async () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-parse-only';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    const artifact = path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json');
    fs.writeFileSync(artifact, '{"v":1}\n');
    const code = await runCli(
      ['result', 'set-current', 'headline', '--run', runId, '--artifact', `artifacts/runs/${runId}/value.json`],
      { cwd: projectRoot, stdout: () => {}, stderr: () => {} },
    );
    expect(code).toBe(0);
    // Make the artifact unreadable: a validating (hashing) projection
    // would have to open these bytes; a parse-only one never touches them.
    // chmod cannot bar root: under uid 0 this control is vacuous, so skip.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    fs.chmodSync(artifact, 0o000);
    try {
      const projection = computeRunIndexProjection(projectRoot);
      expect(projection.families[0]!.current_results.map(entry => entry.result_id)).toContain('headline');
    } finally {
      fs.chmodSync(artifact, 0o644);
    }
  });

  it('the engine renders AFTER reading the carrier: a rival landing mid-refresh forces a re-render, never a stale replay', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-order');
    const carrier = path.join(projectRoot, 'project_index.md');
    let renders = 0;
    const outcome = refreshManagedBlock(
      carrier,
      () => {
        renders += 1;
        if (renders === 1) {
          // Simulate the rival: it lands AFTER our read (the engine read
          // the carrier before calling us), so the write guard must see
          // changed bytes and retry with a second, fresh render. Under
          // the reverted (render-before-read) ordering this mutation
          // happens BEFORE the read, no retry occurs, and renders
          // stays 1 — turning this control red.
          fs.appendFileSync(carrier, '\nrival line\n');
        }
        return [RUN_INDEX_START, '<!-- run-index-digest: ' + 'a'.repeat(64) + ' -->', `render ${renders}`, RUN_INDEX_END].join('\n');
      },
      {
        startMarker: RUN_INDEX_START,
        endMarker: RUN_INDEX_END,
        digestFirstLinePattern: /^ {0,3}<!--\s*run-index-digest:\s*[0-9a-f]{64}\s*--> *$/,
        blockNoun: 'run-index',
        syncCommand: '`nullius index sync`',
        fileLabel: 'project_index.md',
        carrierNoun: 'project_index.md',
        frontMatterPosition: false,
        stateChangedReason: 'run/ledger state changed since the block was written',
      },
      { insertIfMissing: false, missingBlockReason: 'unused', insertAt: () => 0 },
    );
    expect(outcome.action).toBe('rewritten');
    expect(renders).toBeGreaterThanOrEqual(2);
    const text = fs.readFileSync(carrier, 'utf-8');
    expect(text).toContain('rival line');
    expect(text).toContain(`render ${renders}`);
  });

  it('an ACTIVE but never-stamped run cannot star a clean current result (reinstate-only entry)', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-reinstate-only';
    mkRun(projectRoot, runId);
    // A ledger entry with validity active and stamped=false: only a
    // reinstate event, no stamp payload, hence no origin either — the
    // shape that slips past a binding-quality check alone.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'reinstate', run_id: runId, actor: 'test', reason: 'undo an earlier void',
    }));
    // A HAND-WRITTEN current row (set-current would refuse the unstamped
    // run; hand edits stay legal and must not read as clean currency).
    const indexPath = path.join(projectRoot, 'project_index.md');
    fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf-8').replace(
      '<!-- RESULT_REGISTRY_END -->',
      `| handrow | [x](artifacts/runs/${runId}/x.json) | ${'0'.repeat(64)} | ${runId} | none | none |\n<!-- RESULT_REGISTRY_END -->`,
    ));
    const projection = computeRunIndexProjection(projectRoot);
    const family = projection.families.find(candidate => candidate.current_results.length > 0)!;
    expect(family.current_results).toEqual([{ result_id: 'handrow', defective: true }]);
    expect(renderRunIndexBlock(projection)).toContain('★handrow (DEFECTIVE)');
  });

  it('a supplied projection is NEVER rendered — both consumers recompute on every attempt (revert-sensitive)', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-fresh-render';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    // A fabricated stale projection claiming an empty project: if either
    // consumer ever rendered a supplied projection, the block would claim
    // zero runs while one exists on disk.
    const fake = { ...computeRunIndexProjection(projectRoot) };
    fake.run_directories = 0;
    fake.families = [];
    const outcome = refreshRunIndexBlock(projectRoot, { insertIfMissing: false, projection: fake });
    // The stamp hook already wrote the REAL block, so an honest refresh is
    // a no-op; under the reverted semantics the fake would render
    // ('rewritten' into an empty-state block that loses the run id).
    expect(outcome.action).toBe('unchanged');
    expect(blockText(projectRoot)).toContain(runId);
    // Same rule for the notebook consumer: a fake projection with a row
    // must not render — the real (empty) registry state must.
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# Notebook', '',
      '<!-- NOTEBOOK_CURRENT_STATE_START -->',
      '(placeholder)',
      '<!-- NOTEBOOK_CURRENT_STATE_END -->', '',
    ].join('\n'));
    const fakeNotebook = {
      registry_block_found: true,
      current_rows: [{
        result_id: 'phantom', run_id: runId, effective_commit: 'a'.repeat(12),
        has_snapshot: false, artifact: null, defective: false,
      }],
      total_rows: 1,
      issue_codes: [],
    };
    const notebookOutcome = refreshNotebookCurrentState(projectRoot, {
      insertIfMissing: false,
      projection: fakeNotebook,
    });
    expect(notebookOutcome.action).toBe('rewritten');
    const notebook = fs.readFileSync(path.join(projectRoot, 'research_notebook.md'), 'utf-8');
    expect(notebook).not.toContain('phantom');
  });

  it('a CURRENT row naming a run with NO directory renders in the defects footer (never a silent lost star)', async () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-move-away';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    const code = await runCli(
      ['result', 'set-current', 'headline', '--run', runId, '--artifact', `artifacts/runs/${runId}/value.json`],
      { cwd: projectRoot, stdout: () => {}, stderr: () => {} },
    );
    expect(code).toBe(0);
    fs.renameSync(
      path.join(projectRoot, 'artifacts', 'runs', runId),
      path.join(projectRoot, `parked-${runId}`),
    );
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.registry_only_current).toEqual([`headline (run ${runId})`]);
    expect(renderRunIndexBlock(projection)).toContain('CURRENT result(s) naming a run with no directory');
  });

  it('the registry WRITER refuses angle brackets in cells (marker-forgery parity with the renderer)', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-writer-guard';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    expect(() => setCurrentResult(projectRoot, {
      resultId: 'headline',
      runId,
      artifactRelPath: `artifacts/runs/${runId}/value.json`,
      description: 'x<!-- RESULT_REGISTRY_END -->',
    })).toThrow(/<!--/);
  });

  it('a broken supersession chain marks its stars defective (parse-level, parity with the validator)', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-chain-break';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    setCurrentResult(projectRoot, {
      resultId: 'v2', runId, artifactRelPath: `artifacts/runs/${runId}/value.json`,
    });
    // Hand-break the chain: v2 claims to supersede v1, but no v1 row
    // records the back direction (one-directional relation).
    const indexPath = path.join(projectRoot, 'project_index.md');
    const text = fs.readFileSync(indexPath, 'utf-8');
    const mangled = text.replace('| `none` | `none` |', '| `v1` | `none` |');
    expect(mangled).not.toBe(text);
    fs.writeFileSync(indexPath, mangled);
    const projection = computeRunIndexProjection(projectRoot);
    const starred = projection.families[0]!.current_results[0]!;
    expect(starred.result_id).toBe('v2');
    expect(starred.defective).toBe(true);
    const validated = validateResultRegistry(projectRoot, readValidityLedger(projectRoot));
    expect(validated.defective_result_ids.has('v2')).toBe(true);
  });

  it('inequality prose in a description stays registrable; only comment delimiters refuse', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-chi2';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    const { row } = setCurrentResult(projectRoot, {
      resultId: 'fitq', runId, artifactRelPath: `artifacts/runs/${runId}/value.json`,
      description: 'fit quality χ²/dof < 1 across the scan',
    });
    expect(row.result_id).toBe('fitq');
  });

  it('a head_plus_untracked binding renders its star QUALIFIED — ★id (+untracked), not unqualified', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-untracked-star';
    mkRun(projectRoot, runId);
    // An untracked stray at capture time: the binding grade every other
    // current-result surface qualifies.
    fs.writeFileSync(path.join(projectRoot, 'helper.py'), 'h = 1\n');
    stampRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    setCurrentResult(projectRoot, {
      resultId: 'headline', runId, artifactRelPath: `artifacts/runs/${runId}/value.json`,
    });
    const projection = computeRunIndexProjection(projectRoot);
    const starred = projection.families[0]!.current_results[0]!;
    expect(starred).toMatchObject({ result_id: 'headline', defective: false, untracked: true });
    expect(renderRunIndexBlock(projection)).toContain('★headline (+untracked)');
  });

  it('star and validator agree on the no-IO defect rule (parity control)', () => {
    const projectRoot = makeProject();
    const runId = '20260809-m1-r001-parity';
    mkRun(projectRoot, runId);
    stampRun(projectRoot, runId);
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'value.json'), '{"v":1}\n');
    setCurrentResult(projectRoot, {
      resultId: 'headline', runId, artifactRelPath: `artifacts/runs/${runId}/value.json`,
    });
    // Hand-edit the row's commit cell to a wrong sha: a pure row↔stamp
    // fidelity defect (no artifact IO involved).
    const indexPath = path.join(projectRoot, 'project_index.md');
    const text = fs.readFileSync(indexPath, 'utf-8');
    const mangled = text.replace(/ @ [0-9a-f]{12}/, ' @ deadbeefdead');
    expect(mangled).not.toBe(text);
    fs.writeFileSync(indexPath, mangled);
    const projection = computeRunIndexProjection(projectRoot);
    const starred = projection.families[0]!.current_results[0]!;
    expect(starred.defective).toBe(true);
    const validated = validateResultRegistry(projectRoot, readValidityLedger(projectRoot));
    expect(validated.defective_result_ids.has('headline')).toBe(true);
  });

  it('ledger reads are shared, not repeated: a supplied view is used as-is', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-shared-view');
    const ledger = readValidityLedger(projectRoot);
    const projection = computeRunIndexProjection(projectRoot, ledger);
    expect(projection.run_directories).toBe(1);
  });
});

describe('misaddressed-verdict rendering treats historical ledger ids as untrusted input (codex r1)', () => {
  it('control characters and marker text in a stray id cannot inject lines into the managed block', () => {
    const projectRoot = makeProject();
    const hostileBare = '20260810-m2-r378-replay\nINJECTED LINE <!-- RUN_INDEX_END -->';
    const ledgerPath = path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    // Two historical stray lines predating the writer's backstops: one BARE
    // hostile id (so the ledger KNOWS the bare form) and one path-shaped id
    // that strips to it. The second condition is what routes the entry into
    // the misaddressed-verdicts repair list — the render path under test.
    // A fixture whose bare form is unknown would classify as a plain ghost
    // and pass on the already-escaped list even with the defect present
    // (native-seat r1: the lock must go red on the defective renderer).
    // The bare stray uses a DIFFERENT verb, so the clean-reissue
    // suppression cannot swallow the void's repair line.
    for (const [eventName, runId] of [
      ['reinstate', hostileBare],
      ['void', `artifacts/runs/${hostileBare}`],
    ] as const) {
      fs.appendFileSync(ledgerPath, `${JSON.stringify({
        schema_id: 'validity_event_v1', event_id: mintUlid(), ts_utc: new Date().toISOString(),
        event: eventName, run_id: runId, actor: 'test', reason: 'hostile id',
      })}\n`);
    }
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.defects.misaddressed_rulings).toEqual([
      {
        recorded_id: `artifacts/runs/${hostileBare}`,
        verb: 'void',
        subject: hostileBare,
        by_run_id: null,
        scope: null,
      },
    ]);
    const rendered = renderRunIndexBlock(projection);
    // The subject falls outside the shell-safe charset, so the line
    // degrades to a pointer instead of a paste-mangled command…
    expect(rendered).toContain('unsafe for a copy-paste command');
    expect(rendered).not.toContain(`nullius trace void ${hostileBare}`);
    // …the newline is neutralized (no line starts with the injected text)
    // and the angle-bracket escaping means exactly ONE line in the block is
    // the real end marker — the injected copy cannot terminate the block.
    const renderedLines = rendered.split('\n');
    expect(renderedLines.some(line => line.startsWith('INJECTED LINE'))).toBe(false);
    expect(renderedLines.filter(line => line.trim() === RUN_INDEX_END)).toHaveLength(1);
    expect(rendered.trim().endsWith(RUN_INDEX_END)).toBe(true);
  });
});
