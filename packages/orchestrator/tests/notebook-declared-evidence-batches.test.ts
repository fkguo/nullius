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
import { assessNotebookBatches, notebookBudgets, partitionNotebookSources } from '../src/notebook-review-batches.js';
import { notebookCloseoutGate } from '../src/notebook-result-links.js';

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
    if case=='mutate-joint':
        q=root/'research_notebook.md';q.write_bytes(q.read_bytes()+b'\nChanged during joint audit.\n')
if inv.get('evidence_policy')=='declared-evidence':
    base['additional_context_requests']=['Need omitted original premise.'] if case=='request-context' else []
    base['reference_assessments']=[{'reference_id':r['id'],'required_for_reasoning':r['target_kind']=='declared' or case=='require-unread' or (case=='final-require-unread' and inv['review_kind']!='notebook_batch'),'reasoning':'Deterministic necessity transport assessment.'} for r in inv['references']]
    if case=='omit-reference':base['reference_assessments']=base['reference_assessments'][:-1]
    if case.startswith('group'):
        groups=[]
        for required in [False,True]:
            ids=[a['reference_id'] for a in base['reference_assessments'] if a['required_for_reasoning']==required]
            if ids:groups.append({'reference_ids':ids,'required_for_reasoning':required,'reasoning':'All named references share this explicit transport necessity assessment.'})
        base['reference_assessments']=groups
        if groups:
            g=groups[0]
            if case=='group-duplicate':g['reference_ids'].append(g['reference_ids'][0])
            if case=='group-cross-duplicate':groups.append({'reference_id':g['reference_ids'][0],'required_for_reasoning':False,'reasoning':'Repeated occurrence.'})
            if case=='group-unknown':g['reference_ids'].append('unknown-reference')
            if case=='group-wildcard':g['reference_ids']=['*']
            if case=='group-empty':g['reference_ids']=[]
            if case=='group-mixed':g['reference_id']=g['reference_ids'][0]
            if case=='group-implicit':g.pop('reference_ids')
            if case=='group-omit':g['reference_ids']=g['reference_ids'][1:]
            if case=='group-required-unread' or (case=='group-final-required-unread' and inv['review_kind']!='notebook_batch'):g['required_for_reasoning']=True

    if inv['review_kind']!='notebook_batch':
        sections=[]
        raw=(root/'research_notebook.md').read_bytes();lines=raw.split(b'\n');offsets=[0]
        for line in lines:offsets.append(offsets[-1]+len(line)+1)
        for s in inv['sections']:
            start=offsets[s['start_line']-1];end=min(len(raw),offsets[s['end_line']]);data=raw[start:end]
            line=next((line for line in data.decode().splitlines() if line.strip() and not line.startswith('#')),'')
            at=start+data.find(line.encode());a={'path':'research_notebook.md','start_byte':at,'end_byte':at+len(line.encode()),'quote':line}
            sections.append({'section_id':s['section_id'],'sha256':s['sha256'],'status':'complete','reasoning':'Full notebook section transport coverage.','anchors':[a]})
        base['section_reviews']=sections[:-1] if case=='omit-section' else sections
        if case=='section-heading':base['section_reviews'][0]['anchors']=[{'path':'research_notebook.md','quote':'Notebook'}]
        if case=='untransmitted-anchor':
            for c,u in zip(base['original_unit_coverage'],inv['units']):
                if u['path']!='research_notebook.md':c['anchors']=[{'path':u['path'],'quote':'Untransmitted original body.'}]
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
beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-batch-')));
  expect((await cli(['init', '--mode', 'file'])).code).toBe(0);
  write('research_notebook.md', '# Anonymous notebook\n\nDefinitions and complete steps are supplied.\n');
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  write('test-bin/claude', transport); fs.chmodSync(path.join(root, 'test-bin/claude'), 0o755);
  vi.stubEnv('PATH', path.join(root, 'test-bin') + path.delimiter + process.env.PATH); vi.stubEnv('BATCH_TEST_ROOT', root);
}, 30000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('declared evidence hierarchy transport (no semantic model judgment)', () => {
  function material() {
    write('research_notebook.md', '# Notebook\n\n[First](one.md) and [Locator](locator.md) give explicitly assessed references.\n\n## Relation\n\nA full original notebook section relates the declared sources.\n');
    write('one.md', '# Source\n\nFirst original body.\n\nUntransmitted original body.\n');
    write('locator.md', '# Locator\n\nThis is an unread source locator.\n');
    write('evidence.json', JSON.stringify({ schema_version: 1, sources: ['one.md'] }));
  }
  function declared(extra: string[] = []) { return review(['--evidence-manifest', 'evidence.json', ...extra]); }
  it('packs multiple files and sends complete notebook with canonical receipts and original excerpts', async () => {
    material();
    const result = await declared(); expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.value.scope).toContain('acceptance does not cover recursive history');
    expect(result.value.progress).toMatchObject({ material_profile: 'declared-evidence', primary_text_files_total: 2, opaque_primary_files_total: 0, unread_provenance_references_total: 1 });
    expect(result.value.progress.closure_meaning).toContain('Declared primary intake only');
    expect(result.value.progress.provenance_meaning).toContain('do not establish original-source reading');
    const dir = path.join(root, 'artifacts/runs', result.value.run_id);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'batch_execution.json'), 'utf8'));
    expect(state.entries).toHaveLength(2);
    const inv = JSON.parse(fs.readFileSync(path.join(dir, 'batches/source-0/inventory.json'), 'utf8'));
    expect(new Set(inv.units.map((u: any) => u.path)).size).toBe(2);
    const final = fs.readFileSync(path.join(dir, 'batches/cross-section/original-text.txt'), 'utf8');
    expect(final).toContain(fs.readFileSync(path.join(root, 'research_notebook.md'), 'utf8'));
    expect(final).toContain('receipt_ref'); expect(final).toContain('ORIGINAL CROSS CONTEXT one.md');
    expect(final).not.toContain('Untransmitted original body.');
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    write('locator.md', '# Changed locator\n'); expect(checkNotebookContentReview(root).status).toBe('accepted');
  }, 30000);
  it('keeps many small files in bounded multi-file packs', async () => {
    material(); const paths = Array.from({ length: 20 }, (_, i) => `small-${i}.md`);
    for (const name of paths) write(name, '# Source\n\nA complete small original source passage.\n');
    write('evidence.json', JSON.stringify({ schema_version: 1, sources: ['one.md', ...paths] }));
    const result = await declared(); expect(result.code, result.stdout + result.stderr).toBe(0);
    const dir = path.join(root, 'artifacts/runs', result.value.run_id);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'batch_execution.json'), 'utf8'));
    expect(state.entries).toHaveLength(3);
    const inv = JSON.parse(fs.readFileSync(path.join(dir, 'batches/source-0/inventory.json'), 'utf8'));
    expect(inv.units).toHaveLength(16);
  }, 30000);
  it.each(['require-unread', 'final-require-unread', 'omit-reference', 'request-context', 'omit-section', 'section-heading', 'untransmitted-anchor'])('blocks %s despite a PASS transport response', async issue => {
    material(); vi.stubEnv('BATCH_TEST_CASE', issue);
    const result = await declared(); expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);
  it('accepts explicit shared assessments while retaining every reference descriptor', async () => {
    material(); write('research_notebook.md', fs.readFileSync(path.join(root, 'research_notebook.md'), 'utf8') + '\n[Another unread locator occurrence](locator.md)\n');
    vi.stubEnv('BATCH_TEST_CASE', 'group');
    const result = await declared(); expect(result.code, result.stdout + result.stderr).toBe(0);
    const dir = path.join(root, 'artifacts/runs', result.value.run_id);
    const inv = JSON.parse(fs.readFileSync(path.join(dir, 'batches/cross-section/inventory.json'), 'utf8'));
    expect(inv.references).toHaveLength(3);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'batch_execution.json'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'batches/cross-section/receipt.json'), 'utf8'));
    const reportPath = decodeURIComponent(receipt.report_ref.uri.split('/artifact/')[1]);
    const report = JSON.parse(fs.readFileSync(path.join(dir, reportPath), 'utf8'));
    expect(report.reference_assessments.some((a: any) => a.reference_ids.length === 2)).toBe(true);
    expect(state.entries).toHaveLength(2); expect(checkNotebookContentReview(root).status).toBe('accepted');
  }, 30000);
  it.each(['group-duplicate', 'group-cross-duplicate', 'group-unknown', 'group-wildcard', 'group-empty', 'group-mixed', 'group-implicit', 'group-omit', 'group-required-unread', 'group-final-required-unread'])('blocks invalid explicit reference assessment %s', async issue => {
    material(); vi.stubEnv('BATCH_TEST_CASE', issue);
    const result = await declared(); expect(result.code, result.stdout + result.stderr).not.toBe(0);
    expect(checkNotebookContentReview(root).status).not.toBe('accepted'); expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);
  it('reuses complete source receipts across unread navigation updates while keeping primary identity mandatory', async () => {
    material(); const first = await declared(['--max-batches', '1']);
    expect(first.value.status).toBe('incomplete'); expect(first.value.progress.pending_units).toEqual([]);
    const dir = path.join(root, 'artifacts/runs', first.value.run_id); const bytes = fs.readFileSync(path.join(dir, 'batch_execution.json'));
    const frozenScopeBytes = fs.readFileSync(path.join(dir, 'inputs/notebook-scope.json'));
    const frozenScope = JSON.parse(frozenScopeBytes.toString('utf8'));
    const unreadUpdate = '# Updated unread navigation index\n\n[Fresh navigation](not-provided.md)\n';
    write('locator.md', unreadUpdate);
    const second = await declared(['--resume', first.value.run_id, '--max-batches', '64']);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', second.value.run_id, 'batch_execution.json'), 'utf8'));
    expect(state.entries[0].origin_run_id).toBe(first.value.run_id); expect(state.entries[1].origin_run_id).toBe(second.value.run_id);
    expect(fs.readFileSync(path.join(dir, 'batch_execution.json'))).toEqual(bytes);
    expect(fs.readFileSync(path.join(dir, 'inputs/notebook-scope.json'))).toEqual(frozenScopeBytes);
    const resumedDir = path.join(root, 'artifacts/runs', second.value.run_id);
    const resumedScope = JSON.parse(fs.readFileSync(path.join(resumedDir, 'inputs/notebook-scope.json'), 'utf8'));
    expect(resumedScope.evidence.references).toEqual(frozenScope.evidence.references);
    const finalInventory = JSON.parse(fs.readFileSync(path.join(resumedDir, 'batches/cross-section/inventory.json'), 'utf8'));
    expect(finalInventory.references).toEqual(frozenScope.evidence.references);
    expect(fs.readFileSync(path.join(resumedDir, 'batches/cross-section/original-text.txt'), 'utf8')).not.toContain(unreadUpdate);
    expect(checkNotebookContentReview(root).status).toBe('accepted');
    const originalPrimary = fs.readFileSync(path.join(root, 'one.md'));
    write('one.md', '# Changed primary original\n'); expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
    write('one.md', originalPrimary); expect(checkNotebookContentReview(root).status).toBe('accepted');
    write('evidence.json', fs.readFileSync(path.join(root, 'evidence.json'), 'utf8') + '\n');
    expect(checkNotebookContentReview(root).status).not.toBe('accepted');
    expect(notebookCloseoutGate(root).decision).not.toBe('pass');
  }, 30000);
  it('does not reuse a partial packed report', async () => {
    material(); vi.stubEnv('BATCH_TEST_CASE', 'omit-unit'); const first = await declared();
    expect(first.value.progress.units_reviewed).toBe(0);
    vi.stubEnv('BATCH_TEST_CASE', 'complete'); const second = await declared(['--resume', first.value.run_id]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/runs', second.value.run_id, 'batch_execution.json'), 'utf8'));
    expect(state.entries.every((e: any) => e.origin_run_id === second.value.run_id)).toBe(true);
  }, 30000);
});
