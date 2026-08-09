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
import { setCurrentResult } from '../src/result-registry.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';
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
    commitAll(projectRoot);
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
  return projectRoot;
}

function mkRun(projectRoot: string, runId: string): string {
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
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
    expect(dstar.current_result_ids).toEqual(['headline']);

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

  it('an unstamped-only family orders its latest by run id (date-prefixed convention)', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260801-m1-r001-legacy-chain');
    mkRun(projectRoot, '20260805-m1-r002-legacy-chain');
    const projection = computeRunIndexProjection(projectRoot);
    expect(projection.families[0]!.latest.run_id).toBe('20260805-m1-r002-legacy-chain');
    expect(projection.families[0]!.latest.validity).toBe('unclassified');
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
    // Seven ledger-only ids: the footer caps at 5 and says how many more.
    for (let index = 0; index < 7; index += 1) {
      appendValidityEvent(projectRoot, buildValidityEvent({
        event: 'void', run_id: `20260701-m0-r00${index}-gone-run`, actor: 'test', reason: 'directory removed',
      }));
    }
    const rendered = renderRunIndexBlock(computeRunIndexProjection(projectRoot));
    expect(rendered).toContain('1 attempt-chain defect(s): 20260809-m1-r001-defect-run');
    expect(rendered).toContain('7 ledger-only run id(s) with no directory:');
    expect(rendered).toContain('+2 more');
    expect(rendered).toContain('see `nullius current`');
  });

  it('hostile directory names cannot break the table or the link (markdown escaping)', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-a|b]c');
    mkRun(projectRoot, '20260809-m1-r002-space (x)');
    const rendered = renderRunIndexBlock(computeRunIndexProjection(projectRoot));
    // Structural characters are escaped in cells and labels…
    expect(rendered).toContain('a\\|b\\]c');
    // …and the link target is percent-encoded, never raw.
    expect(rendered).toContain('%20');
    expect(rendered).toContain('%28x%29');
    // Every table row still has exactly the 8 declared columns (9 pipes).
    for (const line of rendered.split('\n').filter(candidate => candidate.startsWith('| '))) {
      expect(line.split('\n')[0]!.match(/(?<!\\)\|/g)!.length).toBe(9);
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
    expect(read('cli-init.ts')).toContain('refreshRunIndexBlock(repoRoot, { insertIfMissing: false })');
  });

  it('ledger reads are shared, not repeated: a supplied view is used as-is', () => {
    const projectRoot = makeProject();
    mkRun(projectRoot, '20260809-m1-r001-shared-view');
    const ledger = readValidityLedger(projectRoot);
    const projection = computeRunIndexProjection(projectRoot, ledger);
    expect(projection.run_directories).toBe(1);
  });
});
