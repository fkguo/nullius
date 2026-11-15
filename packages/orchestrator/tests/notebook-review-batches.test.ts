import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as runtime from '../src/cli-runtime.js';
import { runCli } from '../src/cli.js';
import { checkNotebookContentReview, freezeNotebookReviewScope } from '../src/notebook-content-review.js';
import { assessNotebookBatches, executeNotebookBatches, materialIdentity, notebookBudgets, partitionNotebookSources } from '../src/notebook-review-batches.js';
import { notebookCloseoutGate } from '../src/notebook-result-links.js';
import { buildValidityEvent } from '../src/validity-ledger.js';

// This executable is deliberately a transport oracle. It performs no semantic
// judgment; real model positive/negative controls are separate recorded runs.
const transport = String.raw`#!/usr/bin/env python3
import hashlib,json,os,re,sys
from pathlib import Path
packet=sys.stdin.read();root=Path(os.environ['BATCH_TEST_ROOT'])
p=Path(re.search(r'^=== ADDITIONAL CONTEXT: (.+/inventory.json) ===$',packet,re.M).group(1))
inv=json.loads(p.read_text());case=os.environ.get('BATCH_TEST_CASE','complete')
base={'schema_version':1,'review_kind':inv['review_kind'],'inventory_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'verdict':'PASS','summary':'Deterministic transport result only.','coverage_status':'complete','blocking_issues':[],'missing_dependencies':[]}
if inv['review_kind']=='notebook_batch':
    if case=='interrupt-second' and inv['units'][0]['unit_id']=='source-1':
        import time
        (root/'second-batch-started.json').write_text(json.dumps({'pid':os.getpid()}))
        time.sleep(120)
    units=[]
    for u in inv['units']:
        data=(root/u['path']).read_bytes()[u['start_byte']:u['end_byte']]
        text=data.decode('utf-8');body=data[u['body_start_byte']-u['start_byte']:].decode('utf-8')
        line=next((line for line in body.splitlines() if line.strip().strip('\ufeff') and not line.startswith('#')),body)
        a={'path':u['path'],'quote':line}
        if case=='title-substring':a={'path':u['path'],'quote':'Title'}
        c={'path':u['path'],'quote':body if case=='cross-wide' else line}
        units.append({'unit_id':u['unit_id'],'status':'complete','reasoning':'Transport fixture coverage; no scientific claim.','anchors':[a] if text.strip().strip('\ufeff') else [],'cross_context':[c] if text.strip().strip('\ufeff') else []})
        if case=='late-rejected' and 'FINAL DEFECT' in text:base['verdict']='FAIL';base['blocking_issues']=['Controlled late defect.']
    base['units']=[] if case=='omit-unit' else units
    if case=='mutate-during':
        q=root/'research_notebook.md';q.write_bytes(q.read_bytes()+b'\nChanged during review.\n')
else:
    coverage=[]
    for u in inv['units']:
        data=(root/u['path']).read_bytes()[u['start_byte']:u['end_byte']]
        body_offset=u['body_start_byte']-u['start_byte'];body=data[body_offset:].decode('utf-8')
        line=next((line for line in body.splitlines() if line.strip().strip('\ufeff') and not line.startswith('#')),body)
        quote=line.encode('utf-8');start=u['start_byte']+data.find(quote,body_offset)
        anchors=[{'path':u['path'],'start_byte':start,'end_byte':start+len(quote),'quote':line}] if data.decode('utf-8').strip().strip('\ufeff') else []
        if case=='joint-unanchored':anchors=[]
        if case=='joint-wrong-bytes' and anchors:anchors[0]['quote']='This is not an original source quotation.'
        entry={'unit_id':u['unit_id'],'reasoning':'Joint original full interval transport only.','anchors':anchors}
        if case=='joint-legacy':entry.pop('anchors')
        coverage.append(entry)
    base.update({'original_unit_coverage':coverage, 'dependency_closure':'complete','opaque_sources':[], 'cross_section_reasoning':'Deterministic joint coverage transport only.'})
    if case=='cross-conflict':base['verdict']='FAIL';base['blocking_issues']=['Controlled cross-section conflict.']
    if case=='omit-cross':base['original_unit_coverage']=base['original_unit_coverage'][:-1]
    if case=='navigation-required':
        base['missing_dependencies']=['The scientific source behind the navigation link is required.']
        base['dependency_closure']='incomplete';base['verdict']='FAIL'
    if case=='mutate-joint':
        q=root/'research_notebook.md';q.write_bytes(q.read_bytes()+b'\nChanged during joint audit.\n')
    if case=='run-state-joint-mutation':
        with (root/'artifacts/runs/validity_ledger.jsonl').open('a') as ledger:
            ledger.write((root/'pending-validity-event.json').read_text())
print(json.dumps({'type':'system','subtype':'init','model':'transport-fixture'}),flush=True)
report=json.dumps(base,indent=2).replace('\n','\r\n') if case=='split-output' else json.dumps(base)
terminal=report
if case=='split-output':
    pivot=len(report)//2
    for mid,text in [('first',report[:pivot]),('last',report[pivot:])]:
        print(json.dumps({'type':'assistant','message':{'id':mid,'content':[{'type':'text','text':text}]}}),flush=True)
    terminal=report[pivot:]
print(json.dumps({'type':'result','subtype':'success','is_error':False,'session_id':'transport','result':terminal}),flush=True)
`;
let root: string;
const block = 'A finite anonymous source passage specifies its starting relations, domains, notation, hypotheses and all intermediate steps. UTF-8 λ and Γ preserve their original meaning.\n\n';
const large = '# Anonymous complete material\n\n' + block.repeat(6500) + '\n## Final statement\n\nEvery finite assumption and convention remains as stated.\n';
function write(name: string, text: string | Buffer): void { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
async function cli(args: string[]) { let stdout = ''; let stderr = ''; const code = await runCli(['--project-root', root, ...args], { stdout: t => { stdout += t; }, stderr: t => { stderr += t; } }); return { code, stdout, stderr, value: args.includes('--json') && stdout.trim() ? JSON.parse(stdout) : null }; }
function review(extra: string[] = []) { return cli(['notebook', 'review', '--model', 'claude/transport', '--context-bytes', '2000000', '--context-tokens', '3000000', '--json', ...extra]); }
function rehashCurrentGraph(dir: string): void {
  function walk(value: any): void {
    if (!value || typeof value !== 'object') return;
    const match = typeof value.uri === 'string' && /^rep:\/\/runs\/([^/]+)\/artifact\/(.*)$/.exec(value.uri);
    if (match) { const bytes = fs.readFileSync(path.join(root, 'artifacts/runs', match[1], decodeURIComponent(match[2]))); value.sha256 = createHash('sha256').update(bytes).digest('hex'); if ('size_bytes' in value) value.size_bytes = bytes.length; }
    Object.values(value).forEach(walk);
  }
  for (const file of ['review_execution.json', 'artifacts/verification_subject_notebook_v1.json', 'artifacts/verification_check_run_notebook_v1.json', 'artifacts/verification_subject_verdict_notebook_v1.json', 'artifacts/verification_coverage_notebook_v1.json'].map(n => path.join(dir, n)).concat(path.join(root, '.nullius/notebook-review.json'))) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')); walk(value); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }
}
beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-batch-')));
  expect((await cli(['init', '--mode', 'file'])).code).toBe(0);
  write('research_notebook.md', '# Anonymous notebook\n\nDefinitions and complete steps are supplied.\n');
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  write('test-bin/claude', transport); fs.chmodSync(path.join(root, 'test-bin/claude'), 0o755);
  vi.stubEnv('PATH', path.join(root, 'test-bin') + path.delimiter + process.env.PATH); vi.stubEnv('BATCH_TEST_ROOT', root);
}, 30000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('complete materials with bounded individual requests', () => {
  it('binds referenced run state to every batch and refuses stale receipt reuse without invalidating unrelated events', async () => {
    write('research_notebook.md', '# Notebook\n\n[Historical approach](artifacts/runs/aux-premise/result.md).\n\n' + block.repeat(25));
    write('artifacts/runs/aux-premise/result.md', 'Original premise and its stated limitations.\n');
    const first = await review(['--context-bytes', '20000']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const oldDir = path.join(root, 'artifacts/runs', first.value.run_id);
    const oldScope = JSON.parse(fs.readFileSync(path.join(oldDir, 'inputs/notebook-scope.json'), 'utf8'));
    const oldExecution = fs.readFileSync(path.join(oldDir, 'batch_execution.json'));
    expect(oldScope.run_states).toEqual([{ run_id: 'aux-premise', state: null }]);
    expect(() => materialIdentity({ ...oldScope, run_states: [] })).toThrow('run-state inventory');
    write('artifacts/runs/unrelated/result.md', 'Unrelated evidence.\n');
    expect((await cli(['trace', 'stamp', 'artifacts/runs/unrelated'])).code).toBe(0);
    expect((await cli(['trace', 'void', 'unrelated', '--reason', 'unrelated change'])).code).toBe(0);
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    const resumed = await review(['--resume', first.value.run_id]);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const reused = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', resumed.value.run_id, 'batch_execution.json'), 'utf8'));
    expect(reused.entries.some((entry: any) => entry.origin_run_id === first.value.run_id)).toBe(true);
    expect((await cli(['trace', 'void', 'aux-premise', '--reason', 'premise does not hold'])).code).toBe(0);
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'stale', reason: expect.stringContaining('referenced run state') });
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(1);
    const staleResume = await review(['--resume', resumed.value.run_id]);
    expect(staleResume.code).toBe(2);
    expect(staleResume.value.reason).toContain('Referenced run validity or identity changed');
    expect(fs.readFileSync(path.join(oldDir, 'batch_execution.json'))).toEqual(oldExecution);
    const fresh = await review(['--context-bytes', '20000']);
    expect(fresh.code, fresh.stdout + fresh.stderr).toBe(0);
    const dir = path.join(root, 'artifacts/runs', fresh.value.run_id);
    const scope = JSON.parse(fs.readFileSync(path.join(dir, 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.run_states).toMatchObject([{ run_id: 'aux-premise', state: { validity: 'void', reason: 'premise does not hold' } }]);
    expect(materialIdentity(scope)).not.toBe(materialIdentity(oldScope));
    const execution = JSON.parse(fs.readFileSync(path.join(dir, 'batch_execution.json'), 'utf8'));
    for (const entry of execution.entries) {
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, decodeURIComponent(entry.receipt_ref.uri.split('/artifact/')[1])), 'utf8'));
      const inventory = JSON.parse(fs.readFileSync(path.join(dir, decodeURIComponent(receipt.inventory_ref.uri.split('/artifact/')[1])), 'utf8'));
      expect(inventory.run_states).toEqual(scope.run_states);
    }
  }, 60000);

  it('records failed acceptance when run validity changes during the actual joint review', async () => {
    write('research_notebook.md', '# Notebook\n\n[Premise](artifacts/runs/aux-premise/result.md).\n\n' + block.repeat(25));
    write('artifacts/runs/aux-premise/result.md', 'Original scientific premise.\n');
    write('pending-validity-event.json', JSON.stringify(buildValidityEvent({ event: 'void', run_id: 'aux-premise', actor: 'test', reason: 'Changed during joint review' })) + '\n');
    vi.stubEnv('BATCH_TEST_CASE', 'run-state-joint-mutation');
    const result = await review(['--context-bytes', '20000']);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.value.status).toBe('stale');
    const dir = path.join(root, 'artifacts/runs', result.value.run_id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'artifacts/verification_subject_verdict_notebook_v1.json'), 'utf8')).status).toBe('failed');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);

  it('keeps historical batches without run-state binding unavailable and refuses resuming them', async () => {
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(25));
    const first = await review(['--context-bytes', '20000']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const dir = path.join(root, 'artifacts/runs', first.value.run_id);
    const scopePath = path.join(dir, 'inputs/notebook-scope.json');
    const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8')); delete scope.run_states;
    fs.writeFileSync(scopePath, JSON.stringify(scope)); rehashCurrentGraph(dir);
    const originalScope = fs.readFileSync(scopePath);
    const originalExecution = fs.readFileSync(path.join(dir, 'batch_execution.json'));
    expect(checkNotebookContentReview(root)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('no referenced-run state binding') });
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
    const resumed = await review(['--resume', first.value.run_id]);
    expect(resumed.code).toBe(2);
    expect(resumed.value.reason).toContain('no referenced-run state binding');
    expect(fs.readFileSync(scopePath)).toEqual(originalScope);
    expect(fs.readFileSync(path.join(dir, 'batch_execution.json'))).toEqual(originalExecution);
  }, 30000);

  it('neither resumes nor accepts source receipts with an omitted navigation inventory', async () => {
    write('research_notebook.md', '# Notebook\n\n[Project index](project_index.md "nullius-navigation").\n\n' + block.repeat(2));
    const oldId = '20261115T000000-notebook-review-bbbbbbbb';
    const oldDir = path.join(root, 'artifacts/runs', oldId);
    const oldScope = freezeNotebookReviewScope(root, oldId, oldDir, []);
    const budgets = notebookBudgets({ contextBytes: 30000, contextTokens: 100000 });
    // Inject a wrong lower-level scope to obtain actual, internally bound
    // transport receipts. The public CLI does not import this authored scope.
    const old = await executeNotebookBatches(root, oldDir, oldId, { ...oldScope, navigation_links: [] }, budgets, 'claude/transport', 30);
    expect(old.stop_reason).toBe(null);
    const id = '20261115T000001-notebook-review-cccccccc';
    const dir = path.join(root, 'artifacts/runs', id);
    const scope = freezeNotebookReviewScope(root, id, dir, []);
    const current = await executeNotebookBatches(root, dir, id, scope, budgets, 'claude/transport', 30, oldId);
    expect(current.stop_reason).toBe(null);
    expect(current.entries.some(entry => entry.origin_run_id === oldId)).toBe(false);
    const base = checkNotebookContentReview(root);
    expect(assessNotebookBatches(root, dir, id, scope, current, base).executionAccepted).toBe(true);
    const receipt = (entry: typeof current.entries[number]) => JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', entry.origin_run_id, decodeURIComponent(entry.receipt_ref.uri.split('/artifact/')[1])), 'utf8'));
    const spliced = { ...current, entries: [...old.entries.filter(entry => receipt(entry).phase === 'source'), ...current.entries.filter(entry => receipt(entry).phase === 'cross_section')] };
    const assessed = assessNotebookBatches(root, dir, id, scope, spliced, base);
    expect(assessed.executionAccepted).toBe(false);
    expect(assessed.report.status).toBe('unavailable');
    expect(assessed.report.findings.join(' ')).toContain('source batch did not receive');
  }, 30000);

  it.each(['complete', 'navigation-required'])('retains navigation inventory through interval and joint reviews: %s', async issue => {
    write('research_notebook.md', '# Notebook\n\n[Project index](project_index.md "nullius-navigation").\n\n' + block.repeat(25));
    vi.stubEnv('BATCH_TEST_CASE', issue);
    const result = await review(['--context-bytes', '20000']);
    expect(result.code, result.stdout + result.stderr).toBe(issue === 'complete' ? 0 : 1);
    const dir = path.join(root, 'artifacts/runs', result.value.run_id);
    const scope = JSON.parse(fs.readFileSync(path.join(dir, 'inputs/notebook-scope.json'), 'utf8'));
    const execution = JSON.parse(fs.readFileSync(path.join(dir, 'batch_execution.json'), 'utf8'));
    for (const entry of execution.entries) {
      const relative = decodeURIComponent(entry.receipt_ref.uri.split('/artifact/')[1]);
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, relative), 'utf8'));
      const inventory = JSON.parse(fs.readFileSync(path.join(dir, decodeURIComponent(receipt.inventory_ref.uri.split('/artifact/')[1])), 'utf8'));
      expect(inventory.navigation_links).toEqual(scope.navigation_links);
    }
    if (issue === 'complete') {
      // Rehashing references cannot legitimize a navigation inventory that is
      // not derived from the full original frozen notebook.
      scope.navigation_links = [];
      fs.writeFileSync(path.join(dir, 'inputs/notebook-scope.json'), JSON.stringify(scope));
      rehashCurrentGraph(dir);
    }
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);

  it('preserves a multi-message CRLF report through actual capture and notebook capacity admission', async () => {
    vi.stubEnv('BATCH_TEST_CASE', 'split-output');
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(25));
    const result = await review(['--context-bytes', '20000']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.value.status).toBe('accepted');
    const observations: any[] = [];
    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.runtime-observation.json')) {
          const observation = JSON.parse(fs.readFileSync(file, 'utf8')).payload;
          const report = fs.readFileSync(observation.report_path);
          expect(report.includes(Buffer.from('\r\n'))).toBe(true);
          const terminal = JSON.parse(fs.readFileSync(path.join(path.dirname(observation.report_path), path.dirname(observation.capture.budget_relative), observation.capture.complete_output.terminal), 'utf8'));
          expect(report.toString('utf8')).not.toBe(terminal.result);
          expect(report.toString('utf8').endsWith(terminal.result)).toBe(true);
          observations.push(observation);
        }
      }
    }
    walk(path.join(root, 'artifacts/runs'));
    expect(observations.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('validates the effective clamped budget and rejects unsafe interval limits without looping', async () => {
    expect(() => notebookBudgets({ contextTokens: 45000 })).toThrow();
    expect(() => notebookBudgets({ contextBytes: 12000 })).toThrow();
    for (const limit of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => partitionNotebookSources(new Map([['source', Buffer.from('Original λ.\n')]]), limit)).toThrow('interval budget');
    const result = await cli(['notebook', 'review', '--model', 'claude/transport', '--context-tokens', '45000', '--json']);
    expect(result.code).toBe(2); expect(result.value.status).toBe('unavailable');
  });

  it('encodes Markdown boundary segments once while preserving every original UTF-8 byte', () => {
    const text = '# Heading λ\n\nOriginal body Γ.\n\n'.repeat(4000); const data = Buffer.from(text); let encodedCharacters = 0;
    const original = Buffer.byteLength; const spy = vi.spyOn(Buffer, 'byteLength').mockImplementation((value: any, encoding?: BufferEncoding) => { if (typeof value === 'string') encodedCharacters += value.length; return original(value, encoding); });
    const pieces = partitionNotebookSources(new Map([['research_notebook.md', data]]), 4096); spy.mockRestore();
    expect(Buffer.concat(pieces.map(p => data.subarray(p.start_byte, p.end_byte)))).toEqual(data);
    expect(encodedCharacters).toBeLessThan(text.length * 4);
  });

  it('keeps untracked linked directory originals pending instead of treating a locator as read content', async () => {
    const original = '# Notebook\n\n[Original derivations](derivations/)\n'; write('research_notebook.md', original); write('derivations/nested/original.md', '# Source\n\nAn unread original scientific dependency.\n');
    const result = await review(); expect(result.code).toBe(2); expect(result.value).toMatchObject({ status: 'unavailable', progress: { closure_complete: false } });
    expect(result.value.progress.pending_sources).toContain('derivations');
    const dir = path.join(root, 'artifacts/runs', result.value.run_id); expect(fs.readFileSync(path.join(dir, 'inputs/source-0.txt'), 'utf8')).toBe(original);
    write('derivations/nested/original.md', 'Changed unread original.\n'); expect(checkNotebookContentReview(root).status).toBe('unavailable'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  });

  it.each(['joint-unanchored', 'joint-wrong-bytes'])('refuses %s joint assertions despite a complete original request', async issue => {
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(25)); vi.stubEnv('BATCH_TEST_CASE', issue);
    const result = await review(['--context-bytes', '20000']); expect(result.code).not.toBe(0); expect(checkNotebookContentReview(root).status).not.toBe('accepted'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);

  it('resumes fresh signed primary receipts when the old joint lacks byte anchors and executes a new joint', async () => {
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(25)); vi.stubEnv('BATCH_TEST_CASE', 'joint-legacy');
    const first = await review(['--context-bytes', '20000']); expect(first.code).not.toBe(0);
    const oldDir = path.join(root, 'artifacts/runs', first.value.run_id); const originals = new Map<string, Buffer>();
    function collect(dir: string): void { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) collect(file); else if (item.isFile()) originals.set(file, fs.readFileSync(file)); } } collect(oldDir);
    vi.stubEnv('BATCH_TEST_CASE', 'complete'); const resumed = await review(['--resume', first.value.run_id]); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', resumed.value.run_id, 'batch_execution.json'), 'utf8'));
    expect(state.entries.filter((e: any) => e.origin_run_id === first.value.run_id).length).toBeGreaterThan(0);
    expect(state.entries.find((e: any) => e.receipt_ref.uri.includes('cross-section')).origin_run_id).toBe(resumed.value.run_id);
    for (const [file, bytes] of originals) expect(fs.readFileSync(file)).toEqual(bytes);
  }, 30000);

  it('does not retroactively admit failed source capacity with a larger resume token window', async () => {
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(80)); const first = await review(['--context-bytes', '40000', '--context-tokens', '50000']);
    expect(first.code, first.stdout + first.stderr).toBe(2); expect(first.value.reason).toContain('token capacity');
    const oldDir = path.join(root, 'artifacts/runs', first.value.run_id); const original = fs.readFileSync(path.join(oldDir, 'batch_execution.json'));
    const resumed = await review(['--resume', first.value.run_id, '--context-tokens', '3000000']);
    expect(resumed.code).toBe(2); expect(resumed.value.reason).toContain('unchanged original token window');
    expect(fs.readFileSync(path.join(oldDir, 'batch_execution.json'))).toEqual(original); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);
  it('writes failed canonical outcomes when the original changes during the final joint audit', async () => {
    const original = '# Notebook\n\n' + block.repeat(25); write('research_notebook.md', original); vi.stubEnv('BATCH_TEST_CASE', 'mutate-joint');
    const result = await review(['--context-bytes', '20000']);
    expect(result.code, result.stdout + result.stderr).toBe(1); expect(result.value.status).toBe('stale');
    const dir = path.join(root, 'artifacts/runs', result.value.run_id);
    expect(fs.readFileSync(path.join(dir, 'inputs/source-0.txt'), 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'artifacts/verification_check_run_notebook_v1.json'), 'utf8')).status).toBe('failed');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'artifacts/verification_subject_verdict_notebook_v1.json'), 'utf8')).status).toBe('failed');
    expect(checkNotebookContentReview(root).status).toBe('stale'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);

  it('refuses a genuine previous joint receipt spliced into a fresh resumed aggregate', async () => {
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(25));
    const first = await review(['--context-bytes', '20000']); expect(first.code, first.stdout + first.stderr).toBe(0);
    const oldDir = path.join(root, 'artifacts/runs', first.value.run_id); const oldBytes = fs.readFileSync(path.join(oldDir, 'batch_execution.json')); const old = JSON.parse(oldBytes.toString());
    const second = await review(['--resume', first.value.run_id]); expect(second.code, second.stdout + second.stderr).toBe(0);
    const dir = path.join(root, 'artifacts/runs', second.value.run_id); const state = JSON.parse(fs.readFileSync(path.join(dir, 'batch_execution.json'), 'utf8'));
    state.entries = state.entries.map((e: any) => e.receipt_ref.uri.includes('cross-section') ? old.entries.find((o: any) => o.receipt_ref.uri.includes('cross-section')) : e);
    const scope = JSON.parse(fs.readFileSync(path.join(dir, 'inputs/notebook-scope.json'), 'utf8'));
    const assessed = assessNotebookBatches(root, dir, second.value.run_id, scope, state, second.value);
    expect(assessed.executionAccepted).toBe(false); expect(assessed.report.status).toBe('unavailable'); expect(assessed.report.findings.join(' ')).toContain('current review run');
    fs.writeFileSync(path.join(dir, 'batch_execution.json'), JSON.stringify(state)); rehashCurrentGraph(dir);
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass'); expect(fs.readFileSync(path.join(oldDir, 'batch_execution.json'))).toEqual(oldBytes);
  }, 30000);

  it('keeps missing batch runtime authority unavailable on later current reads', async () => {
    write('research_notebook.md', '# Notebook\n\n' + block.repeat(25)); const result = await review(['--context-bytes', '20000']); expect(result.code).toBe(0);
    const canonical = path.join(root, 'artifacts/runs', result.value.run_id, 'artifacts/verification_subject_verdict_notebook_v1.json'); const original = fs.readFileSync(canonical);
    vi.spyOn(runtime, 'installedRuntimeRoot').mockImplementation(() => { throw new Error('fixture runtime unavailable'); });
    expect(checkNotebookContentReview(root).status).toBe('unavailable'); expect((await cli(['notebook', 'check', '--json'])).code).toBe(2);
    expect(notebookCloseoutGate(root).decision).toBe('unavailable'); expect(fs.readFileSync(canonical)).toEqual(original);
  }, 30000);
  it('recursively freezes links carried by every valid UTF-8 source extension', () => {
    write('research_notebook.md', '# Notebook\n\n[Support](support.markdown)\n');
    write('support.markdown', '# Support\n\n[Text](inputs.txt)\n');
    write('inputs.txt', '[Hidden](hidden.md)\n');
    write('hidden.md', '# Hidden\n\nOriginal final dependency.\n');
    const dir = path.join(root, 'artifacts/runs/extension-control'); fs.mkdirSync(dir, { recursive: true });
    const scope = freezeNotebookReviewScope(root, 'extension-control', dir, []);
    expect(scope.dependencies.map(d => d.path)).toEqual(['support.markdown', 'inputs.txt', 'hidden.md']);
  });

  it('partitions exact UTF-8 bytes including a formula across a long-line boundary', () => {
    const data = Buffer.from('α'.repeat(400) + '\n$$\n\\Gamma = \\lambda^2\n$$\n' + 'β'.repeat(400));
    const pieces = partitionNotebookSources(new Map([['research_notebook.md', data]]), 77);
    expect(Buffer.concat(pieces.map(p => data.subarray(p.start_byte, p.end_byte)))).toEqual(data);
    expect(pieces.every(p => !data.subarray(p.start_byte, p.end_byte).toString('utf8').includes('\ufffd'))).toBe(true);
  });

  it('freezes one notebook above 1 MiB as text and accepts only all raw/cross receipts', async () => {
    expect(Buffer.byteLength(large)).toBeGreaterThan(1024 * 1024); write('research_notebook.md', large);
    const result = await review(); expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.value).toMatchObject({ status: 'accepted', progress: { text_bytes: Buffer.byteLength(large), pending_units: [], cross_section_reviewed: true } });
    expect((await cli(['notebook', 'check', '--json'])).code).toBe(0); expect(notebookCloseoutGate(root).decision).toBe('pass');
    const dir = path.join(root, 'artifacts/runs', result.value.run_id); const scope = JSON.parse(fs.readFileSync(path.join(dir, 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.opaque_links).toEqual([]); expect(scope.notebook.bytes).toBe(Buffer.byteLength(large));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'inputs/batch-plan.json'), 'utf8')).units.length).toBeGreaterThan(1);
  }, 120000);

  it('discovers a recursive text closure above 1 MiB without classifying text as opaque', async () => {
    const dep = '# Dependency\n\n' + block.repeat(2500);
    expect(Buffer.byteLength(dep)).toBeLessThan(1024 * 1024);
    write('research_notebook.md', '# Notebook\n\n[Premises](one.md) [Other](two.md)\n'); write('one.md', dep + '\n[Third](three.md)\n'); write('two.md', dep); write('three.md', dep);
    const result = await review(); expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.value.progress.text_bytes).toBeGreaterThan(1024 * 1024);
    const scope = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', result.value.run_id, 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.dependencies.map((d: any) => d.path)).toEqual(['one.md', 'two.md', 'three.md']); expect(scope.opaque_links).toEqual([]);
    write('three.md', dep + 'Changed dependency.\n'); expect(checkNotebookContentReview(root).status).toBe('stale'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 120000);

  it.each(['late-rejected', 'cross-conflict'])('preserves an executed %s rejection despite full interval delivery', async issue => {
    write('research_notebook.md', large + '\nFINAL DEFECT\n'); vi.stubEnv('BATCH_TEST_CASE', issue);
    const result = await review(); expect(result.code, result.stdout + result.stderr).toBe(1); expect(result.value.status).toBe('rejected');
    expect(result.value.progress.pending_units).toEqual([]); expect((await cli(['notebook', 'check', '--json'])).code).toBe(1); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 120000);

  it.each(['omit-unit', 'omit-cross'])('does not accept %s delivery', async issue => {
    write('research_notebook.md', large); vi.stubEnv('BATCH_TEST_CASE', issue);
    const result = await review(); expect(result.code, result.stdout + result.stderr).not.toBe(0); expect(checkNotebookContentReview(root).status).not.toBe('accepted'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 120000);

  it('keeps an execution-budget shortfall incomplete and resumes immutable original receipts', async () => {
    write('research_notebook.md', large);
    const partial = await review(['--max-batches', '1', '--snapshot-bytes', '1800000', '--max-files', '7']); expect(partial.code, partial.stdout + partial.stderr).toBe(1); expect(partial.value.status).toBe('incomplete'); expect(partial.value.progress.pending_units.length).toBeGreaterThan(0);
    const origin = path.join(root, 'artifacts/runs', partial.value.run_id); const previous = fs.readFileSync(path.join(origin, 'batch_execution.json'));
    const continued = await review(['--resume', partial.value.run_id]); expect(continued.value.status).toBe('incomplete');
    const inherited = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', continued.value.run_id, 'inputs/batch-plan.json'), 'utf8'));
    expect(inherited.budgets).toMatchObject({ snapshotBytes: 1800000, maxFiles: 7, maxBatches: 1 });
    const result = await review(['--resume', continued.value.run_id, '--max-batches', '64']); expect(result.code, result.stdout + result.stderr).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', result.value.run_id, 'batch_execution.json'), 'utf8'));
    expect(state.entries.some((e: any) => e.origin_run_id === partial.value.run_id)).toBe(true);
    expect(fs.readFileSync(path.join(origin, 'batch_execution.json'))).toEqual(previous);
  }, 120000);

  it('resumes an actually killed process from immutable checkpoints and repeats the full joint audit', async () => {
    write('research_notebook.md', large); vi.stubEnv('BATCH_TEST_CASE', 'interrupt-second');
    const module = pathToFileURL(path.resolve(import.meta.dirname, '../src/cli.ts')).href;
    const args = ['--project-root', root, 'notebook', 'review', '--model', 'claude/transport', '--context-bytes', '2000000', '--context-tokens', '3000000', '--json'];
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {runCli} from ${JSON.stringify(module)}; process.exit(await runCli(${JSON.stringify(args)}));`], { cwd: path.resolve(import.meta.dirname, '../../..'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = ''; child.stdout.on('data', data => { diagnostic += data; }); child.stderr.on('data', data => { diagnostic += data; });
    const marker = path.join(root, 'second-batch-started.json'); const deadline = Date.now() + 60000;
    try {
      while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.existsSync(marker), diagnostic).toBe(true);
      const processes = execFileSync('ps', ['-axo', 'pid,ppid,pgid'], { encoding: 'utf8' }).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([child.pid!]); let changed = true;
      while (changed) { changed = false; for (const [pid, parent] of processes) if (descendants.has(parent!) && !descendants.has(pid!)) { descendants.add(pid!); changed = true; } }
      const groups = new Set(processes.filter(row => descendants.has(row[0]!)).map(row => row[2]!));
      const closed = new Promise(resolve => child.once('close', resolve));
      for (const group of groups) { try { process.kill(-group, 'SIGKILL'); } catch { /* already stopped */ } }
      await closed;
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    const runs = fs.readdirSync(path.join(root, 'artifacts/runs')).filter(name => name.includes('-notebook-review-'));
    expect(runs).toHaveLength(1); const originalId = runs[0]!; const origin = path.join(root, 'artifacts/runs', originalId);
    expect(fs.existsSync(path.join(origin, 'batches/checkpoint-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(origin, 'review_execution.json'))).toBe(false);
    const originals = new Map<string, Buffer>();
    const collect = (directory: string) => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) collect(file); else if (item.isFile()) originals.set(file, fs.readFileSync(file)); } }; collect(origin);
    vi.stubEnv('BATCH_TEST_CASE', 'complete');
    const resumed = await review(['--resume', originalId]); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', resumed.value.run_id, 'batch_execution.json'), 'utf8'));
    expect(state.entries.some((entry: any) => entry.origin_run_id === originalId)).toBe(true);
    const joint = state.entries.find((entry: any) => entry.receipt_ref.uri.includes('cross-section'));
    expect(joint.origin_run_id).toBe(resumed.value.run_id);
    for (const [file, bytes] of originals) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(checkNotebookContentReview(root).status).toBe('accepted'); expect(notebookCloseoutGate(root).decision).toBe('pass');
  }, 120000);

  it('resumes partial recursive intake without claiming the old closure was complete', async () => {
    write('research_notebook.md', '# Notebook\n\n[Premises](premises.md)\n'); write('premises.md', '# Premises\n\nComplete anonymous assumptions.\n');
    const failed = await review(['--max-files', '1']); expect(failed.value.progress.closure_complete).toBe(false);
    const origin = path.join(root, 'artifacts/runs', failed.value.run_id); const intake = fs.readFileSync(path.join(origin, 'inputs/intake/checkpoint-1.json'));
    const resumed = await review(['--resume', failed.value.run_id, '--max-files', '4']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(fs.readFileSync(path.join(origin, 'inputs/intake/checkpoint-1.json'))).toEqual(intake);
    const scope = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', resumed.value.run_id, 'inputs/notebook-scope.json'), 'utf8'));
    expect(scope.dependencies.map((item: any) => item.path)).toEqual(['premises.md']);
  }, 120000);

  it('refuses mutation during review and preserves the frozen original suffix', async () => {
    write('research_notebook.md', large); vi.stubEnv('BATCH_TEST_CASE', 'mutate-during'); const result = await review();
    expect(result.code).not.toBe(0); expect(checkNotebookContentReview(root).status).toBe('stale'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    const scope = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', result.value.run_id, 'inputs/notebook-scope.json'), 'utf8'));
    const source = fs.readFileSync(path.join(root, 'artifacts/runs', result.value.run_id, 'inputs/source-0.txt'), 'utf8'); expect(source).toBe(large); expect(scope.notebook.bytes).toBe(Buffer.byteLength(large));
  }, 120000);

  it('records a cross-context capacity shortfall rather than discarding original claims', async () => {
    write('research_notebook.md', large); vi.stubEnv('BATCH_TEST_CASE', 'cross-wide'); const result = await review(['--context-bytes','524288']);
    expect(result.code, result.stdout + result.stderr).toBe(1); expect(result.value).toMatchObject({ status: 'incomplete', progress: { pending_units: [], cross_section_reviewed: false } });
    expect(result.value.reason).toContain('context budget'); expect(result.value.progress.resume_command).toContain('--resume');
  }, 120000);

  it('does not impose a packet-size limit on ordinary hashing diagnostics', async () => {
    write('research_notebook.md', large); expect(checkNotebookContentReview(root)).toMatchObject({ status: 'missing' }); expect((await cli(['status', '--json'])).code).toBe(0);
    const runDir = path.join(root, 'artifacts/runs', 'storage-probe'); fs.mkdirSync(runDir, { recursive: true });
    expect(() => freezeNotebookReviewScope(root, 'storage-probe', runDir, [], notebookBudgets({ snapshotBytes: 1024 }))).toThrow('at least');
    const failed = await review(['--snapshot-bytes','1024']);
    expect(failed.value).toMatchObject({ status: 'unavailable', progress: { closure_complete: false, files_frozen: 0 } });
    expect(failed.value.progress.pending_sources).toContain('research_notebook.md'); expect(failed.value.progress.resume_command).toContain('--project-root');
  });

  it.each(['Title\n=====\n\n', '\n\n# Title\n\n'])('does not count an actual title substring as a body anchor: %j', async prefix => {
    write('research_notebook.md', prefix + 'Scientific body and intermediate reasoning remain explicit.\n'.repeat(120));
    vi.stubEnv('BATCH_TEST_CASE', 'title-substring'); const result = await review(['--context-bytes','20000']);
    expect(result.code, result.stdout + result.stderr).not.toBe(0); expect(result.value.status).not.toBe('accepted');
    expect(result.value.progress.units_reviewed).toBe(0); expect(result.value.progress.pending_intervals.length).toBeGreaterThan(0);
  }, 120000);
});

it('rejects relabelled historical token authority while retaining signed originals', async () => {
 write('research_notebook.md', '# Notebook\n\n' + block.repeat(80));
 const first=await review(['--context-bytes','40000','--context-tokens','50000']);
 expect(first.code).toBe(2);expect(first.value.reason).toContain('token capacity');
 const dir=path.join(root,'artifacts/runs',first.value.run_id);
 const collect=(d:string):string[]=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(path.join(d,e.name)):[path.join(d,e.name)]);
 const files=collect(dir);const signed=new Map(files.filter(f=>f.endsWith('.runtime-observation.json')||f.includes('.attempts/')).map(f=>[f,fs.readFileSync(f)]));
 for(const name of ['inputs/batch-plan.json','review_execution.json','review_resume.json','review_intake.json']){
  const file=path.join(dir,name);if(!fs.existsSync(file))continue;const v=JSON.parse(fs.readFileSync(file,'utf8'));
  const b=v.budgets??v.request_budgets;if(b)b.contextTokens=3000000;fs.writeFileSync(file,JSON.stringify(v,null,2)+'\n');
 }
 for(let iteration=0;iteration<8;iteration++)for(const file of files.filter(f=>f.endsWith('.json')).concat(path.join(root,'.nullius/notebook-review.json'))){
  let value:any;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}let changed=false;
  const walk=(v:any):void=>{if(!v||typeof v!=='object')return;const m=typeof v.uri==='string'&&/^rep:\/\/runs\/([^/]+)\/artifact\/(.*)$/.exec(v.uri);
   if(m){const bytes=fs.readFileSync(path.join(root,'artifacts/runs',m[1],decodeURIComponent(m[2])));const hash=createHash('sha256').update(bytes).digest('hex');if(v.sha256!==hash||('size_bytes'in v&&v.size_bytes!==bytes.length)){v.sha256=hash;if('size_bytes'in v)v.size_bytes=bytes.length;changed=true;}}
   Object.values(v).forEach(walk);};walk(value);if(changed)fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
 }
 for(const [file,bytes]of signed)expect(fs.readFileSync(file)).toEqual(bytes);
 const resumed=await review(['--resume',first.value.run_id]);
 expect(resumed.code,resumed.stdout+resumed.stderr).not.toBe(0);
},30000);
