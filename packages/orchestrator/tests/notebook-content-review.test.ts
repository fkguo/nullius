import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { parseCliArgs } from '../src/cli-args.js';
import { buildTraceabilityView } from '../src/traceability-view.js';
import { checkNotebookContentReview, freezeNotebookReviewScope, notebookReviewSections } from '../src/notebook-content-review.js';
import { notebookCloseoutGate } from '../src/notebook-result-links.js';
import { StateManager } from '../src/state-manager.js';
import { handleOrchRunRequestFinalConclusions } from '../src/orch-tools/final-conclusions.js';
import { createRunArtifactRef } from '../src/computation/artifact-refs.js';
import { assessNotebookRequestCapacity } from '../src/notebook-review-batches.js';
import * as runtime from '../src/cli-runtime.js';

// Deterministic transport/contract fixtures. This executable supplies no
// scientific judgment; actual semantic controls are separate real model runs.
const transport = String.raw`#!/usr/bin/env python3
import hashlib, json, os, re, sys, time
from pathlib import Path
packet = sys.stdin.read()
root = Path(os.environ['NOTEBOOK_CONTRACT_ROOT'])
embedded = re.search(r'^=== ADDITIONAL CONTEXT: (.+/notebook-scope.json) ===$', packet, re.M)
scope_path = Path(embedded.group(1)) if embedded else max(root.glob('artifacts/runs/*/inputs/notebook-scope.json'), key=lambda p: p.stat().st_mtime_ns)
scope = json.loads(scope_path.read_text())
case = os.environ.get('NOTEBOOK_CONTRACT_CASE', 'complete')
if case == 'deadline-sleep': time.sleep(30)
source = (root / scope['notebook']['path']).read_text()
lines = source.split('\n')
def anchor(text, lo, hi):
    pieces = text.split('\n')
    nonblank = [i for i in range(lo, hi + 1) if pieces[i - 1].replace('\ufeff', '').strip()]
    if not nonblank: return []
    line = nonblank[0]
    return [{'start_line': line, 'end_line': line, 'quote': pieces[line - 1]}]
def section_anchor(s):
    body = s['start_line'] if s['heading'] == '(front matter)' else s['start_line'] + len(s['heading'].split('\n'))
    if case in ('heading-only', 'heading-range'): body = s['start_line']
    if not any(line.replace('\ufeff', '').strip() for line in lines[body - 1:s['end_line']]): body = s['start_line']
    return anchor(source, body, s['end_line'])
sections = [{'section_id': s['section_id'], 'status': 'complete', 'anchors': section_anchor(s), 'reasoning': 'Deterministic coverage fixture; no semantic inference.'} for s in scope['sections']]
if case == 'heading-range':
    for item, s in zip(sections, scope['sections']): item['anchors'][0]['end_line'] = s['end_line']
deps = [{'path': d['path'], 'sha256': d['sha256'], 'anchors': anchor((root / d['path']).read_text(), 1, len((root / d['path']).read_text().split('\n'))), 'reasoning': 'Deterministic dependency fixture.'} for d in scope['dependencies']]
report = {'schema_version': 1, 'review_kind': 'notebook', 'scope_sha256': hashlib.sha256(scope_path.read_bytes()).hexdigest(), 'verdict': 'PASS', 'summary': 'Deterministic contract fixture, not semantic evidence.', 'coverage_status': 'complete', 'dependency_closure': 'complete', 'missing_dependencies': [], 'blocking_issues': [], 'cross_section_reasoning': 'Deterministic transport assertion only.', 'sections': sections, 'dependencies': deps}
report['opaque_sources'] = [{'path': item['path'], 'sha256': item['sha256'], 'required_for_reasoning': case == 'opaque-required', 'reasoning': 'Controlled locator assessment; no claim of reading raw content.'} for item in scope.get('opaque_links', [])]
if case == 'opaque-missing': report['opaque_sources'] = []
if case == 'partial': report['sections'] = sections[:-1]
if case == 'dependency-gap': report['dependencies'] = []
if case == 'navigation-required':
    report['missing_dependencies'] = ['The derivation behind the navigation link is required.']
    report['dependency_closure'] = 'incomplete'
    report['coverage_status'] = 'incomplete'
    report['verdict'] = 'FAIL'
if case == 'wrong-anchor': report['sections'][0]['anchors'][0]['quote'] = 'absent source bytes'
if case == 'empty-anchors': report['sections'][0]['anchors'] = []
if case == 'duplicate': report['sections'].append(sections[0])
if case == 'blocked-pass': report['blocking_issues'] = ['a blocking defect']
if case == 'refused':
    report['verdict'] = 'FAIL'
    report['sections'][-1]['status'] = 'incomplete'
    report['blocking_issues'] = ['a deterministic defect']
    report['summary'] = 'A deterministic content defect, despite full reading coverage.'
if case == 'complete-fail':
    report['verdict'] = 'FAIL'
    report['blocking_issues'] = ['A controlled transport rejection, not scientific inference.']
if case == 'held-pass':
    (root / '.nullius/controlled-older-ready').write_text('ready')
    while not (root / '.nullius/controlled-older-release').exists(): time.sleep(0.025)
if case == 'mutation': (root / 'research_notebook.md').write_text(source + '\nChanged while reviewer executes.\n')
if Path(sys.argv[0]).name == 'codex':
    Path(sys.argv[sys.argv.index('-o') + 1]).write_text(json.dumps(report))
    print('Deterministic transport only.', flush=True)
    sys.exit(0)
print(json.dumps({'type': 'system', 'subtype': 'init', 'model': 'contract-fixture-only'}), flush=True)
if case == 'compacted': print(json.dumps({'type': 'system', 'subtype': 'compact_boundary'}), flush=True)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': 'contract-fixture', 'result': json.dumps(report)}), flush=True)
if case == 'nonzero': sys.exit(1)
`;

let root: string;
let scaffoldNotebook: string;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const notebook = '# Notebook\n\nA bounded question.\n\n## Premises\n\nAll variables are finite real values.\nSee [premises](dependencies/premises.md).\n\n### Reasoning\n\nStarting relation and intermediate reasoning are recorded here.\n\n## Limits\n\nThe stated scope excludes undefined operations.\n';
async function cli(args: string[]) {
  let stdout = ''; let stderr = '';
  const code = await runCli(args, { cwd: root, stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout, stderr, value: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null };
}
function write(relative: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), data);
}
function pointer() { return JSON.parse(fs.readFileSync(path.join(root, '.nullius/notebook-review.json'), 'utf8')); }
function runDir() { return path.join(root, 'artifacts/runs', pointer().run_id); }
async function review(caseName = 'complete') {
  vi.stubEnv('NOTEBOOK_CONTRACT_CASE', caseName);
  return cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--timeout-secs', '20', '--json']);
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-review-contract-')));
  expect((await cli(['init', '--mode', 'file'])).code).toBe(0);
  scaffoldNotebook = fs.readFileSync(path.join(root, 'research_notebook.md'), 'utf8');
  write('research_notebook.md', notebook);
  write('dependencies/premises.md', '# Premises\n\nFinite real variables.\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('add', '.');
  write('test-bin/claude', transport); fs.chmodSync(path.join(root, 'test-bin/claude'), 0o755);
  write('test-bin/codex', transport); fs.chmodSync(path.join(root, 'test-bin/codex'), 0o755);
  vi.stubEnv('PATH', path.join(root, 'test-bin') + path.delimiter + process.env.PATH);
  vi.stubEnv('NOTEBOOK_CONTRACT_ROOT', root);
}, 30000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('whole-notebook execution and current-version contract', () => {
  it('reviews the actual scaffold without following index navigation into its own review run', async () => {
    write('research_notebook.md', scaffoldNotebook);
    const result = await review();
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const scope = JSON.parse(fs.readFileSync(path.join(runDir(), 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.navigation_links).toContainEqual({ source: 'research_notebook.md', destination: 'project_index.md#main-research-report' });
    expect(scope.dependencies.map((d: any) => d.path)).not.toContain('project_index.md');
    const before = fs.readFileSync(path.join(root, 'project_index.md'), 'utf8');
    write('artifacts/runs/unrelated-navigation/summary.json', '{}\n');
    expect((await cli(['index', 'sync'])).code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'project_index.md'), 'utf8')).not.toBe(before);
    expect(checkNotebookContentReview(root).status).toBe('accepted');
  });

  it('keeps ordinary cross-run evidence recursive and stale when an original input changes', async () => {
    write('research_notebook.md', '# Notebook\n\n[Stage result](artifacts/runs/stage/report.md).\n');
    write('artifacts/runs/stage/report.md', '# Result\n\n[Input](../original/input.md) supports this result.\n');
    write('artifacts/runs/original/input.md', '# Input\n\nOriginal scientific premise.\n');
    expect((await review()).code).toBe(0);
    write('artifacts/runs/original/input.md', '# Input\n\nChanged premise.\n');
    expect(checkNotebookContentReview(root).status).toBe('stale');
  });

  it('freezes a mixed-use target and reference links while images cannot declare themselves navigation', () => {
    write('research_notebook.md', '# Notebook\n\n[Index][index]. [Route](route.md "nullius-navigation").\n\n[Evidence](route.md). ![Data](data.txt "nullius-navigation").\n\n[index]: project_index.md "nullius-navigation"\n');
    write('route.md', '# Evidence\n\n[Nested](nested.md).\n'); write('nested.md', 'Original dependency.\n'); write('data.txt', 'Image target bytes.\n');
    const scope = freezeNotebookReviewScope(root, 'mixed-links', path.join(root, 'artifacts/runs/mixed-links'), []);
    expect(scope.navigation_links).toEqual([{ source: 'research_notebook.md', destination: 'project_index.md' }, { source: 'research_notebook.md', destination: 'route.md' }]);
    expect(scope.dependencies.map(d => d.path)).toEqual(['route.md', 'data.txt', 'nested.md']);
  });

  it('freezes explicit dependencies even when they are linked only for navigation', async () => {
    write('research_notebook.md', '# Notebook\n\n[Route](route.md "nullius-navigation").\n');
    write('route.md', '# Evidence\n\n[Nested](nested.md).\n'); write('nested.md', 'Original dependency.\n');
    const result = await cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--dependency', 'route.md', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    write('nested.md', 'Changed original dependency.\n');
    expect(checkNotebookContentReview(root).status).toBe('stale');
  });

  it('refuses an omitted scientific premise despite its navigation title', async () => {
    write('research_notebook.md', '# Notebook\n\nThe needed derivation is in [the route](route.md "nullius-navigation").\n');
    write('route.md', '# Original\n\nA required derivation.\n');
    const result = await review('navigation-required');
    expect(result.code).not.toBe(0);
    expect(checkNotebookContentReview(root).status).toBe('incomplete');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  });

  it.each(['missing.md', '../outside.md'])('does not hide invalid navigation destinations: %s', async target => {
    write('research_notebook.md', `# Notebook\n\n[Navigation](${target} "nullius-navigation").\n`);
    expect((await review()).code).not.toBe(0);
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
  });

  it('retains historical failed capacity as unavailable after runtime authority recovers', async () => {
    // Lookups 1 and 2 locate the origin-capture storage check and the reviewer launcher; later lookups are capacity assessment.
    const originalRuntime = runtime.installedRuntimeRoot; let calls = 0;
    const spy = vi.spyOn(runtime, 'installedRuntimeRoot').mockImplementation(() => { if (++calls > 2) throw new Error('fixture runtime unavailable during capacity assessment'); return originalRuntime(); });
    const first = await review(); expect(first.code).toBe(2); const canonical = path.join(runDir(), 'artifacts/verification_subject_verdict_notebook_v1.json'); const bytes = fs.readFileSync(canonical); expect(JSON.parse(bytes.toString()).status).toBe('failed'); spy.mockRestore();
    // Only the capacity-assessment runtime lookup wraps the thrown text in this form; a failure moved to another phase would not.
    const capacityFailure = 'Installed review-swarm runtime is unavailable: fixture runtime unavailable during capacity assessment';
    expect(first.value.reason).toBe(capacityFailure); expect(JSON.parse(bytes.toString())).toMatchObject({ summary: capacityFailure, missing_decisive_checks: [{ check_kind: 'notebook_content_review', reason: capacityFailure }] });
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable' }); expect(checkNotebookContentReview(root).reason).toContain('immutable canonical outcome');
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(2); expect(notebookCloseoutGate(root).decision).toBe('unavailable'); expect(fs.readFileSync(canonical)).toEqual(bytes);
  });

  it('enforces the delegated single-call seat deadline on an actual sleeping runner', async () => {
    vi.stubEnv('NOTEBOOK_CONTRACT_CASE', 'deadline-sleep'); const started = Date.now();
    const result = await cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--timeout-secs', '1', '--json']);
    expect(result.code).toBe(2); expect(result.value.status).toBe('unavailable'); expect(Date.now() - started).toBeLessThan(10000);
    const trace = fs.readFileSync(path.join(runDir(), 'review/trace.jsonl'), 'utf8'); expect(trace).toContain('"timed_out": true'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 15000);
  it('keeps missing direct runtime authority unavailable without rewriting historical acceptance', async () => {
    expect((await review()).code).toBe(0); const canonical = path.join(runDir(), 'artifacts/verification_subject_verdict_notebook_v1.json'); const original = fs.readFileSync(canonical);
    vi.spyOn(runtime, 'installedRuntimeRoot').mockImplementation(() => { throw new Error('fixture runtime unavailable'); });
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable' }); expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
    expect(notebookCloseoutGate(root).decision).toBe('unavailable'); expect(fs.readFileSync(canonical)).toEqual(original);
  });

  it('bounds capacity by the complete persisted actual system and packet request bytes', async () => {
    expect((await review()).code).toBe(0); const id = pointer().run_id; const dir = runDir(); const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'review_execution.json'), 'utf8'));
    const file = (ref: any) => path.join(dir, decodeURIComponent(ref.uri.split('/artifact/')[1])); const manifest = JSON.parse(fs.readFileSync(file(receipt.manifest_ref), 'utf8'));
    const requestBytes = manifest.file_inputs.filter((i: any) => i.kind === 'persisted_review_input').reduce((n: number, i: any) => n + fs.readFileSync(i.path).length, 0);
    const binding = { report: receipt.report_ref, meta: receipt.meta_ref, manifest: receipt.manifest_ref };
    const evidence: any = assessNotebookRequestCapacity(dir, id, receipt.captured_refs, [receipt.scope_ref], 200000, binding);
    expect(evidence.persisted_request_bytes).toBe(requestBytes); expect(evidence.conservative_input_token_upper_bound).toBe(requestBytes + 8192);
    expect(() => assessNotebookRequestCapacity(dir, id, receipt.captured_refs, [receipt.scope_ref], requestBytes + 8192 + 32768 - 1, binding)).toThrow('capacity policy');
  });

  it('keeps linked bare CR text pending and refuses explicit bare CR dependencies', async () => {
    write('research_notebook.md', notebook + '\n[Unsupported text](linked.txt)\n'); write('linked.txt', 'Original UTF-8 text\rA linked assumption.\r');
    const linked = await review(); expect(linked.code).toBe(2); expect(linked.value).toMatchObject({ status: 'unavailable', progress: { closure_complete: false } });
    expect(linked.value.progress.pending_sources).toContain('linked.txt'); expect(linked.value.reason).toContain('bare CR');
    const explicit = await cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--dependency', 'linked.txt', '--json']);
    expect(explicit.code).toBe(2); expect(explicit.value.reason).toContain('LF or CRLF'); expect(checkNotebookContentReview(root).status).toBe('unavailable');
  });
  it('uses one model with a positive hard budget and never accepts an import-PASS option', () => {
    expect(parseCliArgs(['notebook', 'review', '--model', 'claude/fixture', '--dependency', 'a.md'])).toMatchObject({ action: 'review', dependencies: ['a.md'], timeoutSecs: 1200 });
    for (const args of [['review'], ['review', '--model', 'a,b'], ['review', '--model', 'a', '--timeout-secs', '0'], ['review', '--model', 'a', '--import-pass', 'out.json'], ['review', '--model', 'a', '--result', 'x'], ['sync', '--structure-only']]) {
      expect(() => parseCliArgs(['notebook', ...args])).toThrow();
    }
  });

  it('keeps ordinary read models available and distinguishes missing review from structure', async () => {
    expect(checkNotebookContentReview(root).status).toBe('missing');
    expect(notebookCloseoutGate(root).decision).toBe('hold');
    expect((await cli(['status', '--json'])).code).toBe(0);
    expect(buildTraceabilityView(root).notebook.content_review.status).toBe('missing');
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(1);
    const nav = await cli(['notebook', 'check', '--structure-only', '--json']);
    expect(nav).toMatchObject({ code: 0, value: { status: 'structure_passed', content_review: { status: 'missing' } } });
  });

  it('accepts executed full coverage and rechecks uncommitted bytes at every public read', async () => {
    const launched = await review();
    expect(launched.code, launched.stdout + launched.stderr).toBe(0);
    expect(launched.value.status).toBe('accepted');
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(0);
    expect(buildTraceabilityView(root).notebook.content_review.status).toBe('accepted');
    expect(notebookCloseoutGate(root).decision).toBe('pass');
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const evidence = fs.readFileSync(path.join(runDir(), 'review_execution.json'));
    write('research_notebook.md', notebook.replace('finite real values', 'positive integers'));
    expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head);
    expect(checkNotebookContentReview(root).status).toBe('stale');
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(1);
    expect((await cli(['status', '--json'])).code).toBe(0);
    expect(notebookCloseoutGate(root).decision).toBe('hold');
    expect(fs.readFileSync(path.join(runDir(), 'review_execution.json'))).toEqual(evidence);
  });

  it('preserves a UTF-8 byte-order mark in notebook and dependency anchors', async () => {
    write('research_notebook.md', '\ufeff' + notebook);
    write('dependencies/premises.md', '\ufeff# Premises\n\nFinite real variables.\n');
    const result = await review();
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const scope = JSON.parse(fs.readFileSync(path.join(runDir(), 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.sections[0].heading.startsWith('\ufeff')).toBe(true);
    expect(fs.readFileSync(path.join(runDir(), 'inputs/source-0.txt')).subarray(0, 3).toString('hex')).toBe('efbbbf');
    expect(checkNotebookContentReview(root).status).toBe('accepted');
  });

  it.each(['\n', '\ufeff\n\n'])('keeps whitespace-only prefix coverage without requiring a nonexistent quote: %j', async prefix => {
    write('research_notebook.md', prefix + notebook);
    const outcome = await review();
    expect(outcome.code, outcome.stdout + outcome.stderr).toBe(0);
    const scope = JSON.parse(fs.readFileSync(path.join(runDir(), 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.sections[0]).toMatchObject({ heading: '(front matter)', start_line: 1 });
    expect(outcome.value).toMatchObject({ status: 'accepted', sections_total: 5, sections_reviewed: 5 });
  });

  it('keeps concurrent executed reviews without inventing setup failures or clearing another writer marker', async () => {
    const outcomes = await Promise.all([review(), review()]);
    expect(outcomes.some(result => result.code === 0), JSON.stringify(outcomes)).toBe(true);
    const dirs = fs.readdirSync(path.join(root, 'artifacts/runs')).filter(name => name.includes('-notebook-review-'));
    expect(dirs).toHaveLength(2);
    for (const name of dirs) {
      expect(fs.existsSync(path.join(root, 'artifacts/runs', name, 'review_execution.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'artifacts/runs', name, 'review_setup_attempt.json'))).toBe(false);
    }
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    expect(fs.existsSync(path.join(root, '.nullius/notebook-review-pending.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'artifacts/notebook-review-control.lock'))).toBe(false);
  });

  it('never lets an older late PASS replace a newer executed rejection', async () => {
    const older = review('held-pass');
    let newerId = ''; let priorPointer: Buffer | undefined; let result: Awaited<ReturnType<typeof review>>;
    try {
      for (let i = 0; i < 250 && !fs.existsSync(path.join(root, '.nullius/controlled-older-ready')); i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.existsSync(path.join(root, '.nullius/controlled-older-ready'))).toBe(true);
      expect(checkNotebookContentReview(root).status).toBe('unavailable');
      expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
      expect((await review('complete-fail')).code).toBe(1);
      expect(checkNotebookContentReview(root).status).toBe('rejected');
      newerId = pointer().run_id; priorPointer = fs.readFileSync(path.join(root, '.nullius/notebook-review.json'));
    } finally { write('.nullius/controlled-older-release', 'release'); result = await older; }
    expect(result!.code).toBe(1);
    expect(pointer().run_id).toBe(newerId);
    expect(fs.readFileSync(path.join(root, '.nullius/notebook-review.json'))).toEqual(priorPointer);
    expect(checkNotebookContentReview(root).status).toBe('rejected');
  });

  it('keeps a newer admitted control failure unavailable after an older execution finishes', async () => {
    expect((await review()).code).toBe(0);
    const older = review('held-pass');
    let newerId = ''; let result: Awaited<ReturnType<typeof review>>;
    try {
      for (let i = 0; i < 250 && !fs.existsSync(path.join(root, '.nullius/controlled-older-ready')); i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.existsSync(path.join(root, '.nullius/controlled-older-ready'))).toBe(true);
      const rename = fsDefault.renameSync;
      fsDefault.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === path.join(root, '.nullius/notebook-review.json') || String(to) === path.join(root, '.nullius/notebook-review-pending.json')) throw Object.assign(new Error('controlled overlapping control failure'), { code: 'EACCES' });
        return rename(from, to);
      }) as typeof fsDefault.renameSync;
      syncBuiltinESMExports();
      try {
        const newer = await cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--dependency', 'absent.md', '--timeout-secs', '20', '--json']);
        expect(newer.code).toBe(2); newerId = newer.value.run_id;
      } finally { fsDefault.renameSync = rename; syncBuiltinESMExports(); }
      expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', run_id: newerId });
    } finally { write('.nullius/controlled-older-release', 'release'); result = await older; }
    expect(result!.code).toBe(2);
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', run_id: newerId });
    expect(notebookCloseoutGate(root).decision).toBe('unavailable');
  });

  it('ignores foreign start filenames and reports malformed managed starts as unavailable', async () => {
    expect((await review()).code).toBe(0);
    write('artifacts/runs/foreign/review_started.json', '{');
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    const invalid = 'artifacts/runs/20000101T000000-notebook-review-acde0001/review_started.json';
    write(invalid, '{');
    expect(checkNotebookContentReview(root).status).toBe('unavailable');
    expect((await cli(['status', '--json'])).code).toBe(0);
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
    expect(fs.readFileSync(path.join(root, invalid), 'utf8')).toBe('{');
  });

  it('refuses missing or duplicate admission order instead of treating new evidence as old history', async () => {
    expect((await review()).code).toBe(0);
    const firstDir = runDir(); const first = JSON.parse(fs.readFileSync(path.join(firstDir, 'review_started.json'), 'utf8'));
    expect(first.schema_version).toBe(2);
    expect((await review()).code).toBe(0);
    const filename = path.join(runDir(), 'review_started.json');
    const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const missing = { ...current }; delete missing.admission_sequence;
    fs.writeFileSync(filename, JSON.stringify(missing));
    expect(checkNotebookContentReview(root).status).toBe('unavailable');
    fs.writeFileSync(filename, JSON.stringify({ ...current, admission_sequence: first.admission_sequence }));
    expect(checkNotebookContentReview(root).status).toBe('unavailable');
    fs.writeFileSync(filename, JSON.stringify({ ...current, schema_version: 1 }));
    expect(checkNotebookContentReview(root).status).toBe('unavailable');
  });

  it('never leaves a partial admitted start when atomic publication fails', async () => {
    expect((await review()).code).toBe(0);
    const rename = fsDefault.renameSync;
    fsDefault.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith('/review_started.json')) throw Object.assign(new Error('controlled failed start publication'), { code: 'EIO' });
      return rename(from, to);
    }) as typeof fsDefault.renameSync;
    syncBuiltinESMExports();
    try {
      const outcome = await review();
      expect(outcome.code).toBe(2);
      const names = fs.readdirSync(path.join(root, 'artifacts/runs', outcome.value.run_id));
      expect(names.filter(name => name.includes('review_started'))).toEqual([]);
      expect(checkNotebookContentReview(root).status).toBe('accepted');
    } finally { fsDefault.renameSync = rename; syncBuiltinESMExports(); }
  });

  it('does not normalize away automatic blocks, dependencies, deletion or redirection', async () => {
    expect((await review()).code).toBe(0);
    const dependency = fs.readFileSync(path.join(root, 'dependencies/premises.md'));
    write('dependencies/premises.md', '# Changed premises\n');
    expect(checkNotebookContentReview(root).status).toBe('stale');
    write('dependencies/premises.md', dependency);
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    fs.unlinkSync(path.join(root, 'dependencies/premises.md'));
    expect(checkNotebookContentReview(root).status).toBe('stale');
    write('dependencies/redirected.md', dependency);
    fs.symlinkSync('redirected.md', path.join(root, 'dependencies/premises.md'));
    expect(checkNotebookContentReview(root).status).toBe('stale');
    fs.unlinkSync(path.join(root, 'dependencies/premises.md')); write('dependencies/premises.md', dependency);
    expect((await cli(['notebook', 'sync'])).code).toBe(0);
    expect(checkNotebookContentReview(root).status).toBe('stale');
  });

  it.each(['partial', 'dependency-gap', 'wrong-anchor', 'empty-anchors', 'heading-only', 'heading-range', 'duplicate', 'blocked-pass', 'nonzero', 'mutation', 'refused'])('refuses a %s delivery through the real launcher boundary', async caseName => {
    const result = await review(caseName);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    if (caseName === 'refused') expect(checkNotebookContentReview(root)).toMatchObject({ status: 'rejected', sections_reviewed: 4, reason: 'A deterministic content defect, despite full reading coverage.' });
    if (caseName === 'mutation') expect(checkNotebookContentReview(root).status).toBe('stale');
    expect((await cli(['current', '--json'])).code).toBe(0);
  });

  it('rejects hand-written PASS and evidence tampering instead of inheriting a prior pass', async () => {
    write('.nullius/notebook-review.json', JSON.stringify({ schema_version: 1, verdict: 'PASS', status: 'accepted' }));
    expect(checkNotebookContentReview(root).status).toBe('rejected');
    expect((await review()).code).toBe(0);
    // Discover the actual executed output via its hashed receipt, not filename conventions.
    const execution = JSON.parse(fs.readFileSync(path.join(runDir(), 'review_execution.json'), 'utf8'));
    const out = JSON.parse(fs.readFileSync(path.join(runDir(), 'review/meta.json'), 'utf8')).agents[0].out;
    expect(execution.report_ref.sha256).toBe(digest(fs.readFileSync(out)));
    fs.appendFileSync(out, '\n{"verdict":"PASS"}\n');
    expect(checkNotebookContentReview(root).status).toBe('rejected');
  });

  it('reports unsupported reviewer tool mode as unavailable even with a bound transport report', async () => {
    expect((await review()).code).toBe(0);
    const current = pointer(); const directory = runDir();
    const load = (relative: string) => JSON.parse(fs.readFileSync(path.join(directory, relative), 'utf8'));
    const save = (relative: string, value: unknown, kind: string) => {
      fs.writeFileSync(path.join(directory, relative), JSON.stringify(value));
      return createRunArtifactRef(current.run_id, directory, path.join(directory, relative), kind);
    };
    // Construct a hash-consistent unsupported-mode fixture. This is a
    // transport classification check, not an authenticated reviewer claim.
    const meta = load('review/meta.json'); meta.agents[0].execution_tool_mode = 'workspace';
    meta.independence.non_independent_lanes = [{ reason: 'tool_policy_contaminated' }];
    const metaRef = save('review/meta.json', meta, 'review_metadata');
    const execution = load('review_execution.json'); execution.meta_ref = metaRef;
    execution.captured_refs = execution.captured_refs.map((ref: any) => ref.uri === metaRef.uri ? { ...metaRef, kind: ref.kind } : ref);
    const executionRef = save('review_execution.json', execution, 'review_execution');
    const check = load('artifacts/verification_check_run_notebook_v1.json');
    check.evidence_refs = [executionRef]; check.status = 'failed';
    const checkRef = save('artifacts/verification_check_run_notebook_v1.json', check, 'verification_check_run');
    const verdict = load('artifacts/verification_subject_verdict_notebook_v1.json'); verdict.check_run_refs = [checkRef]; verdict.status = 'failed';
    const verdictRef = save('artifacts/verification_subject_verdict_notebook_v1.json', verdict, 'verification_subject_verdict');
    const coverage = load('artifacts/verification_coverage_notebook_v1.json'); coverage.subject_verdict_refs = [verdictRef];
    coverage.summary.subjects_verified = 0; coverage.summary.subjects_failed = 1;
    const coverageRef = save('artifacts/verification_coverage_notebook_v1.json', coverage, 'verification_coverage');
    Object.assign(current.verification_refs, { check_run_refs: [checkRef], subject_verdict_refs: [verdictRef], coverage_refs: [coverageRef] });
    write('.nullius/notebook-review.json', JSON.stringify(current));
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', reason: 'Whole-notebook review currently requires reviewer tool mode none.' });
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
    expect((await cli(['status', '--json'])).code).toBe(0);
    expect(notebookCloseoutGate(root).decision).toBe('unavailable');
  });

  it('writes failed canonical evidence when an executed PASS uses an unsupported tool mode', async () => {
    const result = await cli(['notebook', 'review', '--model', 'codex/contract-fixture', '--timeout-secs', '20', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(2);
    expect(result.value.status).toBe('unavailable');
    const meta = JSON.parse(fs.readFileSync(path.join(runDir(), 'review/meta.json'), 'utf8'));
    expect(meta.agents[0]).toMatchObject({ success: true, contract_ok: true, execution_tool_mode: 'review' });
    expect(JSON.parse(fs.readFileSync(meta.agents[0].out, 'utf8')).verdict).toBe('PASS');
    expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'artifacts/verification_subject_verdict_notebook_v1.json'), 'utf8')).status).toBe('failed');
    expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'artifacts/verification_coverage_notebook_v1.json'), 'utf8')).summary).toMatchObject({ subjects_verified: 0, subjects_failed: 1 });
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
  });

  it('keeps historical runs immutable when a new version is reviewed', async () => {
    expect((await review()).code).toBe(0);
    const oldDir = runDir(); const oldReceipt = fs.readFileSync(path.join(oldDir, 'review_execution.json'));
    write('research_notebook.md', notebook + '\nMore explicit limits.\n');
    expect(checkNotebookContentReview(root).status).toBe('stale');
    expect((await review()).code).toBe(0);
    expect(runDir()).not.toBe(oldDir);
    expect(fs.readFileSync(path.join(oldDir, 'review_execution.json'))).toEqual(oldReceipt);
  });

  it('does not retain cached acceptance when a new explicit dependency cannot be reviewed', async () => {
    expect((await review()).code).toBe(0);
    const oldDir = runDir(); const oldReceipt = fs.readFileSync(path.join(oldDir, 'review_execution.json'));
    const result = await cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--dependency', 'missing-premise.md', '--timeout-secs', '20', '--json']);
    expect(result.code).toBe(2);
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', run_id: result.value.run_id, previous_run_id: path.basename(oldDir) });
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    expect(fs.readFileSync(path.join(oldDir, 'review_execution.json'))).toEqual(oldReceipt);
  });

  it.each(['current', 'all-control', 'all-write'])('blocks old acceptance when %s pointers cannot record setup failure', async fault => {
    expect((await review()).code).toBe(0);
    const pointerPath = path.join(root, '.nullius/notebook-review.json');
    const priorBytes = fs.readFileSync(pointerPath); const priorId = pointer().run_id;
    const rename = fsDefault.renameSync;
    const open = fsDefault.openSync;
    fsDefault.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === pointerPath || (fault === 'all-control' && String(to) === path.join(root, '.nullius/notebook-review-pending.json'))) throw Object.assign(new Error('controlled locked pointer'), { code: 'EACCES' });
      return rename(from, to);
    }) as typeof fsDefault.renameSync;
    fsDefault.openSync = ((file: fs.PathLike, flags: fs.OpenMode, ...args: any[]) => {
      if (fault === 'all-write' && String(file).startsWith(path.join(root, '.nullius') + path.sep) && String(flags).includes('w')) throw Object.assign(new Error('controlled unwritable control directory'), { code: 'EACCES' });
      return (open as any)(file, flags, ...args);
    }) as typeof fsDefault.openSync;
    syncBuiltinESMExports();
    try {
      const result = await cli(['notebook', 'review', '--model', 'claude/contract-fixture', '--dependency', 'absent.md', '--timeout-secs', '20', '--json']);
      expect(result.code).toBe(2);
      expect(fs.readFileSync(pointerPath)).toEqual(priorBytes);
      expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', run_id: result.value.run_id, previous_run_id: priorId });
      expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
      expect(notebookCloseoutGate(root).decision).toBe('unavailable');
    } finally { fsDefault.renameSync = rename; fsDefault.openSync = open; syncBuiltinESMExports(); }
  });

  it('rechecks both notebook gates after a historical A5 approval', async () => {
    const manager = new StateManager(root); manager.ensureDirs();
    const state = manager.readState(); state.run_id = 'historical-approval'; state.gate_satisfied.A5 = 'A5-historical'; manager.saveState(state);
    let response = await handleOrchRunRequestFinalConclusions({ project_root: root, run_id: state.run_id }) as any;
    expect(response).toMatchObject({ status: 'not_ready', ready_for_final_conclusions: false });
    expect((await review()).code).toBe(0);
    response = await handleOrchRunRequestFinalConclusions({ project_root: root, run_id: state.run_id }) as any;
    expect(response).toMatchObject({ status: 'already_approved', ready_for_final_conclusions: true });
    write('research_notebook.md', notebook + '\nChanged conclusion.\n');
    response = await handleOrchRunRequestFinalConclusions({ project_root: root, run_id: state.run_id }) as any;
    expect(response).toMatchObject({ status: 'not_ready', ready_for_final_conclusions: false });
    expect(manager.readState().gate_satisfied.A5).toBe('A5-historical');
  });

  it('does not let content acceptance replace adopted-result navigation at engine closeout', async () => {
    const run = 'navigation-case'; const directory = path.join(root, 'artifacts/runs', run);
    write(`artifacts/runs/${run}/answer.md`, '# Answer\n\nA bounded result.\n');
    expect((await cli(['trace', 'stamp', directory])).code).toBe(0);
    expect((await cli(['result', 'set-current', 'answer', '--run', run, '--artifact', `artifacts/runs/${run}/answer.md`])).code).toBe(0);
    expect((await review()).code).toBe(0);
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    expect(notebookCloseoutGate(root).decision).toBe('hold');
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(1);
    const manager = new StateManager(root); manager.ensureDirs();
    const state = manager.readState(); state.run_id = run; state.gate_satisfied.A5 = 'A5-historical'; manager.saveState(state);
    const response = await handleOrchRunRequestFinalConclusions({ project_root: root, run_id: run }) as any;
    expect(response).toMatchObject({ status: 'not_ready', ready_for_final_conclusions: false });
  });

  it('does not let result selection reduce the semantic scope', async () => {
    expect((await review()).code).toBe(0);
    const result = await cli(['notebook', 'check', '--result', 'unknown', '--json']);
    expect(result.code).toBe(2);
    expect(result.value.content_review.sections_total).toBe(4);
    expect(result.value.acceptance_scope).toContain('always whole-notebook');
  });

  it('refuses missing, binary, invalid-UTF8 and escaping inputs without a reviewer invocation', async () => {
    for (const data of [Buffer.from([0xff]), Buffer.from('binary\0input'), Buffer.from('# Notebook\r\r## Reasoning\rA step.\r'), Buffer.from('# Notebook\n[missing](dependencies/missing.md)\n'), Buffer.from('# Notebook\n[escape](../../outside.md)\n')]) {
      write('research_notebook.md', data);
      expect((await review()).code).toBe(2);
      expect(checkNotebookContentReview(root).status).not.toBe('accepted');
      const runs = fs.readdirSync(path.join(root, 'artifacts/runs'));
      expect(runs.some(run => fs.existsSync(path.join(root, 'artifacts/runs', run, 'review/meta.json')))).toBe(false);
    }
  });

  it('partitions every line, including front matter, nested headings, code, comments and Setext', () => {
    const text = 'preface\n<!-- comments -->\n# Top\n```md\n## Example heading\n```\n### Nested\nA step\n\nSetext\n------\nA conclusion\n';
    const sections = notebookReviewSections(text);
    expect(sections.map(s => s.heading)).toEqual(['(front matter)', '# Top', '### Nested', 'Setext\n------']);
    expect(sections.flatMap(s => Array.from({ length: s.end_line - s.start_line + 1 }, (_, index) => s.start_line + index))).toEqual(Array.from({ length: text.split('\n').length }, (_, index) => index + 1));
    write('research_notebook.md', text);
    const frozen = freezeNotebookReviewScope(root, 'scope-test', path.join(root, 'artifacts/runs/scope-test'), []);
    expect(frozen.notebook.sha256).toBe(digest(Buffer.from(text)));
    expect(fs.readFileSync(path.join(root, 'artifacts/runs/scope-test/inputs/source-0.txt'), 'utf8')).toBe(text);
  });

  it('binds a binary image as an unread locator without preventing textual review', async () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
    write('figures/decoration.png', raw); write('research_notebook.md', notebook + '\n![Decoration](figures/decoration.png)\n');
    const result = await review(); expect(result.code, result.stdout).toBe(0);
    const scope = JSON.parse(fs.readFileSync(path.join(runDir(), 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.dependencies).toHaveLength(1);
    expect(scope.opaque_links).toMatchObject([{ path: 'figures/decoration.png', sha256: digest(raw) }]);
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir(), 'review/inputs/review_input_manifest.json'), 'utf8'));
    expect(manifest.file_inputs.some((input: any) => input.kind === 'opaque_locator' && input.sha256 === digest(raw))).toBe(true);
    const packet = fs.readFileSync(path.join(runDir(), 'review/inputs/packet.md'), 'utf8');
    expect(packet).not.toContain(raw.toString('utf8'));
    write('figures/decoration.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    expect(checkNotebookContentReview(root).status).toBe('stale');
  });

  it('uses the same content identity through a project-root path alias', async () => {
    expect((await review()).code).toBe(0);
    const alias = root + '-alias';
    fs.symlinkSync(root, alias, 'dir');
    try { expect(checkNotebookContentReview(alias).status).toBe('accepted'); }
    finally { fs.unlinkSync(alias); }
  });

  it('keeps intact relocated evidence readable without granting current acceptance', async () => {
    expect((await review()).code).toBe(0);
    const original = root; const receipt = fs.readFileSync(path.join(runDir(), 'review_execution.json'));
    const prior = pointer(); const moved = root + '-relocated';
    fs.renameSync(root, moved); root = moved;
    try {
      expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', run_id: prior.run_id, sections_reviewed: 4 });
      expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
      expect((await cli(['status', '--json'])).code).toBe(0);
      expect(fs.readFileSync(path.join(runDir(), 'review_execution.json'))).toEqual(receipt);
      expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'artifacts/verification_subject_verdict_notebook_v1.json'), 'utf8')).status).toBe('verified');
    } finally { fs.renameSync(moved, original); root = original; }
  });

  it.each(['opaque-required', 'opaque-missing'])('refuses an %s source assessment', async caseName => {
    write('figures/source.png', Buffer.from([0x89, 0, 0xff]));
    write('research_notebook.md', notebook + '\n[Source](figures/source.png)\n');
    const result = await review(caseName);
    expect(result.code).not.toBe(0);
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
  });

  it('refuses a direct request whose token capacity is unverified', async () => {
    write('research_notebook.md', notebook + '\n' + 'Complete original explanatory body.\n'.repeat(1500));
    const result = await cli(['notebook', 'review', '--model', 'claude/fixture', '--context-bytes', '500000', '--context-tokens', '50000', '--timeout-secs', '20', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(2); expect(result.value.status).toBe('unavailable');
    expect(result.value.reason).toContain('token capacity'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    expect(JSON.parse(fs.readFileSync(path.join(runDir(), 'artifacts/verification_subject_verdict_notebook_v1.json'), 'utf8')).status).toBe('failed');
  });

  it('refuses direct reviewer context compaction even after a complete delivery', async () => {
    const result = await review('compacted');
    expect(result.code, result.stdout + result.stderr).toBe(2); expect(result.value.status).toBe('unavailable');
    expect(result.value.reason).toContain('compacted'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    expect((await cli(['notebook', 'check', '--json'])).code).not.toBe(0);
  });

  it('rejects authored capacity receipts even after the entire project artifact graph is rehashed', async () => {
    expect((await review()).code).toBe(0);
    const id = pointer().run_id; const dir = runDir();
    const load = (ref: any) => JSON.parse(fs.readFileSync(path.join(dir, decodeURIComponent(ref.uri.split('/artifact/')[1])), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'review_execution.json'), 'utf8'));
    const meta = load(receipt.meta_ref); const manifest = load(receipt.manifest_ref);
    const reportPath = path.join(dir, decodeURIComponent(receipt.report_ref.uri.split('/artifact/')[1]));
    const fakeDir = path.join(dir, 'authored-capacity'); fs.mkdirSync(fakeDir);
    const budgetPath = path.join(fakeDir, 'budget.json');
    fs.writeFileSync(budgetPath, JSON.stringify({ status: 'completed', runner_exit_code: 0,
      input_sha256: manifest.file_inputs.filter((i: any) => i.kind === 'persisted_review_input').map((i: any) => i.sha256),
      attempts: [{ status: 'exited', exit_code: 0 }] }));
    const resultPath = path.join(fakeDir, 'fake.events.result.json');
    fs.writeFileSync(resultPath, JSON.stringify({ type: 'result', is_error: false,
      result: fs.readFileSync(reportPath, 'utf8'), usage: { input_tokens: 1, output_tokens: 1 } }));
    meta.agents[0].capture_receipt = budgetPath;
    fs.writeFileSync(path.join(dir, decodeURIComponent(receipt.meta_ref.uri.split('/artifact/')[1])), JSON.stringify(meta));
    receipt.captured_refs.push(...[budgetPath, resultPath].map(file => createRunArtifactRef(id, dir, file, 'authored_capacity_negative')));
    fs.writeFileSync(path.join(dir, 'review_execution.json'), JSON.stringify(receipt));
    const done = new Set<string>(); const active = new Set<string>();
    function rehash(file: string) {
      if (done.has(file)) return;
      if (active.has(file)) throw new Error('unexpected artifact reference cycle');
      active.add(file);
      let value: any;
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { active.delete(file); done.add(file); return; }
      let changed = false;
      function walk(v: any) {
        if (!v || typeof v !== 'object') return;
        if (typeof v.uri === 'string' && v.uri.startsWith('rep://runs/') && v.sha256) {
          const match = /^rep:\/\/runs\/([^/]+)\/artifact\/(.*)$/.exec(v.uri);
          if (match) {
            const target = path.join(root, 'artifacts/runs', match[1]!, decodeURIComponent(match[2]!));
            rehash(target); const bytes = fs.readFileSync(target); const sha = digest(bytes);
            if (v.sha256 !== sha || v.size_bytes !== bytes.length) { v.sha256 = sha; v.size_bytes = bytes.length; changed = true; }
          }
        }
        Object.values(v).forEach(walk);
      }
      walk(value);
      if (changed) fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
      active.delete(file); done.add(file);
    }
    for (const file of [path.join(dir, 'review_execution.json'), ...fs.readdirSync(path.join(dir, 'artifacts')).map(name => path.join(dir, 'artifacts', name)), path.join(root, '.nullius/notebook-review.json')]) rehash(file);
    const rebound = JSON.parse(fs.readFileSync(path.join(dir, 'review_execution.json'), 'utf8'));
    expect(() => assessNotebookRequestCapacity(dir, id, rebound.captured_refs,
      [rebound.scope_ref], 41000, { report: rebound.report_ref, meta: rebound.meta_ref, manifest: rebound.manifest_ref })).toThrow('runtime observation');
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(buildTraceabilityView(root).notebook.content_review.status).not.toBe('accepted');
    expect((await cli(['notebook', 'check', '--json'])).code).not.toBe(0);
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    const manager = new StateManager(root); const state = manager.readState();
    state.run_id = id; state.gate_satisfied.A5 = 'historical-private-fixture';
    fs.writeFileSync(manager.statePath, JSON.stringify(state));
    expect((await handleOrchRunRequestFinalConclusions({ project_root: root, run_id: id })).ready_for_final_conclusions).toBe(false);
  });
});
