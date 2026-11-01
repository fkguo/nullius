import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mathFromMarkdown } from 'mdast-util-math';
import { math } from 'micromark-extension-math';
import type { Nodes } from 'mdast';
import { writeBytesAtomicDurable } from '@nullius/shared';
import { createRunArtifactRef } from './computation/artifact-refs.js';
import { assertNoSymlinkComponents, resolveWithinRoot } from './computation/path-safety.js';
import { resolveVerifiedRunArtifact } from './orch-tools/validation-chain-binding.js';
import type { Input, NotebookReviewScope, NotebookReviewSection } from './notebook-content-review.js';
import type { NotebookBudgets } from './notebook-review-batches.js';

export type EvidenceReference = { id: string; source_path: string; source_sha256: string; start_byte: number; end_byte: number;
  quote: string; destination: string; target_path?: string; target_kind: 'declared' | 'locator' | 'directory' | 'missing' | 'remote' | 'outside';
  target_sha256?: string; target_bytes?: number };
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function relative(root: string, name: string): string {
  if (!name || name.includes('\0') || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('evidence source requires a safe project-relative path');
  return path.relative(root, resolveWithinRoot(root, name, 'declared evidence')).split(path.sep).join('/');
}
function bytesAt(root: string, name: string): Buffer {
  const filename = resolveWithinRoot(root, name, 'evidence input');
  assertNoSymlinkComponents(root, filename, 'evidence input');
  if (!fs.statSync(filename).isFile()) throw new Error(`evidence input is not a regular file: ${name}`);
  return fs.readFileSync(filename);
}
function textAt(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  if (/\r(?!\n)/.test(text)) throw new Error('evidence text requires LF or CRLF line endings');
  return text;
}
function sources(bytes: Buffer, root: string): string[] {
  const text = textAt(bytes); if (text === null) throw new Error('evidence manifest requires UTF-8 JSON');
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'schema_version,sources' || value.schema_version !== 1
    || !Array.isArray(value.sources) || value.sources.some((s: unknown) => typeof s !== 'string')) throw new Error('invalid evidence manifest: expected only schema_version:1 and sources:string[]');
  const result = value.sources.map((s: string) => relative(root, s));
  if (new Set(result).size !== result.length) throw new Error('duplicate declared evidence source');
  return result;
}
function visit(node: Nodes, fn: (node: Nodes) => void): void { fn(node); if ('children' in node) node.children.forEach(child => visit(child, fn)); }
/** Nonrecursive provenance inventory. Locator bytes are identities, never read-coverage evidence. */
export function declaredEvidenceReferences(root: string, texts: Map<string, string>, inputs: Input[]): EvidenceReference[] {
  const declared = new Map(inputs.map(i => [i.path, i])); const result: EvidenceReference[] = [];
  for (const [source, text] of texts) {
    const tree = fromMarkdown(text, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] });
    const definitions = new Map<string, string>();
    visit(tree, n => { if (n.type === 'definition') definitions.set(n.identifier, n.url); });
    visit(tree, node => {
      let destination: string | undefined;
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') destination = node.url;
      if (node.type === 'linkReference' || node.type === 'imageReference') destination = definitions.get(node.identifier);
      if (!destination || !node.position) return;
      const start = node.position.start.offset!; const end = node.position.end.offset!;
      const ref: EvidenceReference = { id: '', source_path: source, source_sha256: hash(text), start_byte: Buffer.byteLength(text.slice(0, start)),
        end_byte: Buffer.byteLength(text.slice(0, end)), quote: text.slice(start, end), destination, target_kind: 'outside' };
      // The complete frozen inventory binds identity; short local IDs keep exhaustive
      // reviewer adjudication proportional to the references rather than hash text.
      ref.id = `reference-${result.length}`;
      if (/^[a-z][a-z\d+.-]*:/i.test(destination) || destination.startsWith('//')) ref.target_kind = 'remote';
      else {
        try {
          const target = decodeURIComponent(destination.split(/[?#]/, 1)[0]!);
          const filename = target ? resolveWithinRoot(root, path.resolve(root, path.dirname(source), target), 'evidence reference') : path.join(root, source);
          ref.target_path = path.relative(root, filename).split(path.sep).join('/');
          assertNoSymlinkComponents(root, filename, 'evidence reference');
          if (!fs.existsSync(filename)) ref.target_kind = 'missing';
          else if (fs.statSync(filename).isDirectory()) ref.target_kind = 'directory';
          else if (fs.statSync(filename).isFile()) {
            const bytes = bytesAt(root, ref.target_path); ref.target_sha256 = hash(bytes); ref.target_bytes = bytes.length;
            ref.target_kind = declared.has(ref.target_path) ? 'declared' : 'locator';
          }
        } catch { ref.target_kind = 'outside'; delete ref.target_sha256; delete ref.target_bytes; }
      }
      result.push(ref);
    });
  }
  return result;
}
export function freezeDeclaredEvidenceScope(root: string, runId: string, runDir: string, dependencies: string[], budgets: NotebookBudgets,
  manifestPath: string, sections: (text: string) => NotebookReviewSection[]): NotebookReviewScope {
  const manifestName = relative(root, manifestPath); const manifestBytes = bytesAt(root, manifestName);
  const explicit = [...new Set(dependencies.map(d => relative(root, d)))];
  const names = [...new Set(['research_notebook.md', ...sources(manifestBytes, root), ...explicit])];
  if (names.length + 1 > budgets.maxFiles) throw new Error('declared evidence exceeds --max-files storage budget');
  let total = manifestBytes.length; const inputs: Input[] = []; const opaque: Input[] = []; const texts = new Map<string, string>();
  const freeze = (name: string, bytes: Buffer, suffix: string): Input => {
    const filename = path.join(runDir, 'inputs', suffix);
    writeBytesAtomicDurable(filename, bytes, undefined, () => { if (fs.existsSync(filename)) throw new Error('immutable evidence snapshot already exists'); });
    return { path: name, sha256: hash(bytes), bytes: bytes.length, snapshot_ref: createRunArtifactRef(runId, runDir, filename, 'review_source_snapshot') };
  };
  if (total > budgets.snapshotBytes) throw new Error('evidence manifest exceeds --snapshot-bytes storage budget');
  const manifest = freeze(manifestName, manifestBytes, 'evidence-manifest.json');
  for (const name of names) {
    const bytes = bytesAt(root, name); total += bytes.length;
    if (total > budgets.snapshotBytes) throw new Error('declared evidence exceeds --snapshot-bytes storage budget');
    const text = textAt(bytes); if (name === 'research_notebook.md' && (text === null || !text.trim())) throw new Error('notebook requires nonempty UTF-8 text');
    const input = freeze(name, bytes, `source-${inputs.length + opaque.length}.${text === null ? 'bin' : 'txt'}`);
    if (text === null) opaque.push(input); else { inputs.push(input); texts.set(name, text); }
  }
  return { schema_version: 1, review_kind: 'notebook', extraction_policy: 'full_utf8_bytes_including_managed_blocks', notebook: inputs[0]!,
    dependencies: inputs.slice(1), opaque_links: opaque, sections: sections(texts.get('research_notebook.md')!), explicit_dependencies: explicit,
    directory_links: [], remote_links: [], evidence: { policy: 'declared-evidence', manifest, references: declaredEvidenceReferences(root, texts, [...inputs, ...opaque]) } };
}
export function declaredEvidenceIdentity(scope: NotebookReviewScope): unknown {
  return scope.evidence ? { policy: scope.evidence.policy, manifest: { path: scope.evidence.manifest.path, sha256: scope.evidence.manifest.sha256, bytes: scope.evidence.manifest.bytes }, references: scope.evidence.references } : null;
}
export function assertDeclaredEvidenceScope(scope: NotebookReviewScope, runDir: string, runId: string, root: string, texts: Map<string, string>): void {
  const evidence = scope.evidence!;
  if (evidence.policy !== 'declared-evidence' || !Array.isArray(evidence.references)) throw new Error('invalid declared evidence policy');
  const input = evidence.manifest; relative(root, input.path);
  const bytes = resolveVerifiedRunArtifact(runDir, runId, input.snapshot_ref, 'declared evidence manifest').bytes;
  if (hash(bytes) !== input.sha256 || bytes.length !== input.bytes) throw new Error('evidence manifest snapshot identity mismatch');
  const names = [...new Set(['research_notebook.md', ...sources(bytes, root), ...scope.explicit_dependencies.map(d => relative(root, d))])].sort();
  const inputs = [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])];
  if (JSON.stringify(names) !== JSON.stringify(inputs.map(i => i.path).sort())) throw new Error('declared evidence scope omits or adds primary originals');
  if (!declaredEvidenceIsCurrent(root, scope, texts)) throw new Error('declared evidence manifest or reference inventory changed');
}
export function declaredEvidenceIsCurrent(root: string, scope: NotebookReviewScope, frozenTexts?: Map<string, string>): boolean {
  if (!scope.evidence) return true;
  try {
    const evidence = scope.evidence;
    if (evidence.policy !== 'declared-evidence' || hash(bytesAt(root, evidence.manifest.path)) !== evidence.manifest.sha256) return false;
    const texts = frozenTexts ?? new Map<string, string>(); const inputs = [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])];
    for (const input of inputs) { const bytes = bytesAt(root, input.path); if (hash(bytes) !== input.sha256 || bytes.length !== input.bytes) return false;
      if (!frozenTexts) { const text = textAt(bytes); if (text !== null) texts.set(input.path, text); } }
    return JSON.stringify(declaredEvidenceReferences(root, texts, inputs)) === JSON.stringify(evidence.references);
  } catch { return false; }
}
