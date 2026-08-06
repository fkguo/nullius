import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintUlid } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent } from '../src/validity-ledger.js';
import {
  parseResultRegistry,
  setCurrentResult,
  validateResultRegistry,
} from '../src/result-registry.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';
import { runInitCommand } from '../src/cli-init.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-stage2-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
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
function writeRegistryBlock(): void {
  fs.writeFileSync(path.join(projectRoot, 'project_index.md'), [
    '<!-- RESULT_REGISTRY_START -->',
    '| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |',
    '|---|---|---|---|---|---|',
    '<!-- RESULT_REGISTRY_END -->',
    '',
  ].join('\n'));
}
function stampedRun(runId: string): void {
  fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', runId), { recursive: true });
  const id = mintUlid();
  const head = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  appendValidityEvent(projectRoot, buildValidityEvent({
    event: 'stamp', run_id: runId, actor: 't', reason: null, event_id: id,
    stamp: {
      schema_id: 'run_origin_v1', event_id: id, run_id: runId,
      captured_at_utc: '2026-08-01T00:00:00Z', binding_quality: 'exact_clean',
      baseline_commit: head, snapshot_tree: null,
      dirty: { tracked_modified: 0, untracked_count: 0 },
    } as ValidityEventV1['stamp'],
  }));
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd: projectRoot, stdout: (t: string) => { out.push(t); }, stderr: (t: string) => { err.push(t); }, out, err };
};

describe('result registry (stage 2)', () => {
  it('set-current registers a row, maintains both directions on supersession, and validates green', () => {
    initRepo(projectRoot);
    writeRegistryBlock();
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot);
    stampedRun('run-1');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'value.json'), '{"x":1}');
    setCurrentResult(projectRoot, { resultId: 'the-result', runId: 'run-1', artifactRelPath: 'artifacts/runs/run-1/value.json' });
    let state = validateResultRegistry(projectRoot);
    expect(state.current.map(row => row.result_id)).toEqual(['the-result']);
    expect(state.issues).toEqual([]);

    stampedRun('run-2');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-2', 'value.json'), '{"x":2}');
    setCurrentResult(projectRoot, {
      resultId: 'the-result-v2', runId: 'run-2',
      artifactRelPath: 'artifacts/runs/run-2/value.json', supersedes: 'the-result',
    });
    state = validateResultRegistry(projectRoot);
    expect(state.current.map(row => row.result_id)).toEqual(['the-result-v2']);
    const old = state.rows.find(row => row.result_id === 'the-result');
    expect(old?.superseded_by).toBe('the-result-v2');
    expect(state.issues).toEqual([]);
  });

  it('flags mutated artifacts, broken chains, and non-active runs', () => {
    initRepo(projectRoot);
    writeRegistryBlock();
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot);
    stampedRun('run-1');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'value.json'), '{"x":1}');
    setCurrentResult(projectRoot, { resultId: 'the-result', runId: 'run-1', artifactRelPath: 'artifacts/runs/run-1/value.json' });
    // Mutate the artifact after registration.
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'value.json'), '{"x":999}');
    // Void the named run.
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: 'run-1', actor: 't', reason: 'result withdrawn',
    }));
    const state = validateResultRegistry(projectRoot);
    const codes = state.issues.map(entry => entry.code);
    expect(codes).toContain('result_artifact_mutated');
    expect(codes).toContain('result_run_not_active');
  });

  it('refuses set-current for unstamped or non-active runs and unknown supersedes', () => {
    initRepo(projectRoot);
    writeRegistryBlock();
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'bare-run'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'bare-run', 'v.json'), '{}');
    expect(() => setCurrentResult(projectRoot, {
      resultId: 'r', runId: 'bare-run', artifactRelPath: 'artifacts/runs/bare-run/v.json',
    })).toThrow(/origin stamp/);
    stampedRun('voided-run');
    appendValidityEvent(projectRoot, buildValidityEvent({
      event: 'void', run_id: 'voided-run', actor: 't', reason: 'wrong',
    }));
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'voided-run', 'v.json'), '{}');
    expect(() => setCurrentResult(projectRoot, {
      resultId: 'r', runId: 'voided-run', artifactRelPath: 'artifacts/runs/voided-run/v.json',
    })).toThrow(/void/);
    stampedRun('good-run');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'good-run', 'v.json'), '{}');
    expect(() => setCurrentResult(projectRoot, {
      resultId: 'r', runId: 'good-run', artifactRelPath: 'artifacts/runs/good-run/v.json',
      supersedes: 'ghost',
    })).toThrow(/not a registered result id/);
  });

  it('renders current results in the prose and reports empty/missing registry honestly', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot);
    // No block at all → unanswerable names the missing block.
    let view = buildTraceabilityView(projectRoot);
    expect(view.results.block_found).toBe(false);
    expect(view.unanswerable.some(u => u.reason.includes('RESULT_REGISTRY'))).toBe(true);
    // Block present but empty → unanswerable names emptiness.
    writeRegistryBlock();
    view = buildTraceabilityView(projectRoot);
    expect(view.results.block_found).toBe(true);
    expect(view.unanswerable.some(u => u.reason.includes('empty'))).toBe(true);
    // A registered result renders in the prose.
    stampedRun('run-1');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'value.json'), '{"x":1}');
    setCurrentResult(projectRoot, { resultId: 'the-result', runId: 'run-1', artifactRelPath: 'artifacts/runs/run-1/value.json' });
    view = buildTraceabilityView(projectRoot);
    expect(view.results.current).toHaveLength(1);
    const prose = renderTraceabilityProse(view);
    expect(prose).toContain('the-result: run run-1 @ ');
    expect(prose).not.toContain('Unanswerable: the current-results registry is empty');
  });
});

describe('init git bootstrap (stage 2, D7)', () => {
  it('bootstraps a repository with a scaffold-only initial commit on full init', async () => {
    const stdio = io();
    await runInitCommand(projectRoot, projectRoot, [], stdio);
    const log = execFileSync('git', ['-C', projectRoot, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log).toContain('nullius project scaffold');
    expect(log.trim().split('\n')).toHaveLength(1);
    // Pre-existing/user files stay untracked (explicit decision).
    const tracked = execFileSync('git', ['-C', projectRoot, 'ls-files'], { encoding: 'utf-8' });
    expect(tracked).toContain('project_index.md');
    expect(tracked).not.toContain('.nullius/');
    expect(stdio.out.join('')).toContain('initialized a git repository');
  });

  it('--no-git records the decline and the traceability surface reports it every time', async () => {
    const stdio = io();
    await runInitCommand(projectRoot, projectRoot, ['--no-git'], stdio);
    expect(fs.existsSync(path.join(projectRoot, '.git'))).toBe(false);
    expect(stdio.out.join('')).toContain('git bootstrap declined');
    const ledger = fs.readFileSync(path.join(projectRoot, '.nullius', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('git_bootstrap_declined');
    const view = buildTraceabilityView(projectRoot);
    expect(view.unanswerable.some(u => u.clause === 'exact code revision')).toBe(true);
  });

  it('runtime-only checks presence and suggests without creating anything', async () => {
    const stdio = io();
    await runInitCommand(projectRoot, projectRoot, ['--runtime-only'], stdio);
    expect(fs.existsSync(path.join(projectRoot, '.git'))).toBe(false);
    expect(stdio.out.join('')).toContain('not a git repository');
  });

  it('an existing repository is left untouched', async () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'pre.txt'), 'x');
    commitAll(projectRoot);
    const before = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const stdio = io();
    await runInitCommand(projectRoot, projectRoot, [], stdio);
    const after = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    expect(after).toBe(before);
    expect(stdio.out.join('')).not.toContain('initialized a git repository');
  });
});

describe('writer-side schema gate carried into stage 2 flows', () => {
  it('set-current path never appends: only trace verbs write the ledger', () => {
    initRepo(projectRoot);
    writeRegistryBlock();
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    commitAll(projectRoot);
    stampedRun('run-1');
    fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'run-1', 'value.json'), '{}');
    const ledgerBefore = fs.readFileSync(path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl'), 'utf-8');
    setCurrentResult(projectRoot, { resultId: 'r', runId: 'run-1', artifactRelPath: 'artifacts/runs/run-1/value.json' });
    const ledgerAfter = fs.readFileSync(path.join(projectRoot, 'artifacts', 'runs', 'validity_ledger.jsonl'), 'utf-8');
    expect(ledgerAfter).toBe(ledgerBefore);
  });
});
