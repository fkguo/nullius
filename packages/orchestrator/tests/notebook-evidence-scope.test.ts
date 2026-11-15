import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freezeNotebookReviewScope, assessNotebookReviewReport } from '../src/notebook-content-review.js';
import { assertDeclaredEvidenceScope, declaredEvidenceIsCurrent } from '../src/notebook-evidence-scope.js';
import { notebookBudgets, materialIdentity } from '../src/notebook-review-batches.js';
import { resolveVerifiedRunArtifact } from '../src/orch-tools/validation-chain-binding.js';
import { parseCliArgs } from '../src/cli-args.js';
let root: string; let run: string;
const freeze = () => freezeNotebookReviewScope(root, 'scope-fixture', run, [], notebookBudgets({}), 'evidence.json');
function write(name: string, text: string | Buffer) { fs.writeFileSync(path.join(root, name), text); }
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-declared-')); run = path.join(root, 'artifacts/runs/scope-fixture'); fs.mkdirSync(run, { recursive: true });
  write('research_notebook.md', '# Notebook\nA bounded statement.\n'); write('evidence.json', JSON.stringify({ schema_version: 1, sources: ['original.md'] })); write('original.md', '# Original\nExact source bytes.\n'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('declared primary evidence intake', () => {
  it('freezes the complete notebook and exact originals without recursive expansion', () => {
    write('research_notebook.md', '# Notebook\n[Original](original.md) [locator](locator.md) [missing](absent.md) [directory](folder/) [remote](https://example.invalid/) [outside](../elsewhere.md)\n');
    write('original.md', 'π [other](locator.md)\n$$\n[x](not-a-reference.md)\n$$\n'); write('locator.md', '[deeper](never-expanded.md)\n'); fs.mkdirSync(path.join(root, 'folder'));
    const scope = freeze(); expect(scope.dependencies.map(i => i.path)).toEqual(['original.md']);
    expect(scope.evidence!.references.map(r => r.target_kind)).toEqual(['declared', 'locator', 'missing', 'directory', 'remote', 'outside', 'locator']);
    for (const ref of scope.evidence!.references) { const bytes = fs.readFileSync(path.join(root, ref.source_path)); expect(bytes.subarray(ref.start_byte, ref.end_byte).toString()).toBe(ref.quote); }
    expect(scope.evidence!.references.map(r => r.id)).toEqual(scope.evidence!.references.map((_, i) => `reference-${i}`));
    expect(new Set(scope.evidence!.references.map(r => r.id)).size).toBe(scope.evidence!.references.length);
    expect(declaredEvidenceIsCurrent(root, scope)).toBe(true);
    const originals = new Map([['research_notebook.md', fs.readFileSync(path.join(root, 'research_notebook.md'), 'utf8')], ['original.md', fs.readFileSync(path.join(root, 'original.md'), 'utf8')]]);
    expect(() => assertDeclaredEvidenceScope(scope, run, 'scope-fixture', root, originals)).not.toThrow();
    write('locator.md', 'Changed unread locator.\n'); expect(declaredEvidenceIsCurrent(root, scope)).toBe(true);
    expect(() => assertDeclaredEvidenceScope(scope, run, 'scope-fixture', root, originals)).not.toThrow();
  });
  it('preserves as-of unread observations and read-material identity on complete-scope resume', () => {
    write('original.md', '[index](index.md) [missing](absent.md)\n'); write('index.md', 'Index at observation.\n');
    const scope = freeze(); const identity = materialIdentity(scope); const observations = structuredClone(scope.evidence!.references);
    write('index.md', 'Updated navigation after checkpoint.\n'); write('absent.md', 'Created after observation.\n');
    expect(declaredEvidenceIsCurrent(root, scope)).toBe(true);
    const nextRun = path.join(root, 'artifacts/runs/scope-resumed'); fs.mkdirSync(nextRun, { recursive: true });
    const resumed = freezeNotebookReviewScope(root, 'scope-resumed', nextRun, [], notebookBudgets({}), 'evidence.json', observations);
    expect(resumed.evidence!.references).toEqual(observations); expect(materialIdentity(resumed)).toBe(identity);
    fs.unlinkSync(path.join(root, 'index.md')); fs.symlinkSync('/etc/passwd', path.join(root, 'index.md'));
    expect(declaredEvidenceIsCurrent(root, resumed)).toBe(true);
    write('original.md', 'Changed primary source.\n'); expect(declaredEvidenceIsCurrent(root, resumed)).toBe(false);
  });
  it.each([{ id: 'reference-99' }, { quote: 'invented quote' }, { start_byte: 3 }, { destination: 'invented.md' }, { target_path: 'invented.md' }, { target_kind: 'declared' }, { target_sha256: 'invalid' }, { target_bytes: -1 }])('rejects forged lexical or malformed observation descriptors %j', change => {
    write('original.md', '[index](index.md)\n'); write('index.md', 'Unread contents.\n'); const scope = freeze();
    Object.assign(scope.evidence!.references[0]!, change); expect(declaredEvidenceIsCurrent(root, scope)).toBe(false);
  });
  it('keeps unread observation changes bound into canonical material identity', () => {
    write('original.md', '[index](index.md)\n'); write('index.md', 'Unread contents.\n'); const scope = freeze(); const identity = materialIdentity(scope);
    scope.evidence!.references[0]!.target_sha256 = 'a'.repeat(64); expect(materialIdentity(scope)).not.toBe(identity);
  });
  it('rejects forged primary target identities despite unchanged live originals', () => {
    write('research_notebook.md', '# Notebook\n[original](original.md)\n'); const scope = freeze(); scope.evidence!.references[0]!.target_sha256 = 'a'.repeat(64);
    expect(declaredEvidenceIsCurrent(root, scope)).toBe(false);
  });
  it('cannot use the ordinary report path to claim declared evidence acceptance', () => { const scope = freeze(); expect(() => assessNotebookReviewReport({ verdict: 'PASS' }, scope, new Map(), 'unused')).toThrow(/hierarchical/); });
  it('records opaque primary originals without claiming text coverage', () => { write('original.md', Buffer.from([0, 1, 255])); const scope = freeze(); expect(scope.dependencies).toEqual([]); expect(scope.opaque_links![0]!.path).toBe('original.md'); expect(declaredEvidenceIsCurrent(root, scope)).toBe(true); });
  it.each([{ schema_version: 1, sources: [], pass: true }, { schema_version: 2, sources: [] }, { schema_version: 1, sources: ['../escape'] }, { schema_version: 1, sources: ['original.md', './original.md'] }])('rejects invalid manifests %j', value => { write('evidence.json', JSON.stringify(value)); expect(freeze).toThrow(); });
  it('rejects symlink sources and manifests', () => { fs.symlinkSync(path.join(root, 'original.md'), path.join(root, 'alias.md')); write('evidence.json', JSON.stringify({ schema_version: 1, sources: ['alias.md'] })); expect(freeze).toThrow(/symbolic link/); });
  it('keeps unsafe outgoing symlinks explicit without following them', () => { fs.symlinkSync('/etc/passwd', path.join(root, 'alias.md')); write('original.md', '[unsafe](alias.md)\n'); const scope = freeze(); expect(scope.evidence!.references[0]!.target_kind).toBe('outside'); expect(scope.evidence!.references[0]!.target_sha256).toBeUndefined(); });
  it('preserves original UTF-8 BOM and CRLF bytes in immutable snapshots', () => { const bytes = Buffer.from('\ufeff# Source\r\nπ = α.\r\n'); write('original.md', bytes); const scope = freeze(); expect(resolveVerifiedRunArtifact(run, 'scope-fixture', scope.dependencies[0]!.snapshot_ref, 'original').bytes).toEqual(bytes); expect(declaredEvidenceIsCurrent(root, scope)).toBe(true); });
  it('freezes and verifies the inventory rather than trusting a changed reference list', () => { write('original.md', '[needed](absent.md)\n'); const scope = freeze(); scope.evidence!.references = []; expect(declaredEvidenceIsCurrent(root, scope)).toBe(false); });
  it('accounts for manifest storage and file count', () => { expect(() => freezeNotebookReviewScope(root, 'scope-fixture', run, [], notebookBudgets({ maxFiles: 1 }), 'evidence.json')).toThrow(/max-files/); });
  it('rejects changed manifest bytes even when the source list is equivalent', () => { const scope = freeze(); write('evidence.json', fs.readFileSync(path.join(root, 'evidence.json'), 'utf8') + '\n'); expect(declaredEvidenceIsCurrent(root, scope)).toBe(false); });
  it('rejects bare CR in original text', () => { write('original.md', 'a\rb'); expect(freeze).toThrow(/line endings/); });
  it('resolves duplicate reference definitions to the first original destination', () => {
    write('original.md', '[Proof][p]\n\n[p]: first.md\n[p]: second.md\n');
    const scope = freeze();
    expect(scope.evidence!.references.find(ref => ref.quote === '[Proof][p]')?.destination).toBe('first.md');
  });
  it('includes explicit dependencies as primary originals', () => { write('extra.md', 'Additional original.\n'); const scope = freezeNotebookReviewScope(root, 'scope-fixture', run, ['extra.md'], notebookBudgets({}), 'evidence.json'); expect(scope.dependencies.map(i => i.path)).toEqual(['original.md', 'extra.md']); });
});
describe('declared evidence CLI', () => {
  it('parses the opt-in manifest without changing default options', () => { expect(parseCliArgs(['notebook', 'review', '--model', 'codex/test', '--evidence-manifest', 'evidence.json'])).toMatchObject({ evidenceManifest: 'evidence.json' }); expect(parseCliArgs(['notebook', 'review', '--model', 'codex/test'])).not.toHaveProperty('evidenceManifest'); });
  it('rejects missing, repeated or non-review manifests', () => { for (const args of [['review', '--model', 'codex/test', '--evidence-manifest'], ['review', '--model', 'codex/test', '--evidence-manifest', 'a.json', '--evidence-manifest', 'b.json'], ['check', '--evidence-manifest', 'a.json']]) expect(() => parseCliArgs(['notebook', ...args])).toThrow(); });
});
