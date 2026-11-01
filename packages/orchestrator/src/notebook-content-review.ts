import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mathFromMarkdown } from 'mdast-util-math';
import { math } from 'micromark-extension-math';
import type { Nodes } from 'mdast';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ArtifactRefV1, VerificationSubjectV1, VerificationCheckRunV1,
  VerificationSubjectVerdictV1, VerificationCoverageV1 } from '@nullius/shared';
import { fsyncParentDirectoryDurable, withLedgerLock, writeBytesAtomicDurable } from '@nullius/shared';
import { createRunArtifactRef } from './computation/artifact-refs.js';
import { assertNoSymlinkComponents, resolveWithinRoot } from './computation/path-safety.js';
import { loadVerifiedRunJson, resolveVerifiedRunArtifact } from './orch-tools/validation-chain-binding.js';
import { installedRuntimeRoot } from './cli-runtime.js';
import { stampRunDirectory } from './run-stamp.js';
import { notebookBudgets, notebookShellWord, NotebookRequestCapacityError, assessNotebookRequestCapacity, executeNotebookBatches, assessNotebookBatches, loadNotebookBatchHistory, type NotebookBudgets, type BatchExecution, type BatchPlan } from './notebook-review-batches.js';
import { freezeDeclaredEvidenceScope, assertDeclaredEvidenceScope, declaredEvidenceIsCurrent, type EvidenceReference } from './notebook-evidence-scope.js';
import { textOutsideNotebookCurrentState } from './notebook-current-state.js';
import artifactSchema from '../../../meta/schemas/artifact_ref_v1.schema.json' with { type: 'json' };
import subjectSchema from '../../../meta/schemas/verification_subject_v1.schema.json' with { type: 'json' };
import checkSchema from '../../../meta/schemas/verification_check_run_v1.schema.json' with { type: 'json' };
import verdictSchema from '../../../meta/schemas/verification_subject_verdict_v1.schema.json' with { type: 'json' };
import coverageSchema from '../../../meta/schemas/verification_coverage_v1.schema.json' with { type: 'json' };

const POINTER = '.nullius/notebook-review.json';
const PENDING = '.nullius/notebook-review-pending.json';
const KIND = 'notebook_content_review';
const POLICY = 'full_utf8_bytes_including_managed_blocks';
const READ_CHUNK_BYTES = 65536;
const SCOPE_NOTE = 'Full notebook and frozen declared dependencies; reviewer assessment of completeness, logic, notation, definitions, assumptions and conventions. This is bounded review evidence, not proof of scientific truth.';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

// Reuse the canonical verification schemas. Notebook review is supporting
// semantic evidence: it does not fabricate a computation validation binding.
const ajv = new (Ajv2020 as any)({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(artifactSchema);
const validators = [subjectSchema, checkSchema, verdictSchema, coverageSchema].map(schema => ajv.compile(schema));

export type Input = { path: string; sha256: string; bytes: number; snapshot_ref: ArtifactRefV1 };
export type NotebookReviewSection = { section_id: string; heading: string; start_line: number; end_line: number; sha256: string };
export type NotebookReviewScope = {
  schema_version: 1; review_kind: 'notebook'; extraction_policy: typeof POLICY;
  notebook: Input; dependencies: Input[]; opaque_links?: Input[]; sections: NotebookReviewSection[];
  explicit_dependencies: string[]; directory_links: string[]; remote_links: string[];
  evidence?: { policy: 'declared-evidence'; manifest: Input; references: EvidenceReference[] };
};
type ReviewPointer = { schema_version: 1; run_id: string; verification_refs: {
  subject_refs: ArtifactRefV1[]; check_run_refs: ArtifactRefV1[];
  subject_verdict_refs: ArtifactRefV1[]; coverage_refs: ArtifactRefV1[];
} };
type Execution = {
  schema_version: 1; run_id: string; review_kind: 'notebook'; command: string[];
  started_at: string; finished_at: string; exit_status: number | null;
  scope_ref: ArtifactRefV1; stdout_ref: ArtifactRefV1; stderr_ref: ArtifactRefV1;
  manifest_ref?: ArtifactRefV1; meta_ref?: ArtifactRefV1; trace_ref?: ArtifactRefV1;
  report_ref?: ArtifactRefV1; pre_freshness_ref?: ArtifactRefV1; post_freshness_ref?: ArtifactRefV1;
  captured_refs: ArtifactRefV1[]; batch_execution_ref?: ArtifactRefV1; request_budgets?: NotebookBudgets;
};
export type NotebookContentReview = {
  status: 'missing' | 'stale' | 'rejected' | 'unavailable' | 'incomplete' | 'accepted';
  reason: string; scope: string; run_id: string | null; reviewed_notebook_sha256: string | null;
  current_notebook_sha256: string | null; sections_total: number; sections_reviewed: number;
  findings: unknown[]; evidence: ArtifactRefV1[]; independence: unknown;
  previous_run_id?: string | null; progress?: Record<string, unknown>;
};
class NotebookIntakeBudgetError extends Error {
  constructor(message: string, readonly progress: Record<string, unknown>) { super(message); }
}

function readBytes(root: string, relative: string): Buffer {
  const filename = resolveWithinRoot(root, relative, 'notebook review input');
  assertNoSymlinkComponents(root, filename, 'notebook review input');
  if (!fs.statSync(filename).isFile()) throw new Error(`notebook review input is not a file: ${relative}`);
  const bytes = fs.readFileSync(filename);
  return bytes;
}

function decodeText(bytes: Buffer, relative: string): string {
  if (bytes.includes(0)) throw new Error(`notebook review needs a valid UTF-8 text snapshot without NUL: ${relative}`);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (/\r(?!\n)/.test(text)) throw new Error(`notebook review requires LF or CRLF line endings: ${relative}`);
  return text;
}

// Ordinary diagnostics hash and validate UTF-8 incrementally, independent of
// the storage or single-request review budget.
function streamTextIdentity(root: string, relative: string): string {
  const filename = resolveWithinRoot(root, relative, 'notebook identity');
  assertNoSymlinkComponents(root, filename, 'notebook identity');
  if (!fs.statSync(filename).isFile()) throw new Error('notebook identity is not a file');
  const fd = fs.openSync(filename, 'r'); const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); const h = createHash('sha256');
  let lastCR = false;
  try {
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const bytes = buffer.subarray(0, count); if (bytes.includes(0)) throw new Error('notebook NUL'); h.update(bytes);
      const text = decoder.decode(bytes, { stream: true });
      if ((lastCR && text && !text.startsWith('\n')) || /\r(?!\n|$)/.test(text)) throw new Error('bare CR');
      if (text) lastCR = text.endsWith('\r');
    }
    decoder.decode(); if (lastCR) throw new Error('bare CR'); return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

function visit(node: Nodes, callback: (node: Nodes) => void): void {
  callback(node);
  if ('children' in node) node.children.forEach(child => visit(child, callback));
}

/** All top-level Markdown headings, at every depth (including Setext),
 * partition every line. Front matter, comments, code and managed bytes stay
 * in the reviewed input; nothing is extracted away to evade freshness. */
export function notebookReviewSections(text: string): NotebookReviewSection[] {
  const lines = text.split('\n');
  const headings = fromMarkdown(text).children.filter(node => node.type === 'heading');
  const starts = headings.map(node => ({ line: node.position!.start.line,
    heading: lines.slice(node.position!.start.line - 1, node.position!.end.line).join('\n') }));
  if (!starts.length || starts[0]!.line !== 1) starts.unshift({ line: 1, heading: '(front matter)' });
  return starts.map((entry, index) => {
    const end = (starts[index + 1]?.line ?? (lines.length + 1)) - 1;
    return { section_id: `lines-${entry.line}-${end}`, heading: entry.heading,
      start_line: entry.line, end_line: end,
      sha256: hash(lines.slice(entry.line - 1, end).join('\n')) };
  });
}

function destinations(text: string): string[] {
  // Parse math as opaque AST nodes: brackets and reference definitions inside
  // formulas are not Markdown dependencies. The original snapshot stays intact.
  const tree = fromMarkdown(text, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] });
  const definitions = new Map<string, string>();
  visit(tree, node => { if (node.type === 'definition') definitions.set(node.identifier, node.url); });
  const targets: string[] = [];
  visit(tree, node => {
    if (node.type === 'link' || node.type === 'image') targets.push(node.url);
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const target = definitions.get(node.identifier); if (target) targets.push(target);
    }
  });
  return targets;
}

function writeJson(filename: string, value: unknown): void {
  writeBytesAtomicDurable(filename, JSON.stringify(value, null, 2) + '\n', undefined,
    () => { if (fs.existsSync(filename)) throw new Error(`immutable notebook review file already exists: ${filename}`); });
}

function withReviewControlLock<T>(projectRoot: string, action: () => T): T {
  const controlPath = path.join(projectRoot, 'artifacts/notebook-review-control');
  fs.mkdirSync(path.dirname(controlPath), { recursive: true });
  assertNoSymlinkComponents(projectRoot, `${controlPath}.lock`, 'notebook review control lock', { allowMissingLeaf: true });
  return withLedgerLock(controlPath, 'Confirm no notebook-review writer is active before removing its control lock.', action);
}

// Every control mutation holds the same short cross-process lock. A completed
// writer may clear its own pending marker, never another writer's marker.
function clearOwnPending(projectRoot: string, runId: string): void {
  const pendingPath = path.join(projectRoot, PENDING);
  assertNoSymlinkComponents(projectRoot, pendingPath, 'pending notebook review', { allowMissingLeaf: true });
  try {
    if (JSON.parse(fs.readFileSync(pendingPath, 'utf8')).run_id === runId) fs.rmSync(pendingPath, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function notebookStarts(projectRoot: string): Record<string, any>[] {
  const runsPath = path.join(projectRoot, 'artifacts/runs');
  assertNoSymlinkComponents(projectRoot, runsPath, 'notebook review attempts');
  const starts: Record<string, any>[] = [];
  for (const entry of fs.readdirSync(runsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{8}T\d{6}-notebook-review-[a-f\d]{8}$/.test(entry.name)) continue;
    const filename = path.join(runsPath, entry.name, 'review_started.json');
    if (!fs.existsSync(filename)) continue;
    try {
      assertNoSymlinkComponents(projectRoot, filename, 'notebook review start');
      const started = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!object(started) || ![1, 2].includes(started.schema_version) || started.run_id !== entry.name
        || started.status !== 'unavailable' || typeof started.reason !== 'string' || !started.reason.trim()
        || !(started.previous_pointer_sha256 === null || (typeof started.previous_pointer_sha256 === 'string' && /^[a-f\d]{64}$/.test(started.previous_pointer_sha256)))
        || !(started.previous_run_id === null || (typeof started.previous_run_id === 'string' && /^[a-zA-Z0-9_-]+$/.test(started.previous_run_id)))
        || (started.schema_version === 1 && started.admission_sequence !== undefined)
        || (started.schema_version === 2 && (!Number.isSafeInteger(started.admission_sequence) || started.admission_sequence <= 0))) throw new Error('invalid recorded notebook attempt');
      starts.push(started);
    } catch (error) { throw new Error(`Notebook review start record cannot be read: ${entry.name}. ${error instanceof Error ? error.message : String(error)}`); }
  }
  return starts;
}

function latestNotebookStart(starts: Record<string, any>[]): Record<string, any> | null {
  let latest: Record<string, any> | null = null;
  const sequences = new Set<number>();
  for (const started of starts) {
    // Older immutable history has no sequence; it remains readable and is
    // still checked by its original exact-parent withdrawal below.
    if (started.admission_sequence === undefined) continue;
    if (sequences.has(started.admission_sequence)) throw new Error('Notebook review admission order is ambiguous.');
    sequences.add(started.admission_sequence);
    if (!latest || started.admission_sequence > latest.admission_sequence) latest = started;
  }
  return latest;
}

function canPublishNotebookReview(projectRoot: string, runId: string): boolean {
  const filename = path.join(projectRoot, PENDING);
  assertNoSymlinkComponents(projectRoot, filename, 'pending notebook review', { allowMissingLeaf: true });
  if (!fs.existsSync(filename)) return false;
  const pending = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (pending.run_id !== runId) return false;
  loadVerifiedRunJson(path.join(projectRoot, 'artifacts/runs', runId), runId, pending.unavailable_attempt_ref, 'notebook admission');
  return latestNotebookStart(notebookStarts(projectRoot))?.run_id === runId;
}

export function freezeNotebookReviewScope(projectRoot: string, runId: string, runDir: string, dependencies: string[], budgets: NotebookBudgets = notebookBudgets({}), evidenceManifest?: string): NotebookReviewScope {
  if (evidenceManifest !== undefined) {
    const scope = freezeDeclaredEvidenceScope(projectRoot, runId, runDir, dependencies, budgets, evidenceManifest, notebookReviewSections);
    const text = decodeText(readBytes(projectRoot, scope.notebook.path), scope.notebook.path);
    if (textOutsideNotebookCurrentState(text) === null) throw new Error('notebook has ambiguous managed-block markers');
    return scope;
  }
  const remote = new Set<string>(); const dirs = new Set<string>();
  const inputs: Input[] = []; const opaque: Input[] = []; const seen = new Set<string>(); let notebookText = '';
  const explicit = [...new Set(dependencies.map(filename => path.relative(projectRoot,
    resolveWithinRoot(projectRoot, filename, '--dependency')).split(path.sep).join('/')))];
  const queue = ['research_notebook.md', ...explicit]; let snapshotTotal = 0;
  const shortfall = (relative: string, discoveredBytes: number, reason: string): never => {
    throw new NotebookIntakeBudgetError(reason, { closure_complete: false, material_bytes_discovered: discoveredBytes,
      files_discovered: seen.size + new Set(queue.filter(i => !seen.has(i))).size, files_frozen: inputs.length + opaque.length,
      pending_sources: [...new Set([relative, ...queue].filter(i => !inputs.some(f => f.path === i) && !opaque.some(f => f.path === i)))],
      budgets, resume_command: `nullius --project-root ${notebookShellWord(projectRoot)} notebook review --model <model> --resume ${runId} --snapshot-bytes ${Math.max(budgets.snapshotBytes * 2, discoveredBytes)} --max-files ${Math.max(budgets.maxFiles * 2, seen.size + queue.length)}${explicit.map(d => ` --dependency ${notebookShellWord(d)}`).join('')}` });
  };
  while (queue.length) {
    const relative = queue.shift()!; if (seen.has(relative)) continue; seen.add(relative);
    if (seen.size > budgets.maxFiles) shortfall(relative, snapshotTotal, `Notebook storage budget exceeded: discovered ${seen.size} files; --max-files ${budgets.maxFiles}. Dependency enumeration is incomplete; retry with a larger explicit storage budget.`);
    const sourceSize = fs.statSync(resolveWithinRoot(projectRoot, relative, 'source storage budget')).size;
    if (snapshotTotal + sourceSize > budgets.snapshotBytes) shortfall(relative, snapshotTotal + sourceSize, `Notebook storage budget exceeded: at least ${snapshotTotal + sourceSize} material bytes discovered; --snapshot-bytes ${budgets.snapshotBytes}. Dependency enumeration is incomplete; retry with a larger explicit storage budget.`);
    const bytes = readBytes(projectRoot, relative); let text: string | null = null;
    try { text = decodeText(bytes, relative); }
    catch (error) {
      if (relative === 'research_notebook.md' || explicit.includes(relative)) throw error;
      if (error instanceof Error && error.message.startsWith('notebook review requires LF')) shortfall(relative, snapshotTotal + bytes.length,
        `Linked text source uses unsupported bare CR line endings: ${relative}. Original text remains pending; review is unavailable until supported original text is supplied.`);
    }
    snapshotTotal += bytes.length;
    if (snapshotTotal > budgets.snapshotBytes) shortfall(relative, snapshotTotal, 'Notebook storage budget exceeded during snapshot creation; retry with a larger --snapshot-bytes budget.');
    if (relative === 'research_notebook.md' && (!text!.trim() || textOutsideNotebookCurrentState(text!) === null)) {
      throw new Error('notebook is empty or has ambiguous managed-block markers');
    }
    if (relative === 'research_notebook.md') notebookText = text!;
    const snapshotPath = path.join(runDir, 'inputs', `source-${inputs.length + opaque.length}.${text === null ? 'bin' : 'txt'}`);
    writeBytesAtomicDurable(snapshotPath, bytes, undefined,
      () => { if (fs.existsSync(snapshotPath)) throw new Error('notebook source snapshot already exists'); });
    const input = { path: relative, sha256: hash(bytes), bytes: bytes.length,
      snapshot_ref: createRunArtifactRef(runId, runDir, snapshotPath, text === null ? 'review_locator_snapshot' : 'review_source_snapshot') };
    if (text === null) opaque.push(input); else inputs.push(input);
    // This immutable locator survives a crash during recursive intake. It does
    // not assert that the dependency closure is already complete.
    writeJson(path.join(runDir, 'inputs/intake', `checkpoint-${inputs.length + opaque.length}.json`), {
      schema_version: 1, run_id: runId, closure_complete: false, inputs: [...inputs, ...opaque] });
    if (text === null) continue;
    // Every valid UTF-8 text source can carry Markdown links. File extensions
    // do not define the recursively frozen material boundary.
    for (const raw of destinations(text)) {
      if (raw.startsWith('#')) continue;
      if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) { remote.add(raw); continue; }
      let target: string;
      try { target = decodeURIComponent(raw.split(/[?#]/, 1)[0]!); }
      catch { throw new Error(`invalid local dependency destination in ${relative}`); }
      const filename = resolveWithinRoot(projectRoot, path.resolve(projectRoot, path.dirname(relative), target), 'linked notebook dependency');
      assertNoSymlinkComponents(projectRoot, filename, 'linked notebook dependency');
      const local = path.relative(projectRoot, filename).split(path.sep).join('/');
      if (fs.statSync(filename).isDirectory()) {
        dirs.add(local);
        shortfall(local, snapshotTotal, `Linked directory content has not been read or frozen: ${local}. Original dependency closure remains pending; supply explicit original file links before review.`);
      }
      queue.push(local);
    }
  }
  const notebook = inputs[0]!;
  return { schema_version: 1, review_kind: 'notebook', extraction_policy: POLICY, notebook,
    dependencies: inputs.slice(1), opaque_links: opaque, sections: notebookReviewSections(notebookText),
    explicit_dependencies: explicit, directory_links: [...dirs].sort(), remote_links: [...remote].sort() };
}

function assertScope(scope: NotebookReviewScope, runDir: string, runId: string, projectRoot: string): Map<string, string> {
  if (scope.schema_version !== 1 || scope.review_kind !== 'notebook' || scope.extraction_policy !== POLICY
    || scope.notebook.path !== 'research_notebook.md' || !Array.isArray(scope.dependencies)) throw new Error('invalid whole-notebook review scope');
  if (scope.directory_links?.length) throw new NotebookRequestCapacityError('Historical linked directory content was not frozen; dependency closure remains unavailable. Execute a fresh review with explicit original file links.');
  const texts = new Map<string, string>();
  for (const input of [scope.notebook, ...scope.dependencies]) {
    if (texts.has(input.path)) throw new Error('duplicate notebook review input');
    const snapshot = resolveVerifiedRunArtifact(runDir, runId, input.snapshot_ref, 'notebook input snapshot');
    const text = decodeText(snapshot.bytes, input.path);
    if (hash(snapshot.bytes) !== input.sha256 || snapshot.bytes.length !== input.bytes) throw new Error('scope disagrees with its frozen source');
    texts.set(input.path, text);
  }
  if (!same(notebookReviewSections(texts.get('research_notebook.md')!), scope.sections)) throw new Error('scope does not cover every notebook line and heading');
  for (const input of scope.opaque_links ?? []) {
    if (texts.has(input.path)) throw new Error('duplicate opaque notebook source');
    const snapshot = resolveVerifiedRunArtifact(runDir, runId, input.snapshot_ref, 'opaque source snapshot');
    if (hash(snapshot.bytes) !== input.sha256 || snapshot.bytes.length !== input.bytes) throw new Error('opaque source scope disagrees with frozen bytes');
  }
  if (scope.evidence) { assertDeclaredEvidenceScope(scope, runDir, runId, projectRoot, texts); return texts; }
  // Recheck the closure from every original text snapshot. Historical scopes
  // do not gain complete coverage merely because all of their listed hashes fit.
  const recorded = new Set([...texts.keys(), ...(scope.opaque_links ?? []).map(i => i.path), ...(scope.directory_links ?? [])]);
  for (const [relative, text] of texts) {
    for (const raw of destinations(text)) {
      if (raw.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) continue;
      const target = decodeURIComponent(raw.split(/[?#]/, 1)[0]!);
      const filename = resolveWithinRoot(projectRoot, path.resolve(projectRoot, path.dirname(relative), target), 'original dependency closure');
      const local = path.relative(projectRoot, filename).split(path.sep).join('/');
      if (!recorded.has(local)) throw new Error(`whole-original dependency closure omits ${local}`);
    }
  }
  return texts;
}

function assertAnchors(anchors: unknown, text: string, from: number, to: number, bodyStart?: number): void {
  const lines = text.split('\n');
  if (Array.isArray(anchors) && anchors.length === 0 && lines.slice(from - 1, to).every(line => !line.trim())) return;
  if (!Array.isArray(anchors) || !anchors.length) throw new Error('review coverage lacks concrete source anchors');
  let bodyAnchored = bodyStart === undefined;
  for (const anchor of anchors) {
    if (!object(anchor) || !Number.isInteger(anchor.start_line) || !Number.isInteger(anchor.end_line)
      || anchor.start_line < from || anchor.end_line > to || anchor.end_line < anchor.start_line
      || typeof anchor.quote !== 'string' || !anchor.quote.trim()
      || !lines.slice(anchor.start_line - 1, anchor.end_line).join('\n').includes(anchor.quote)) throw new Error('review source anchor does not match the reviewed bytes');
    if (bodyStart !== undefined) {
      const region = lines.slice(anchor.start_line - 1, anchor.end_line).join('\n');
      let offset = region.indexOf(anchor.quote);
      while (offset !== -1) {
        const quoteStart = anchor.start_line + region.slice(0, offset).split('\n').length - 1;
        if (anchor.quote.split('\n').some((line: string, index: number) => line.trim() && quoteStart + index >= bodyStart)) { bodyAnchored = true; break; }
        offset = region.indexOf(anchor.quote, offset + 1);
      }
    }
  }
  if (!bodyAnchored) throw new Error('review cites only a heading instead of this section\'s body');
}

export function assessNotebookReviewReport(report: unknown, scope: NotebookReviewScope, texts: Map<string, string>, scopeSha256: string): { accepted: boolean; coverageComplete: boolean; reviewed: number; findings: unknown[]; reason: string } {
  if (scope.evidence) throw new Error('declared evidence requires hierarchical batch report assessment');
  if (!object(report) || report.review_kind !== 'notebook' || report.schema_version !== 1
    || !['PASS', 'FAIL'].includes(report.verdict) || typeof report.summary !== 'string' || !report.summary.trim()
    || report.scope_sha256 !== scopeSha256 || !Array.isArray(report.blocking_issues)
    || !Array.isArray(report.sections) || !Array.isArray(report.dependencies)
    || !Array.isArray(report.missing_dependencies) || typeof report.cross_section_reasoning !== 'string' || !report.cross_section_reasoning.trim()
    || !['complete', 'incomplete'].includes(report.coverage_status)
    || !['complete', 'incomplete'].includes(report.dependency_closure)) throw new Error('invalid notebook reviewer report');
  const ids = new Set<string>(); let reviewed = 0; let sectionsComplete = true;
  let coverageComplete = report.coverage_status === 'complete';
  for (const item of report.sections) {
    if (!object(item) || typeof item.section_id !== 'string' || ids.has(item.section_id)
      || typeof item.reasoning !== 'string' || !item.reasoning.trim() || !['complete', 'incomplete', 'unavailable'].includes(item.status)) throw new Error('invalid or duplicate section review');
    const section = scope.sections.find(s => s.section_id === item.section_id);
    if (!section) throw new Error('reviewed section is outside the frozen whole-notebook scope');
    const notebookText = texts.get(scope.notebook.path)!;
    const bodyStart = section.heading === '(front matter)' ? section.start_line : section.start_line + section.heading.split('\n').length;
    const hasBody = notebookText.split('\n').slice(bodyStart - 1, section.end_line).some(line => line.trim());
    assertAnchors(item.anchors, notebookText, section.start_line, section.end_line, hasBody ? bodyStart : undefined);
    ids.add(item.section_id); reviewed++;
    if (item.status !== 'complete') sectionsComplete = false;
    if (item.status === 'unavailable') coverageComplete = false;
  }
  if (ids.size !== scope.sections.length) coverageComplete = false;
  const depIds = new Set<string>();
  for (const item of report.dependencies) {
    if (!object(item) || typeof item.path !== 'string' || depIds.has(item.path)
      || typeof item.reasoning !== 'string' || !item.reasoning.trim()) throw new Error('invalid dependency review');
    const dep = scope.dependencies.find(d => d.path === item.path);
    if (!dep || dep.sha256 !== item.sha256) throw new Error('reviewed dependency does not match the frozen scope');
    const text = texts.get(dep.path)!; assertAnchors(item.anchors, text, 1, text.split('\n').length); depIds.add(item.path);
  }
  if (depIds.size !== scope.dependencies.length || report.dependency_closure !== 'complete' || report.missing_dependencies.length) coverageComplete = false;
  const opaque = scope.opaque_links ?? [];
  if (opaque.length) {
    if (!Array.isArray(report.opaque_sources) || report.opaque_sources.length !== opaque.length) throw new Error('opaque source assessment is missing');
    const seen = new Set<string>();
    for (const item of report.opaque_sources) {
      if (!object(item) || seen.has(item.path) || typeof item.required_for_reasoning !== 'boolean'
        || typeof item.reasoning !== 'string' || !item.reasoning.trim()
        || !opaque.some(input => input.path === item.path && input.sha256 === item.sha256)) throw new Error('opaque source assessment does not bind the source inventory');
      seen.add(item.path);
      if (item.required_for_reasoning) coverageComplete = false;
    }
  }
  const accepted = coverageComplete && sectionsComplete && report.verdict === 'PASS' && report.blocking_issues.length === 0;
  return { accepted, coverageComplete, reviewed, findings: report.blocking_issues,
    reason: coverageComplete ? report.summary : `Whole-notebook or necessary-dependency coverage is incomplete. ${report.summary}` };
}

function baseReport(projectRoot: string): NotebookContentReview {
  let current: string | null = null;
  try { current = streamTextIdentity(projectRoot, 'research_notebook.md'); } catch { /* reported below */ }
  return { status: 'missing', reason: 'No executed whole-notebook review is registered.', scope: SCOPE_NOTE,
    run_id: null, reviewed_notebook_sha256: null, current_notebook_sha256: current,
    sections_total: 0, sections_reviewed: 0, findings: [], evidence: [], independence: null };
}

type NotebookExecutionAssessment = {
  report: NotebookContentReview; executionAccepted: boolean;
  sourceRefs: ArtifactRefV1[]; outputRefs: ArtifactRefV1[];
};

function assessNotebookExecution(projectRoot: string, runDir: string, runId: string, execution: Execution): NotebookExecutionAssessment {
  if (execution.batch_execution_ref) {
    if (execution.schema_version !== 1 || execution.run_id !== runId || execution.review_kind !== 'notebook'
      || !same(execution.command, ['review-swarm', 'notebook-batches']) || execution.exit_status !== 0
      || !Array.isArray(execution.captured_refs) || !Number.isFinite(Date.parse(execution.started_at))
      || !Number.isFinite(Date.parse(execution.finished_at)) || Date.parse(execution.finished_at) < Date.parse(execution.started_at)) throw new Error('invalid notebook batch aggregate receipt');
    const scope = loadVerifiedRunJson<NotebookReviewScope>(runDir, runId, execution.scope_ref, 'full batched scope');
    assertScope(scope, runDir, runId, projectRoot);
    for (const ref of execution.captured_refs) resolveVerifiedRunArtifact(runDir, runId, ref, 'batch aggregate capture');
    resolveVerifiedRunArtifact(runDir, runId, execution.stdout_ref, 'batch aggregate stdout');
    resolveVerifiedRunArtifact(runDir, runId, execution.stderr_ref, 'batch aggregate stderr');
    const batches = loadVerifiedRunJson<BatchExecution>(runDir, runId, execution.batch_execution_ref, 'immutable batch aggregate');
    const assessed = assessNotebookBatches(projectRoot, runDir, runId, scope, batches, baseReport(projectRoot));
    return { ...assessed, sourceRefs: [execution.scope_ref, execution.batch_execution_ref, ...assessed.sourceRefs] };
  }
  const result = { ...baseReport(projectRoot), run_id: runId };
  let executionAccepted = false;
  let sourceRefs: ArtifactRefV1[] = []; let outputRefs: ArtifactRefV1[] = [];
  const assess = (): NotebookContentReview => {
    try {
      if (execution.schema_version !== 1 || execution.run_id !== runId || execution.review_kind !== 'notebook'
        || !Array.isArray(execution.command) || !execution.command.includes('--role') || !execution.command.includes('notebook')
        || !Array.isArray(execution.captured_refs) || !execution.started_at || !execution.finished_at) throw new Error('invalid notebook execution receipt');
      for (const ref of execution.captured_refs) resolveVerifiedRunArtifact(runDir, runId, ref, 'review execution capture');
      resolveVerifiedRunArtifact(runDir, runId, execution.stdout_ref, 'review stdout');
      resolveVerifiedRunArtifact(runDir, runId, execution.stderr_ref, 'review stderr');
      const scope = loadVerifiedRunJson<NotebookReviewScope>(runDir, runId, execution.scope_ref, 'notebook review scope');
      if (scope.evidence) throw new Error('declared evidence requires canonical source batches and integration execution');
      const texts = assertScope(scope, runDir, runId, projectRoot);
      result.reviewed_notebook_sha256 = scope.notebook.sha256; result.sections_total = scope.sections.length;
      sourceRefs = [execution.scope_ref, scope.notebook.snapshot_ref, ...scope.dependencies.map(dep => dep.snapshot_ref), ...(scope.opaque_links ?? []).map(input => input.snapshot_ref), ...(execution.manifest_ref ? [execution.manifest_ref] : [])];
      outputRefs = execution.report_ref ? [execution.report_ref] : [];
      if (execution.exit_status !== 0 && execution.exit_status !== 86) return { ...result, status: 'unavailable', reason: 'Reviewer execution failed or was unavailable; its output supplies no acceptance.' };
      if (execution.exit_status === 86 && execution.pre_freshness_ref && !execution.post_freshness_ref) {
        const pre = loadVerifiedRunJson<any>(runDir, runId, execution.pre_freshness_ref, 'pre-review freshness');
        if (pre.status === 'STALE') return { ...result, status: 'stale', reason: 'Inputs changed before reviewer launch.' };
      }
      if (!execution.manifest_ref || !execution.meta_ref || !execution.trace_ref || !execution.report_ref
        || !execution.pre_freshness_ref || !execution.post_freshness_ref) throw new Error('review execution evidence is incomplete');
      const manifest = loadVerifiedRunJson<any>(runDir, runId, execution.manifest_ref, 'review-swarm input manifest');
      const meta = loadVerifiedRunJson<any>(runDir, runId, execution.meta_ref, 'review-swarm metadata');
      const pre = loadVerifiedRunJson<any>(runDir, runId, execution.pre_freshness_ref, 'pre-review freshness');
      const post = loadVerifiedRunJson<any>(runDir, runId, execution.post_freshness_ref, 'post-review freshness');
      if (pre.status !== 'FRESH' || post.status !== 'FRESH' || pre.manifest_sha256 !== execution.manifest_ref.sha256
        || post.manifest_sha256 !== execution.manifest_ref.sha256) return { ...result, status: 'stale', reason: 'Inputs did not remain identical before and after reviewer execution.' };
      if (manifest.role !== 'notebook' || manifest.schema_version !== 1 || manifest.target_diff !== null || !Array.isArray(manifest.file_inputs)) throw new Error('review-swarm manifest is not a full notebook input');
      const executionRoot = manifest.working_directory;
      if (typeof executionRoot !== 'string' || !path.isAbsolute(executionRoot)) throw new Error('review manifest has no absolute execution root');
      for (const input of [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])]) {
        const entries = manifest.file_inputs.filter((entry: any) => entry.path === path.join(executionRoot, input.path));
        if (entries.length !== 1 || entries[0].sha256 !== input.sha256 || entries[0].bytes !== input.bytes) throw new Error('reviewer did not receive every frozen input byte');
      }
      const scopePath = resolveVerifiedRunArtifact(runDir, runId, execution.scope_ref, 'review scope').filePath;
      if (!manifest.file_inputs.some((entry: any) => entry.path === path.join(executionRoot, path.relative(projectRoot, scopePath)) && entry.sha256 === execution.scope_ref.sha256)) throw new Error('reviewer did not receive the whole-notebook coverage inventory');
      const trace = resolveVerifiedRunArtifact(runDir, runId, execution.trace_ref, 'review-swarm trace').bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      if (!trace.some(event => event.event === 'agent_0_start') || !trace.some(event => event.event === 'agent_0_end' && event.exit_code === 0 && event.timed_out === false)) throw new Error('launcher trace lacks a successful reviewer process');
      const agents = meta.agents;
      if (meta.n_agents !== 1 || !Array.isArray(agents) || agents.length !== 1 || agents[0].success !== true || agents[0].contract_ok !== true
        || agents[0].partial) throw new Error('reviewer delivery is unavailable, partial or invalid');
      if (agents[0].execution_tool_mode !== 'none') return { ...result, status: 'unavailable', reason: 'Whole-notebook review currently requires reviewer tool mode none.' };
      if (meta.independence?.non_independent_lanes?.some((lane: any) => lane.reason !== 'family_unknown')) throw new Error('reviewer delivery is contaminated');
      result.independence = { ...meta.independence, review_seats: 1, reviewer_identity: agents[0].family_evidence,
        method: 'single full-text semantic assessment; method independence not machine verified', input_framing: 'not_machine_verified',
        packet_structure: 'full notebook, scope inventory and declared dependencies; no separate expected-verdict input' };
      const rawPath = resolveVerifiedRunArtifact(runDir, runId, execution.report_ref, 'reviewer report').filePath;
      if (path.resolve(agents[0].out) !== path.join(executionRoot, path.relative(projectRoot, rawPath))) throw new Error('report is not the launcher-executed reviewer output');
      const report = loadVerifiedRunJson<unknown>(runDir, runId, execution.report_ref, 'notebook semantic report');
      const assessed = assessNotebookReviewReport(report, scope, texts, execution.scope_ref.sha256);
      result.sections_reviewed = assessed.reviewed; result.findings = assessed.findings;
      if (execution.exit_status !== 0) return { ...result, status: 'unavailable', reason: 'Reviewer process did not finish successfully.' };
      if (executionRoot !== projectRoot) return { ...result, status: 'unavailable', reason: 'Review execution belongs to another project location; frozen history remains readable. Execute a current review here.' };
      executionAccepted = false;
      const tokenEvidence = assessNotebookRequestCapacity(runDir, runId, execution.captured_refs, [execution.scope_ref, scope.notebook.snapshot_ref, ...scope.dependencies.map(i => i.snapshot_ref)], notebookBudgets(execution.request_budgets ?? {}).contextTokens, { report: execution.report_ref, meta: execution.meta_ref, manifest: execution.manifest_ref });
      result.progress = { capacity_evidence: tokenEvidence };
      for (const input of [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])]) {
        try { if (hash(readBytes(projectRoot, input.path)) !== input.sha256) return { ...result, status: 'stale', reason: `Reviewed input changed: ${input.path}` }; }
        catch { return { ...result, status: 'stale', reason: `Reviewed input missing, unreadable or redirected: ${input.path}` }; }
      }
      const reviewDir = path.join(runDir, 'review');
      let freshnessScript: string;
      try { freshnessScript = path.join(installedRuntimeRoot(), 'skills/review-swarm/scripts/bin/verify_review_freshness.py'); }
      catch { return { ...result, status: 'unavailable', reason: 'Installed review-swarm runtime is unavailable; history remains readable.' }; }
      const live = spawnSync('python3', [freshnessScript, '--review-dir', reviewDir], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
      if (live.error || live.status !== 0) return { ...result, status: live.status === 3 ? 'stale' : 'unavailable', reason: 'Current review-swarm input freshness cannot be confirmed.' };
      const freshness = JSON.parse(live.stdout);
      if (freshness.status !== 'FRESH' || freshness.manifest_sha256 !== execution.manifest_ref.sha256) return { ...result, status: 'stale', reason: 'Current reviewer inputs are stale.' };
      executionAccepted = assessed.accepted && execution.exit_status === 0;
      return { ...result, status: assessed.accepted ? 'accepted' : assessed.coverageComplete ? 'rejected' : 'incomplete', reason: assessed.reason };
    } catch (error) {
      if (error instanceof NotebookRequestCapacityError) return { ...result, status: 'unavailable', reason: error.message };
      return { ...result, status: 'rejected', reason: `Notebook review evidence is invalid: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const report = assess();
  return { report, executionAccepted, sourceRefs, outputRefs };
}

function assertCanonicalOutcome(check: VerificationCheckRunV1, verdict: VerificationSubjectVerdictV1,
  coverage: VerificationCoverageV1, accepted: boolean): void {
  if (verdict.status !== (accepted ? 'verified' : 'failed') || check.status !== (accepted ? 'passed' : 'failed')
    || !same(coverage.summary, { subjects_total: 1, subjects_verified: accepted ? 1 : 0,
      subjects_partial: 0, subjects_failed: accepted ? 0 : 1, subjects_blocked: 0, subjects_not_attempted: 0 })
    || (accepted && (verdict.missing_decisive_checks.length || coverage.missing_decisive_checks.length))) throw new Error('canonical verdict disagrees with admissible executed review');
}

/** Current read model. History is never rewritten, and an unavailable review
 * cannot make ordinary status/current or historical artifact reads fail. */
export function checkNotebookContentReview(projectRoot: string): NotebookContentReview {
  try { projectRoot = fs.realpathSync.native(projectRoot); } catch { /* base report records unavailable inputs */ }
  const result = baseReport(projectRoot);
  if (result.current_notebook_sha256 === null) return { ...result, status: 'unavailable', reason: 'research_notebook.md is missing, unreadable or unsupported UTF-8 text.' };
  let pointerPath = path.join(projectRoot, POINTER);
  try { fs.lstatSync(path.join(projectRoot, PENDING)); pointerPath = path.join(projectRoot, PENDING); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ...result, status: 'unavailable', reason: 'Current notebook review attempt cannot be read.' }; }
  if (!fs.existsSync(pointerPath)) {
    try {
      if (!fs.existsSync(path.join(projectRoot, 'artifacts/runs'))) return result;
      const latest = latestNotebookStart(notebookStarts(projectRoot));
      if (!latest) return result;
      const filename = path.join(projectRoot, 'artifacts/runs', latest.run_id, 'review_started.json');
      return { ...result, status: 'unavailable', reason: latest.reason, run_id: latest.run_id,
        previous_run_id: latest.previous_run_id, evidence: [createRunArtifactRef(latest.run_id, path.dirname(filename), filename, 'review_setup_attempt')] };
    } catch (error) { return { ...result, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
  }
  try {
    assertNoSymlinkComponents(projectRoot, pointerPath, 'notebook review pointer');
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as ReviewPointer;
    if (pointer.schema_version !== 1 || typeof pointer.run_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(pointer.run_id)) throw new Error('invalid notebook review pointer');
    const runDir = path.join(projectRoot, 'artifacts', 'runs', pointer.run_id);
    let starts: Record<string, any>[];
    try { starts = notebookStarts(projectRoot); }
    catch (error) { return { ...result, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
    let latest: Record<string, any> | null;
    try { latest = latestNotebookStart(starts); }
    catch (error) { return { ...result, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
    if (latest && latest.run_id !== pointer.run_id) {
      const filename = path.join(projectRoot, 'artifacts/runs', latest.run_id, 'review_started.json');
      return { ...result, status: 'unavailable', reason: latest.reason, run_id: latest.run_id,
        previous_run_id: latest.previous_run_id, evidence: [createRunArtifactRef(latest.run_id, path.dirname(filename), filename, 'review_setup_attempt')] };
    }
    if (pointerPath === path.join(projectRoot, POINTER)) {
      // The immutable start record also withdraws this exact old pointer if
      // permissions prevent publishing either mutable control pointer.
      const pointerSha256 = hash(fs.readFileSync(pointerPath));
      for (const started of starts) {
        if (started.run_id === pointer.run_id) continue;
        const startedPath = path.join(projectRoot, 'artifacts/runs', started.run_id, 'review_started.json');
        if (started.previous_pointer_sha256 === pointerSha256 || started.previous_run_id === pointer.run_id) {
          return { ...result, status: 'unavailable', reason: started.reason, run_id: started.run_id,
            previous_run_id: pointer.run_id, evidence: [createRunArtifactRef(started.run_id, path.dirname(startedPath), startedPath, 'review_setup_attempt')] };
        }
      }
    }
    if ('unavailable_attempt_ref' in pointer) {
      const attempt = loadVerifiedRunJson<any>(runDir, pointer.run_id, pointer.unavailable_attempt_ref as ArtifactRefV1, 'notebook setup attempt');
      if (![1, 2].includes(attempt.schema_version) || attempt.run_id !== pointer.run_id || attempt.status !== 'unavailable'
        || (attempt.schema_version === 2 && (!Number.isSafeInteger(attempt.admission_sequence) || attempt.admission_sequence <= 0))
        || typeof attempt.reason !== 'string' || !attempt.reason.trim()
        || !(attempt.previous_run_id === null || (typeof attempt.previous_run_id === 'string' && /^[a-zA-Z0-9_-]+$/.test(attempt.previous_run_id)))) throw new Error('invalid notebook setup attempt');
      return { ...result, status: 'unavailable', reason: attempt.reason, run_id: pointer.run_id,
        previous_run_id: attempt.previous_run_id, ...(attempt.progress ? { progress: attempt.progress } : {}), evidence: [pointer.unavailable_attempt_ref as ArtifactRefV1] };
    }
    const buckets = ['subject_refs', 'check_run_refs', 'subject_verdict_refs', 'coverage_refs'] as const;
    const values = buckets.map((key, index) => {
      const refs = pointer.verification_refs?.[key]; if (!Array.isArray(refs) || refs.length !== 1) throw new Error('incomplete notebook verification refs');
      const raw = loadVerifiedRunJson<unknown>(runDir, pointer.run_id, refs[0]!, key);
      if (!validators[index]!(raw)) throw new Error(`invalid canonical notebook ${key}`);
      return raw;
    });
    const [subject, check, verdict, coverage] = values as [VerificationSubjectV1, VerificationCheckRunV1, VerificationSubjectVerdictV1, VerificationCoverageV1];
    result.run_id = pointer.run_id;
    if (subject.run_id !== pointer.run_id || check.run_id !== pointer.run_id || verdict.run_id !== pointer.run_id || coverage.run_id !== pointer.run_id
      || subject.subject_id !== check.subject_id || subject.subject_id !== verdict.subject_id || subject.subject_kind !== 'deliverable'
      || check.check_kind !== KIND || check.check_role !== 'supporting'
      || !same(check.subject_ref, pointer.verification_refs.subject_refs[0]) || !same(verdict.subject_ref, check.subject_ref)
      || !same(verdict.check_run_refs, pointer.verification_refs.check_run_refs)
      || !same(coverage.subject_refs, pointer.verification_refs.subject_refs) || !same(coverage.subject_verdict_refs, pointer.verification_refs.subject_verdict_refs)) throw new Error('notebook verification identities or coverage disagree');
    const executionRefs = check.evidence_refs.filter(ref => ref.kind === 'review_execution');
    if (executionRefs.length !== 1) throw new Error('executed reviewer receipt is missing');
    const execution = loadVerifiedRunJson<Execution>(runDir, pointer.run_id, executionRefs[0]!, 'notebook reviewer execution');
    const assessed = assessNotebookExecution(projectRoot, runDir, pointer.run_id, execution);
    if (!same(subject.source_refs, assessed.sourceRefs) || !same(check.input_artifact_refs, assessed.sourceRefs)
      || !same(check.output_artifact_refs, assessed.outputRefs)) throw new Error('canonical notebook input/output refs do not match reviewer execution');
    // Historical canonical outcomes remain immutable. Missing runtime authority
    // or changed live material withdraws current acceptance, without rewriting
    // that historical outcome or relabeling unavailable evidence as rejection.
    assertCanonicalOutcome(check, verdict, coverage, check.status === 'passed');
    if (check.status === 'failed' && assessed.executionAccepted) {
      assessed.executionAccepted = false;
      assessed.report = { ...assessed.report, status: 'unavailable', reason: 'The immutable canonical outcome recorded a failed or unavailable review. Historical capacity cannot be retroactively admitted; execute a fresh review.' };
    }
    if (assessed.report.status !== 'unavailable' && assessed.report.status !== 'stale') assertCanonicalOutcome(check, verdict, coverage, assessed.executionAccepted);
    return { ...assessed.report, evidence: [...pointer.verification_refs.subject_refs, ...pointer.verification_refs.check_run_refs,
      ...pointer.verification_refs.subject_verdict_refs, ...pointer.verification_refs.coverage_refs, executionRefs[0]!] };
  } catch (error) {
    if (error instanceof NotebookRequestCapacityError) return { ...result, status: 'unavailable', reason: error.message };
    return { ...result, status: 'rejected', reason: `Notebook review evidence is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function capturedFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('review capture must not be a symlink');
    return entry.isDirectory() ? capturedFiles(file) : entry.isFile() ? [file] : [];
  });
}

/** There is no user-supplied PASS/import path. The public command executes
 * review-swarm and registers its hashed output as canonical verification. */
/** The receipt ref of the reviewer's report file the launcher names, which
 *  must lie inside the run and not be reached through a symlink below it;
 *  null when that file does not exist. */
export function reviewerReportRef(runId: string, runDir: string, output: string): ArtifactRefV1 | null {
  const filename = resolveWithinRoot(runDir, output, 'reviewer output');
  assertNoSymlinkComponents(runDir, filename, 'reviewer output', { allowMissingLeaf: true });
  return fs.existsSync(filename) ? createRunArtifactRef(runId, runDir, filename, 'notebook_reviewer_report') : null;
}

export async function runNotebookReview(projectRoot: string, options: { model: string; dependencies: string[]; timeoutSecs: number; json: boolean; budgets?: Partial<NotebookBudgets>; resume?: string; evidenceManifest?: string },
  io: { stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-notebook-review-${randomUUID().slice(0, 8)}`;
  let runDir = path.join(projectRoot, 'artifacts/runs', runId);
  let previousRunId: string | null = null;
  let previousPointerSha256: string | null = null;
  try {
    projectRoot = fs.realpathSync.native(projectRoot);
    runDir = path.join(projectRoot, 'artifacts/runs', runId);
    // Publish a durable fail-closed attempt before touching the old current
    // pointer. A locked old pointer cannot retain current acceptance.
    withReviewControlLock(projectRoot, () => {
      const pointerPath = path.join(projectRoot, POINTER);
      assertNoSymlinkComponents(projectRoot, pointerPath, 'notebook review pointer', { allowMissingLeaf: true });
      if (fs.existsSync(pointerPath)) {
        previousPointerSha256 = hash(fs.readFileSync(pointerPath));
        try {
          const previous = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
          if (typeof previous.run_id === 'string' && /^[a-zA-Z0-9_-]+$/.test(previous.run_id)) previousRunId = previous.run_id;
        } catch { /* invalid prior pointers grant no acceptance */ }
      }
      assertNoSymlinkComponents(projectRoot, runDir, 'notebook review run'); fs.mkdirSync(runDir, { recursive: true });
      for (const directory of [runDir, path.dirname(runDir), path.dirname(path.dirname(runDir))]) fsyncParentDirectoryDurable(directory);
      const admissionSequence = (latestNotebookStart(notebookStarts(projectRoot))?.admission_sequence ?? 0) + 1;
      if (!Number.isSafeInteger(admissionSequence)) throw new Error('Notebook review admission order cannot be extended.');
      const startedPath = path.join(runDir, 'review_started.json');
      writeBytesAtomicDurable(startedPath, JSON.stringify({ schema_version: 2, run_id: runId, status: 'unavailable',
        reason: 'A new notebook review has started without a completed current registration.',
        previous_run_id: previousRunId, previous_pointer_sha256: previousPointerSha256, admission_sequence: admissionSequence }, null, 2) + '\n', undefined,
        () => { if (fs.existsSync(startedPath)) throw new Error('notebook review start record already exists'); });
      const pendingPath = path.join(projectRoot, PENDING);
      assertNoSymlinkComponents(projectRoot, pendingPath, 'pending notebook review', { allowMissingLeaf: true });
      writeBytesAtomicDurable(pendingPath, JSON.stringify({ schema_version: 1, run_id: runId,
        unavailable_attempt_ref: createRunArtifactRef(runId, runDir, startedPath, 'review_setup_attempt') }, null, 2) + '\n');
    });
    // Stamping can refresh managed navigation. Do it before freezing inputs,
    // never after a review whose full-byte binding includes those blocks.
    const stamped = stampRunDirectory(projectRoot, runDir, { actor: 'notebook-review' });
    if (stamped.kind === 'rejected') throw new Error(stamped.message);
    let budgetOptions = options.budgets ?? {};
    let dependencies = options.dependencies;
    let evidenceManifest = options.evidenceManifest;
    let batchResume: string | undefined;
    if (options.resume) {
      if (!/^[a-zA-Z0-9_-]+$/.test(options.resume)) throw new Error('invalid notebook resume run ID');
      const origin = path.join(projectRoot, 'artifacts/runs', options.resume);
      assertNoSymlinkComponents(projectRoot, origin, 'notebook resume history');
      const finalPath = path.join(origin, 'review_execution.json');
      const resumePath = path.join(origin, 'review_resume.json');
      const intakePath = path.join(origin, 'review_intake.json');
      let oldScope: NotebookReviewScope | undefined;
      let oldBudgets: NotebookBudgets;
      let oldDependencies: string[];
      if (fs.existsSync(finalPath) || fs.existsSync(resumePath)) {
        const previous = JSON.parse(fs.readFileSync(fs.existsSync(finalPath) ? finalPath : resumePath, 'utf8'));
        if (previous.model !== undefined && previous.model !== options.model) throw new Error('resumed reviewer model must match the original model');
        if (fs.existsSync(finalPath) && !previous.batch_execution_ref) throw new Error('resume requires a batched notebook review; start a fresh review for a single-call run');
        oldScope = loadVerifiedRunJson<NotebookReviewScope>(origin, options.resume, previous.scope_ref, 'resume full scope');
        assertScope(oldScope, origin, options.resume, projectRoot);
        oldBudgets = notebookBudgets(previous.request_budgets);
        if (!same(previous.request_budgets, oldBudgets)) throw new Error('resume resource budgets are missing or invalid');
        oldDependencies = oldScope.explicit_dependencies;
        if (evidenceManifest !== undefined && !oldScope.evidence) throw new Error('cannot resume with a different evidence policy');
        if (oldScope.evidence) {
          if (evidenceManifest !== undefined && evidenceManifest !== oldScope.evidence.manifest.path) throw new Error('resumed evidence manifest path must match');
          evidenceManifest = oldScope.evidence.manifest.path;
          if (!declaredEvidenceIsCurrent(projectRoot, oldScope)) throw new Error('resumed declared evidence changed');
        }
        if (fs.existsSync(path.join(origin, 'batches/start.json')) || fs.existsSync(finalPath)) {
          const oldBatch = loadNotebookBatchHistory(projectRoot, options.resume);
          const oldPlan = loadVerifiedRunJson<BatchPlan>(origin, options.resume, oldBatch.plan_ref, 'resume recorded budgets');
          if (!same(oldPlan.budgets, oldBudgets)) throw new Error('resume resource budgets do not match their immutable plan');
          batchResume = options.resume;
        }
      } else {
        if (!fs.existsSync(intakePath)) throw new Error('notebook resume has no recorded intake or batch plan');
        const intake = JSON.parse(fs.readFileSync(intakePath, 'utf8'));
        if (intake.schema_version !== 1 || intake.run_id !== options.resume || intake.model !== options.model || !Array.isArray(intake.dependencies)) throw new Error('invalid interrupted notebook intake');
        oldBudgets = notebookBudgets(intake.budgets); oldDependencies = intake.dependencies;
        if (intake.evidence_manifest !== undefined || evidenceManifest !== undefined) throw new Error('declared evidence intake has no complete frozen scope; start a fresh review');
        const checkpoints = path.join(origin, 'inputs/intake');
        if (fs.existsSync(checkpoints)) for (const name of fs.readdirSync(checkpoints)) {
          if (!/^checkpoint-\d+\.json$/.test(name)) continue;
          const filename = path.join(checkpoints, name); assertNoSymlinkComponents(projectRoot, filename, 'interrupted intake checkpoint');
          const checkpoint = JSON.parse(fs.readFileSync(filename, 'utf8'));
          if (checkpoint.schema_version !== 1 || checkpoint.run_id !== options.resume || checkpoint.closure_complete !== false || !Array.isArray(checkpoint.inputs)) throw new Error('invalid interrupted intake checkpoint');
          for (const input of checkpoint.inputs as Input[]) {
            const original = resolveVerifiedRunArtifact(origin, options.resume, input.snapshot_ref, 'interrupted intake source').bytes;
            if (hash(original) !== input.sha256 || original.length !== input.bytes || hash(readBytes(projectRoot, input.path)) !== input.sha256) throw new Error('interrupted intake original source changed; start a fresh review');
          }
        }
      }
      budgetOptions = { ...oldBudgets, ...budgetOptions };
      dependencies = [...new Set([...oldDependencies, ...dependencies])];
    }
    const budgets = notebookBudgets(budgetOptions);
    writeJson(path.join(runDir, 'review_intake.json'), { schema_version: 1, run_id: runId, model: options.model, budgets, dependencies, ...(evidenceManifest === undefined ? {} : { evidence_manifest: evidenceManifest }), resumed_from: options.resume ?? null });
    const scope = freezeNotebookReviewScope(projectRoot, runId, runDir, dependencies, budgets, evidenceManifest);
    const scopePath = path.join(runDir, 'inputs/notebook-scope.json'); writeJson(scopePath, scope);
    const scopeRef = createRunArtifactRef(runId, runDir, scopePath, 'notebook_review_scope');
    writeJson(path.join(runDir, 'review_resume.json'), { schema_version: 1, run_id: runId, model: options.model, request_budgets: budgets, scope_ref: scopeRef });
    const script = path.join(installedRuntimeRoot(), 'skills/review-swarm/scripts/bin/review_one.py');
    let receipt: Execution;
    const totalText = [scope.notebook, ...scope.dependencies].reduce((n, input) => n + input.bytes, 0);
    if (scope.evidence || options.resume || totalText > Math.floor((budgets.contextBytes - 12000) / 4) || totalText + fs.statSync(scopePath).size + 12000 > budgets.contextBytes) {
      const started = new Date().toISOString();
      const batches = await executeNotebookBatches(projectRoot, runDir, runId, scope, budgets, options.model, options.timeoutSecs, batchResume);
      const batchPath = path.join(runDir, 'batch_execution.json'); writeJson(batchPath, batches);
      const stdoutPath = path.join(runDir, 'review.stdout.txt'); const stderrPath = path.join(runDir, 'review.stderr.txt');
      writeBytesAtomicDurable(stdoutPath, 'Per-batch execution output is preserved in its immutable receipt.\n', undefined,
        () => { if (fs.existsSync(stdoutPath)) throw new Error('immutable batch aggregate stdout already exists'); });
      writeBytesAtomicDurable(stderrPath, batches.stop_reason ?? '', undefined,
        () => { if (fs.existsSync(stderrPath)) throw new Error('immutable batch aggregate stderr already exists'); });
      receipt = { schema_version: 1, run_id: runId, review_kind: 'notebook', command: ['review-swarm', 'notebook-batches'],
        started_at: started, finished_at: new Date().toISOString(), exit_status: 0, scope_ref: scopeRef,
        stdout_ref: createRunArtifactRef(runId, runDir, stdoutPath, 'review_stdout'), stderr_ref: createRunArtifactRef(runId, runDir, stderrPath, 'review_stderr'),
        captured_refs: [], request_budgets: budgets, batch_execution_ref: createRunArtifactRef(runId, runDir, batchPath, 'notebook_batch_aggregate') };
    } else {
    const command = ['python3', script, '--model', options.model, '--role', 'notebook', '--artifact', path.join(projectRoot, 'research_notebook.md'),
      '--context', scopePath, '--out-dir', path.join(runDir, 'review'), '--timeout-secs', String(options.timeoutSecs), '--max-attempts', '1', '--max-prompt-bytes', String(budgets.contextBytes), '--context-tokens', String(budgets.contextTokens)];
    if (options.model.startsWith('claude/')) command.push('--claude-live-capture');
    for (const dep of scope.dependencies) command.push('--context', path.join(projectRoot, dep.path));
    for (const input of scope.opaque_links ?? []) command.push('--locator', path.join(projectRoot, input.path));
    const stdoutPath = path.join(runDir, 'review.stdout.txt'); const stderrPath = path.join(runDir, 'review.stderr.txt');
    const stdout = fs.openSync(stdoutPath, 'wx'); const stderr = fs.openSync(stderrPath, 'wx');
    const started = new Date().toISOString();
    const exitStatus = await new Promise<number | null>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), { cwd: projectRoot, stdio: ['ignore', stdout, stderr] });
      const interrupt = () => child.kill('SIGTERM'); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      child.once('error', () => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); resolve(null); });
      child.once('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); resolve(code); });
    });
    fs.closeSync(stdout); fs.closeSync(stderr);
    receipt = { schema_version: 1, run_id: runId, review_kind: 'notebook', command,
      started_at: started, finished_at: new Date().toISOString(), exit_status: exitStatus, scope_ref: scopeRef,
      stdout_ref: createRunArtifactRef(runId, runDir, stdoutPath, 'review_stdout'), stderr_ref: createRunArtifactRef(runId, runDir, stderrPath, 'review_stderr'), captured_refs: [], request_budgets: budgets };
    for (const [field, relative, kind] of [
      ['manifest_ref', 'review/inputs/review_input_manifest.json', 'review_input_manifest'],
      ['meta_ref', 'review/meta.json', 'review_metadata'], ['trace_ref', 'review/trace.jsonl', 'review_trace'],
      ['pre_freshness_ref', 'review/pre_review_freshness.json', 'review_freshness'],
      ['post_freshness_ref', 'review/post_review_freshness.json', 'review_freshness'],
    ] as const) if (fs.existsSync(path.join(runDir, relative))) receipt[field] = createRunArtifactRef(runId, runDir, path.join(runDir, relative), kind);
    if (receipt.meta_ref) {
      try {
        const meta = loadVerifiedRunJson<any>(runDir, runId, receipt.meta_ref, 'review metadata');
        const output = meta.agents?.[0]?.out;
        if (typeof output === 'string') {
          const reportRef = reviewerReportRef(runId, runDir, output);
          if (reportRef) receipt.report_ref = reportRef;
        }
      } catch { /* shared assessment records invalid delivery below */ }
    }
    receipt.captured_refs = capturedFiles(path.join(runDir, 'review')).map(file => createRunArtifactRef(runId, runDir, file, 'review_capture'));
    }
    const evaluated = assessNotebookExecution(projectRoot, runDir, runId, receipt);
    const problem = evaluated.report.reason;
    const executionPath = path.join(runDir, 'review_execution.json'); writeJson(executionPath, receipt);
    const executionRef = createRunArtifactRef(runId, runDir, executionPath, 'review_execution');
    const save = (name: string, value: unknown, kind: string) => { const file = path.join(runDir, 'artifacts', name); writeJson(file, value); return createRunArtifactRef(runId, runDir, file, kind); };
    const subjectId = `${runId}/notebook`;
    const sourceRefs = evaluated.sourceRefs;
    const subjectRef = save('verification_subject_notebook_v1.json', { schema_version: 1, subject_id: subjectId, subject_kind: 'deliverable', run_id: runId,
      title: 'Whole research notebook', description: SCOPE_NOTE, source_refs: sourceRefs }, 'verification_subject');
    const accepted = evaluated.executionAccepted;
    const checkRef = save('verification_check_run_notebook_v1.json', { schema_version: 1, check_run_id: `${runId}/review`, run_id: runId,
      subject_id: subjectId, subject_ref: subjectRef, check_kind: KIND, check_role: 'supporting', status: accepted ? 'passed' : 'failed', summary: problem,
      executor_provenance: { component: 'review-swarm', surface: 'review_one.py', executor_kind: 'semantic_reviewer' },
      input_artifact_refs: sourceRefs, output_artifact_refs: evaluated.outputRefs, evidence_refs: [executionRef],
      confidence: { level: 'low' }, started_at: receipt.started_at, finished_at: receipt.finished_at,
      notes: 'Single reviewer; family, method and input independence must be assessed separately. Not a decisive computation check.' }, 'verification_check_run');
    const gap = { check_kind: KIND, reason: problem, priority: 'high' };
    const verdictRef = save('verification_subject_verdict_notebook_v1.json', { schema_version: 1, verdict_id: `${runId}/verdict`, run_id: runId, subject_id: subjectId,
      subject_ref: subjectRef, status: accepted ? 'verified' : 'failed', summary: problem, check_run_refs: [checkRef], missing_decisive_checks: accepted ? [] : [gap] }, 'verification_subject_verdict');
    const coverageRef = save('verification_coverage_notebook_v1.json', { schema_version: 1, coverage_id: `${runId}/coverage`, run_id: runId, generated_at: receipt.finished_at,
      subject_refs: [subjectRef], subject_verdict_refs: [verdictRef], summary: { subjects_total: 1, subjects_verified: accepted ? 1 : 0,
        subjects_partial: 0, subjects_failed: accepted ? 0 : 1, subjects_blocked: 0, subjects_not_attempted: 0 },
      missing_decisive_checks: accepted ? [] : [{ ...gap, subject_id: subjectId, subject_ref: subjectRef }] }, 'verification_coverage');
    const pointer: ReviewPointer = { schema_version: 1, run_id: runId, verification_refs: { subject_refs: [subjectRef], check_run_refs: [checkRef], subject_verdict_refs: [verdictRef], coverage_refs: [coverageRef] } };
    withReviewControlLock(projectRoot, () => {
      if (canPublishNotebookReview(projectRoot, runId)) writeBytesAtomicDurable(path.join(projectRoot, POINTER), JSON.stringify(pointer, null, 2) + '\n');
      clearOwnPending(projectRoot, runId);
    });
    const result = checkNotebookContentReview(projectRoot);
    if (options.json) io.stdout(JSON.stringify(result, null, 2) + '\n'); else io.stdout(`Notebook content review: ${result.status}. ${result.reason}\nEvidence: ${runDir}\n${result.scope}\n`);
    return result.status === 'accepted' ? 0 : result.status === 'unavailable' ? 2 : 1;
  } catch (error) {
    let reason = error instanceof Error ? error.message : String(error);
    const progress = error instanceof NotebookIntakeBudgetError ? { ...error.progress,
      resume_command: String(error.progress.resume_command).replace('<model>', notebookShellWord(options.model)) } : undefined;
    try { withReviewControlLock(projectRoot, () => {
      assertNoSymlinkComponents(projectRoot, runDir, 'failed notebook attempt');
      assertNoSymlinkComponents(projectRoot, path.join(projectRoot, POINTER), 'notebook review pointer', { allowMissingLeaf: true });
      if (fs.existsSync(runDir)) {
        const controlFailure = fs.existsSync(path.join(runDir, 'review_execution.json'));
        const attemptPath = path.join(runDir, controlFailure ? 'review_control_failure.json' : 'review_setup_attempt.json');
        writeJson(attemptPath, { schema_version: 1, run_id: runId, status: 'unavailable', reason,
          previous_run_id: previousRunId, finished_at: new Date().toISOString(), ...(progress ? { progress } : {}) });
        if (canPublishNotebookReview(projectRoot, runId)) writeBytesAtomicDurable(path.join(projectRoot, POINTER), JSON.stringify({ schema_version: 1, run_id: runId,
          unavailable_attempt_ref: createRunArtifactRef(runId, runDir, attemptPath, controlFailure ? 'review_control_failure' : 'review_setup_attempt') }, null, 2) + '\n');
        clearOwnPending(projectRoot, runId);
      }
    }); } catch (recordError) { reason += ` Failed attempt could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)}`; }
    const result = { ...baseReport(projectRoot), status: 'unavailable', reason, run_id: runId, previous_run_id: previousRunId, ...(progress ? { progress } : {}) };
    if (options.json) io.stdout(JSON.stringify(result, null, 2) + '\n'); else io.stderr(`notebook review: ${reason}\nEvidence: ${runDir}\n`);
    return 2;
  }
}
