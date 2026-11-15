import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { writeBytesAtomicDurable, type ArtifactRefV1 } from '@nullius/shared';
import { createRunArtifactRef } from './computation/artifact-refs.js';
import { assertNoSymlinkComponents } from './computation/path-safety.js';
import { loadVerifiedRunJson, resolveVerifiedRunArtifact } from './orch-tools/validation-chain-binding.js';
import { installedRuntimeRoot } from './cli-runtime.js';
import type { NotebookContentReview, NotebookReviewScope } from './notebook-content-review.js';
import { assertNotebookRunStates, notebookRunStatesCurrent } from './notebook-run-state.js';

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const decode = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const notebookShellWord = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const obj = (a: unknown): a is Record<string, any> => !!a && typeof a === 'object' && !Array.isArray(a);
const headingCache = new WeakMap<Buffer, Array<{ from: number; to: number }>>();
export type NotebookBudgets = { contextBytes: number; contextTokens: number; snapshotBytes: number; maxFiles: number; maxBatches: number };
export class NotebookRequestCapacityError extends Error {}
function capacityRuntimeScript(name: string): string {
  try { return path.join(installedRuntimeRoot(), 'skills/review-swarm/scripts/bin', name); }
  catch (error) { throw new NotebookRequestCapacityError(`Installed review-swarm runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}
export function notebookBudgets(options: Partial<NotebookBudgets>): NotebookBudgets {
  const b = { contextBytes: 160000, contextTokens: 200000, snapshotBytes: 512 * 1024 * 1024, maxFiles: 256, maxBatches: 64, ...options };
  // The default uses a byte upper bound on tokens. An explicit larger byte
  // packet requires observed backend token usage before it can be accepted.
  if (options.contextBytes === undefined) b.contextBytes = Math.min(b.contextBytes, b.contextTokens - 32768 - 8192);
  for (const [key, value] of Object.entries(b)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid notebook resource budget: ${key}`);
  if (b.contextTokens <= 32768 + 8192 || b.contextBytes < 12004) throw new Error('context budget must leave room for instructions and reviewer output');
  return b;
}
export type Unit = { unit_id: string; path: string; sha256: string; start_byte: number; end_byte: number; body_start_byte: number };
type Anchor = { path: string; start_byte: number; end_byte: number; quote: string };
export type BatchPlan = { schema_version: 1; material_sha256: string; model: string; budgets: NotebookBudgets; units: Unit[]; text_bytes: number; material_bytes: number };
type BatchReceipt = { schema_version: 1; run_id: string; phase: 'source' | 'cross_section'; key: string; unit_ids: string[];
  inventory_ref: ArtifactRefV1; payload_ref: ArtifactRefV1; command: string[]; started_at: string; finished_at: string;
  exit_status: number | null; stdout_ref: ArtifactRefV1; stderr_ref: ArtifactRefV1; captured_refs: ArtifactRefV1[];
  manifest_ref?: ArtifactRefV1; meta_ref?: ArtifactRefV1; trace_ref?: ArtifactRefV1; report_ref?: ArtifactRefV1;
  pre_freshness_ref?: ArtifactRefV1; post_freshness_ref?: ArtifactRefV1 };
type BatchEntry = { origin_run_id: string; receipt_ref: ArtifactRefV1 };
export type BatchExecution = { schema_version: 1; plan_ref: ArtifactRefV1; entries: BatchEntry[]; stop_reason: string | null; resumed_from: string | null };
export function materialIdentity(scope: NotebookReviewScope): string {
  assertNotebookRunStates(scope, scope.run_states);
  return digest(JSON.stringify({ sources: [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])].map(i => ({ path: i.path, sha256: i.sha256, bytes: i.bytes })), run_states: scope.run_states }));
}
function immutable(file: string, data: string | Buffer): void {
  writeBytesAtomicDurable(file, data, undefined, () => { if (fs.existsSync(file)) throw new Error(`immutable notebook batch file already exists: ${file}`); });
}
function saveJson(file: string, data: unknown): void { immutable(file, JSON.stringify(data, null, 2) + '\n'); }
function sourceBytes(scope: NotebookReviewScope, runDir: string, runId: string): Map<string, Buffer> {
  return new Map([scope.notebook, ...scope.dependencies].map(i => [i.path, resolveVerifiedRunArtifact(runDir, runId, i.snapshot_ref, 'batch raw source').bytes]));
}
// Convert sorted Markdown character positions in one forward pass, rather
// than repeatedly encoding each growing prefix of a potentially large source.
function bytePositions(text: string, offsets: number[]): Map<number, number> {
  const result = new Map<number, number>(); let cursor = 0; let bytes = 0;
  for (const offset of [...new Set(offsets)].sort((a, b) => a - b)) {
    bytes += Buffer.byteLength(text.slice(cursor, offset)); result.set(offset, bytes); cursor = offset;
  }
  return result;
}
/** Prefer paragraph/line boundaries; a long line is split only at a UTF-8
 * code-point boundary. Adjacent raw units accompany each primary interval. */
export function partitionNotebookSources(sources: Map<string, Buffer>, limit: number): Unit[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid positive safe source interval budget');
  const units: Unit[] = [];
  for (const [filename, bytes] of sources) {
    const text = decode(bytes); let start = 0;
    const offsets = fromMarkdown(text).children.map(n => n.position!.end.offset!); const positions = bytePositions(text, offsets);
    const boundaries = offsets.map(offset => positions.get(offset)!).filter(n => n > 0); let boundaryIndex = 0;
    do {
      let end = Math.min(bytes.length, start + limit);
      if (end < bytes.length) {
        let block: number | undefined;
        while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= end) {
          const candidate = boundaries[boundaryIndex++]!; if (candidate > start) block = candidate;
        }
        const newline = bytes.lastIndexOf(10, end - 1);
        if (block && block >= start + Math.floor(limit / 2)) end = block;
        else if (newline >= start + Math.floor(limit / 2)) end = newline + 1;
        else while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
      }
      if (end === start && bytes.length) throw new Error('chunk budget cannot contain a UTF-8 code point');
      const raw = bytes.subarray(start, end); const text = decode(raw);
      let body = start;
      const heading = /^(?:\uFEFF)?#{1,6}[^\n]*\r?\n/.exec(text);
      if (heading && text.slice(heading[0].length).trim()) body += Buffer.byteLength(heading[0]);
      units.push({ unit_id: `source-${units.length}`, path: filename, sha256: digest(raw), start_byte: start, end_byte: end, body_start_byte: body });
      start = end;
    } while (start < bytes.length);
  }
  return units;
}
function bodyAnchor(a: Anchor, bytes: Buffer): boolean {
  let excluded = headingCache.get(bytes);
  if (!excluded) {
    const text = decode(bytes); const headings = fromMarkdown(text).children.filter(n => n.type === 'heading');
    const positions = bytePositions(text, headings.flatMap(n => [n.position!.start.offset!, n.position!.end.offset!]));
    excluded = headings.map(n => ({ from: positions.get(n.position!.start.offset!)!, to: positions.get(n.position!.end.offset!)! }));
    headingCache.set(bytes, excluded);
  }
  let from = a.start_byte;
  let lo = 0; let hi = excluded.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (excluded[mid]!.to <= from) lo = mid + 1; else hi = mid; }
  for (let index = lo; index < excluded.length; index++) {
    const h = excluded[index]!; if (h.from >= a.end_byte) break;
    if (h.to <= from || h.from >= a.end_byte) continue;
    if (decode(bytes.subarray(from, Math.min(h.from, a.end_byte))).trim()) return true;
    from = Math.max(from, h.to);
  }
  return decode(bytes.subarray(from, a.end_byte)).trim().length > 0;
}
function assertPlan(plan: BatchPlan, scope: NotebookReviewScope, sources: Map<string, Buffer>): void {
  if (plan.schema_version !== 1 || plan.material_sha256 !== materialIdentity(scope) || !Array.isArray(plan.units)
    || typeof plan.model !== 'string' || !plan.model.trim()) throw new Error('batch plan belongs to another full material');
  if (!equal(notebookBudgets(plan.budgets), plan.budgets)
    || plan.text_bytes !== [scope.notebook, ...scope.dependencies].reduce((n, i) => n + i.bytes, 0)
    || plan.material_bytes !== [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])].reduce((n, i) => n + i.bytes, 0)) throw new Error('batch plan resource or material totals are invalid');
  const ids = new Set<string>();
  for (const [filename, bytes] of sources) {
    let cursor = 0;
    const selected = plan.units.filter(u => u.path === filename);
    if (!selected.length) throw new Error('batch plan omits a necessary source');
    for (const u of selected) {
      if (typeof u.unit_id !== 'string' || !/^source-\d+$/.test(u.unit_id) || ids.has(u.unit_id) || !Number.isSafeInteger(u.start_byte) || !Number.isSafeInteger(u.end_byte) || !Number.isSafeInteger(u.body_start_byte) || u.start_byte !== cursor
        || u.end_byte < cursor || u.end_byte > bytes.length || u.body_start_byte < cursor || u.body_start_byte > u.end_byte
        || digest(bytes.subarray(cursor, u.end_byte)) !== u.sha256) throw new Error('batch plan omits, overlaps or changes a source interval');
      decode(bytes.subarray(cursor, u.end_byte)); ids.add(u.unit_id); cursor = u.end_byte;
    }
    if (cursor !== bytes.length) throw new Error('batch plan does not cover the source suffix');
  }
  if (ids.size !== plan.units.length) throw new Error('batch plan names a source outside the closure');
}
function anchor(a: unknown, sources: Map<string, Buffer>, unit?: Unit): Anchor {
  if (!obj(a) || typeof a.path !== 'string' || typeof a.quote !== 'string' || !a.quote.trim()) throw new Error('batch review needs a concrete original-source anchor');
  const bytes = sources.get(a.path); if (!bytes) throw new Error('anchor source is outside the full closure');
  let from = a.start_byte; let to = a.end_byte;
  if (from === undefined && to === undefined) {
    from = bytes.indexOf(Buffer.from(a.quote), unit?.start_byte ?? 0); to = from + Buffer.byteLength(a.quote);
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > bytes.length
    || (unit && (a.path !== unit.path || from < unit.start_byte || to > unit.end_byte))
    || decode(bytes.subarray(from, to)) !== a.quote) throw new Error('batch review anchor does not equal the original frozen bytes');
  return { path: a.path, start_byte: from, end_byte: to, quote: a.quote };
}
function validateReportBase(report: unknown, receipt: BatchReceipt): Record<string, any> {
  if (!obj(report) || report.schema_version !== 1 || report.review_kind !== (receipt.phase === 'source' ? 'notebook_batch' : 'notebook_cross_section')
    || report.inventory_sha256 !== receipt.inventory_ref.sha256 || !['PASS', 'FAIL'].includes(report.verdict)
    || typeof report.summary !== 'string' || !report.summary.trim() || !Array.isArray(report.blocking_issues)
    || !Array.isArray(report.missing_dependencies) || !['complete', 'incomplete'].includes(report.coverage_status)) throw new Error('invalid notebook batch reviewer output');
  return report;
}
function assertUnitReport(report: Record<string, any>, receipt: BatchReceipt, plan: BatchPlan, sources: Map<string, Buffer>): void {
  if (!Array.isArray(report.units) || report.units.length !== receipt.unit_ids.length) throw new Error('source batch coverage is partial');
  if (receipt.unit_ids.length !== 1) throw new Error('source batch must have one exact primary interval');
  const seen = new Set<string>();
  for (const entry of report.units) {
    const unit = plan.units.find(u => u.unit_id === entry.unit_id);
    if (!unit || !receipt.unit_ids.includes(unit.unit_id) || seen.has(unit.unit_id) || !['complete', 'incomplete'].includes(entry.status)
      || typeof entry.reasoning !== 'string' || !entry.reasoning.trim() || !Array.isArray(entry.anchors) || !Array.isArray(entry.cross_context)) throw new Error('source interval review is missing, duplicate or unexplained');
    const nonempty = decode(sources.get(unit.path)!.subarray(unit.start_byte, unit.end_byte)).trim();
    const anchors = entry.anchors.map((a: unknown) => anchor(a, sources, unit));
    const original = sources.get(unit.path)!;
    const hasBody = bodyAnchor({ path: unit.path, start_byte: unit.start_byte, end_byte: unit.end_byte, quote: nonempty }, original);
    if (hasBody && (!anchors.length || !anchors.some((a: Anchor) => bodyAnchor(a, original)))) throw new Error('source review lacks an original body anchor');
    if (nonempty && !entry.cross_context.length) throw new Error('source review must supply original context for cross-section audit');
    for (const a of entry.cross_context) anchor(a, sources, unit);
    seen.add(unit.unit_id);
  }
}
function liveMaterial(root: string, scope: NotebookReviewScope): boolean {
  try { if (!notebookRunStatesCurrent(root, scope)) return false; }
  catch { return false; }
  return [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])].every(i => {
    try {
      const file = path.join(root, i.path); assertNoSymlinkComponents(root, file, 'current batch source');
      const h = createHash('sha256'); const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(65536);
      try { let size = 0; let n: number; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { h.update(buffer.subarray(0, n)); size += n; } return size === i.bytes && h.digest('hex') === i.sha256; }
      finally { fs.closeSync(fd); }
    } catch { return false; }
  });
}
function assessReceipt(root: string, originDir: string, originId: string, receipt: BatchReceipt, plan: BatchPlan): { report: Record<string, any>; fresh: boolean; family: unknown; token_evidence: unknown } {
  if (receipt.schema_version !== 1 || receipt.run_id !== originId || !['source', 'cross_section'].includes(receipt.phase)
    || receipt.exit_status !== 0 || !Array.isArray(receipt.captured_refs) || !receipt.report_ref || !receipt.manifest_ref || !receipt.meta_ref
    || !receipt.trace_ref || !receipt.pre_freshness_ref || !receipt.post_freshness_ref || !Array.isArray(receipt.command)
    || receipt.command[receipt.command.indexOf('--model') + 1] !== plan.model) throw new Error('batch execution unavailable or incomplete');
  for (const ref of [receipt.inventory_ref, receipt.payload_ref, receipt.stdout_ref, receipt.stderr_ref, ...receipt.captured_refs]) resolveVerifiedRunArtifact(originDir, originId, ref, 'batch capture');
  const manifest = loadVerifiedRunJson<any>(originDir, originId, receipt.manifest_ref, 'batch manifest');
  const meta = loadVerifiedRunJson<any>(originDir, originId, receipt.meta_ref, 'batch metadata');
  const pre = loadVerifiedRunJson<any>(originDir, originId, receipt.pre_freshness_ref, 'batch pre freshness');
  const post = loadVerifiedRunJson<any>(originDir, originId, receipt.post_freshness_ref, 'batch post freshness');
  const role = receipt.phase === 'source' ? 'notebook-batch' : 'notebook-crosscheck';
  if (manifest.role !== role || manifest.target_diff !== null || !Array.isArray(manifest.file_inputs) || typeof manifest.working_directory !== 'string'
    || manifest.schema_version !== 1 || meta.n_agents !== 1 || !Array.isArray(meta.agents) || meta.agents.length !== 1 || meta.agents[0].success !== true || meta.agents[0].contract_ok !== true || meta.agents[0].model !== plan.model
    || meta.agents[0].partial || meta.agents[0].execution_tool_mode !== 'none') throw new Error('batch was not an admissible original-text reviewer execution');
  if (receipt.command[receipt.command.indexOf('--role') + 1] !== role) throw new Error('batch role does not match its executed command');
  if (meta.independence?.non_independent_lanes?.some((lane: any) => lane.reason !== 'family_unknown')) throw new Error('contaminated batch review');
  for (const ref of [receipt.payload_ref, receipt.inventory_ref]) {
    const target = resolveVerifiedRunArtifact(originDir, originId, ref, 'batch packet input');
    if (!manifest.file_inputs.some((i: any) => i.path === target.filePath && i.sha256 === ref.sha256 && i.bytes === target.bytes.length)) throw new Error('batch original text or inventory was not supplied');
  }
  if (meta.agents[0].out !== resolveVerifiedRunArtifact(originDir, originId, receipt.report_ref, 'batch output').filePath) throw new Error('batch report is not the executed output');
  const events = resolveVerifiedRunArtifact(originDir, originId, receipt.trace_ref, 'batch trace').bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  if (!events.some(e => e.event === 'agent_0_start') || !events.some(e => e.event === 'agent_0_end' && e.exit_code === 0 && e.timed_out === false)) throw new Error('batch reviewer process did not complete');
  if (pre.status !== 'FRESH' || post.status !== 'FRESH' || pre.manifest_sha256 !== receipt.manifest_ref.sha256 || post.manifest_sha256 !== receipt.manifest_ref.sha256) throw new Error('batch inputs changed during execution');
  const report = validateReportBase(loadVerifiedRunJson<any>(originDir, originId, receipt.report_ref, 'batch semantic report'), receipt);
  const originStart = JSON.parse(fs.readFileSync(path.join(originDir, 'batches/start.json'), 'utf8'));
  if (originStart.schema_version !== 1) throw new Error('original batch budget plan is unavailable');
  const originPlan = loadVerifiedRunJson<BatchPlan>(originDir, originId, originStart.plan_ref, 'original batch budget plan');
  if (!equal(notebookBudgets(originPlan.budgets), originPlan.budgets) || originPlan.model !== plan.model || originPlan.material_sha256 !== plan.material_sha256) throw new Error('original batch budget plan does not match its material and model');
  if (originPlan.budgets.contextTokens !== plan.budgets.contextTokens) throw new NotebookRequestCapacityError('Historical source receipts require their unchanged original token window; execute a fresh review for a different window.');
  const tokenEvidence = assessNotebookRequestCapacity(originDir, originId, receipt.captured_refs, [receipt.inventory_ref, receipt.payload_ref], originPlan.budgets.contextTokens, { report: receipt.report_ref, meta: receipt.meta_ref, manifest: receipt.manifest_ref });
  const checked = spawnSync('python3', [capacityRuntimeScript('verify_review_freshness.py'), '--review-dir', path.dirname(resolveVerifiedRunArtifact(originDir, originId, receipt.meta_ref, 'batch metadata').filePath)], { encoding: 'utf8', timeout: 10000 });
  if (checked.error || (checked.status !== 0 && checked.status !== 3)) throw new NotebookRequestCapacityError('Current batch input freshness runtime is unavailable.');
  let freshness: any;
  try { freshness = checked.status === 0 ? JSON.parse(checked.stdout) : null; }
  catch { throw new NotebookRequestCapacityError('Current batch input freshness evidence is unavailable.'); }
  return { report, fresh: manifest.working_directory === root && freshness?.status === 'FRESH' && freshness.manifest_sha256 === receipt.manifest_ref.sha256, family: meta.agents[0].family_evidence,
    token_evidence: tokenEvidence };
}
export function assessNotebookRequestCapacity(runDir: string, runId: string, capturedRefs: ArtifactRefV1[], inputs: ArtifactRefV1[], contextTokens: number,
  binding: { report: ArtifactRefV1; meta: ArtifactRefV1; manifest: ArtifactRefV1 }): unknown {
  const raw = resolveVerifiedRunArtifact(runDir, runId, binding.report, 'actual capacity output');
  const meta = loadVerifiedRunJson<any>(runDir, runId, binding.meta, 'actual capacity invocation');
  const manifest = loadVerifiedRunJson<any>(runDir, runId, binding.manifest, 'actual capacity request');
  if (!Array.isArray(meta.agents) || meta.agents.length !== 1 || meta.agents[0].success !== true
    || path.resolve(meta.agents[0].out ?? '') !== raw.filePath) throw new NotebookRequestCapacityError('capacity evidence belongs to another or failed reviewer invocation');
  const receipt = meta.agents[0].capture_receipt;
  const requestInputs = manifest.file_inputs?.filter((entry: any) => entry.kind === 'persisted_review_input');
  const originalHashes = requestInputs?.map((entry: any) => entry.sha256).sort();
  if (!Array.isArray(originalHashes) || originalHashes.length !== 2 || originalHashes.some((value: unknown) => typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value))) throw new NotebookRequestCapacityError('original reviewer request hashes are unavailable');
  const requestBytes = requestInputs.reduce((total: number, entry: any) => {
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) throw new NotebookRequestCapacityError('persisted reviewer request location is unavailable');
    const matches = capturedRefs.map(ref => resolveVerifiedRunArtifact(runDir, runId, ref, 'persisted actual request')).filter(capture => capture.filePath === entry.path);
    if (matches.length !== 1 || digest(matches[0]!.bytes) !== entry.sha256 || matches[0]!.bytes.length !== entry.bytes) throw new NotebookRequestCapacityError('complete persisted reviewer request bytes are unavailable');
    return total + matches[0]!.bytes.length;
  }, 0);
  const observationPath = raw.filePath + '.runtime-observation.json';
  if (!capturedRefs.some(ref => resolveVerifiedRunArtifact(runDir, runId, ref, 'frozen runtime observation').filePath === observationPath)) throw new NotebookRequestCapacityError('original reviewer runtime observation is missing from frozen request evidence');
  const observation = spawnSync('python3', [capacityRuntimeScript('verify_capture_observation.py')], {
    encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ budget_path: typeof receipt === 'string' ? path.resolve(receipt) : null,
      report_path: raw.filePath, input_sha256: originalHashes, expected_working_directory: manifest.working_directory, expected_context_tokens: contextTokens }),
  });
  let observed: any;
  try { observed = JSON.parse(observation.stdout); } catch { /* missing runtime origin is unavailable */ }
  if (observation.status !== 0 || observed?.valid !== true) throw new NotebookRequestCapacityError(`original reviewer invocation has no valid runtime observation: ${observed?.reason ?? observation.error?.message ?? 'verification unavailable'}`);
  let captureDir: string | undefined;
  if (typeof receipt === 'string') {
    const receiptRef = capturedRefs.find(ref => resolveVerifiedRunArtifact(runDir, runId, ref, 'capacity original capture').filePath === path.resolve(receipt));
    if (!receiptRef) throw new NotebookRequestCapacityError('actual capture receipt is missing from frozen request evidence');
    const budget = loadVerifiedRunJson<any>(runDir, runId, receiptRef, 'actual capture execution budget');
    if (budget.status !== 'completed' || budget.runner_exit_code !== 0 || !Array.isArray(budget.input_sha256)
      || !equal([...budget.input_sha256].sort(), originalHashes)
      || !budget.attempts?.some((attempt: any) => attempt.status === 'exited' && attempt.exit_code === 0)) throw new NotebookRequestCapacityError('captured token usage is not bound to the exact successful original request');
    captureDir = path.dirname(path.resolve(receipt));
  }
  const completeOutput = observed.complete_output;
  if (captureDir && (!obj(completeOutput) || typeof completeOutput.terminal !== 'string' || typeof completeOutput.events !== 'string'
    || !capturedRefs.some(ref => resolveVerifiedRunArtifact(runDir, runId, ref, 'complete original terminal').filePath === path.join(captureDir!, completeOutput.terminal))
    || !capturedRefs.some(ref => resolveVerifiedRunArtifact(runDir, runId, ref, 'complete original events').filePath === path.join(captureDir!, completeOutput.events)))) {
    throw new NotebookRequestCapacityError('complete original output is not bound to frozen runtime capture evidence');
  }
  let measured: { input_tokens: number; output_tokens: number } | undefined;
  for (const ref of capturedRefs) {
    const captured = resolveVerifiedRunArtifact(runDir, runId, ref, 'batch token evidence');
    if (!captureDir || path.dirname(captured.filePath) !== captureDir) continue;
    if (captured.filePath.endsWith('.events.jsonl')) {
      for (const line of captured.bytes.toString('utf8').trim().split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'system' && /compact/.test(event.subtype ?? '')) throw new NotebookRequestCapacityError('backend compacted original review context; original-text coverage is unavailable');
      }
    }
    if (captured.filePath !== path.join(captureDir, completeOutput.terminal)) continue;
    const event = JSON.parse(captured.bytes.toString('utf8')); const usage = event.usage;
    if (event.type !== 'result' || event.is_error !== false) continue;
    if (typeof event.result !== 'string' || digest(Buffer.from(event.result, 'utf8')) !== completeOutput.terminal_text_sha256) throw new NotebookRequestCapacityError('captured capacity terminal differs from the complete original output binding');
    if (!obj(usage)) continue;
    const counts = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0, usage.output_tokens];
    if (counts.every(n => Number.isSafeInteger(n) && n >= 0) && counts[0] + counts[1] + counts[2] > 0 && counts[3] > 0) {
      measured = { input_tokens: counts[0] + counts[1] + counts[2], output_tokens: counts[3] };
      if (measured.input_tokens + measured.output_tokens > contextTokens) throw new NotebookRequestCapacityError('observed backend token usage exceeds the declared context window');
    }
  }
  for (const ref of inputs) resolveVerifiedRunArtifact(runDir, runId, ref, 'capacity source input');
  const inputBound = requestBytes + 8192;
  if (measured && measured.input_tokens + measured.output_tokens > contextTokens) throw new NotebookRequestCapacityError('observed backend token usage exceeds the declared context window');
  if (!measured && inputBound + 32768 > contextTokens) throw new NotebookRequestCapacityError('context token capacity cannot be verified: no observed token usage and conservative byte bound exceeds the window');
  return { observed: measured ?? null, runtime_observation: observed.observation_id,
    persisted_request_bytes: requestBytes, protocol_token_reserve: 8192, output_token_reserve: 32768,
    conservative_input_token_upper_bound: inputBound, declared_context_tokens: contextTokens };
}
function assertSourcePacket(dir: string, originId: string, receipt: BatchReceipt, plan: BatchPlan, sources: Map<string, Buffer>, scope: NotebookReviewScope): void {
  const unit = plan.units.find(u => u.unit_id === receipt.unit_ids[0]);
  const supplied = loadVerifiedRunJson<any>(dir, originId, receipt.inventory_ref, 'raw interval inventory');
  const raw = resolveVerifiedRunArtifact(dir, originId, receipt.payload_ref, 'raw interval packet').bytes.toString('utf8');
  if (!unit || receipt.key !== unit.unit_id || receipt.unit_ids.length !== 1 || !equal(supplied.units, [unit])
    || !equal(supplied.sources, [scope.notebook, ...scope.dependencies].map(i => ({ path: i.path, sha256: i.sha256, bytes: i.bytes })))
    || !equal(supplied.navigation_links ?? [], scope.navigation_links ?? [])
    || !equal(supplied.run_states, scope.run_states)
    || supplied.material_sha256 !== plan.material_sha256 || raw !== sourcePayload(plan, sources, unit)) throw new Error('source batch did not receive the exact primary and adjacent original bytes');
}
function sourcePayload(plan: BatchPlan, sources: Map<string, Buffer>, unit: Unit): string {
  const peers = plan.units.filter(u => u.path === unit.path); const index = peers.findIndex(u => u.unit_id === unit.unit_id);
  return peers.slice(Math.max(0, index - 1), index + 2).map(u => `\n=== ORIGINAL SOURCE ${u.path} BYTES ${u.start_byte}:${u.end_byte} ${u.unit_id === unit.unit_id ? 'PRIMARY' : 'ADJACENT CONTEXT'} ===\n${decode(sources.get(u.path)!.subarray(u.start_byte, u.end_byte))}`).join('\n');
}
function crossPayload(sources: Map<string, Buffer>): string {
  return [...sources].map(([filename, bytes]) => `\n=== COMPLETE ORIGINAL SOURCE ${filename} BYTES 0:${bytes.length} ===\n${decode(bytes)}`).join('\n');
}
async function executeBatch(root: string, runDir: string, runId: string, plan: BatchPlan, phase: BatchReceipt['phase'], key: string,
  unitIds: string[], payload: string, inventory: unknown, seconds: number): Promise<BatchEntry> {
  const dir = path.join(runDir, 'batches', key); fs.mkdirSync(dir, { recursive: true });
  const payloadPath = path.join(dir, 'original-text.txt'); const inventoryPath = path.join(dir, 'inventory.json');
  immutable(payloadPath, payload); saveJson(inventoryPath, inventory);
  const inventoryRef = createRunArtifactRef(runId, runDir, inventoryPath, 'notebook_batch_inventory');
  const payloadRef = createRunArtifactRef(runId, runDir, payloadPath, 'notebook_batch_original_text');
  // Byte length is a conservative upper bound on text-token consumption,
  // with a separate protocol/output reserve. No tokenizer precision is claimed.
  const total = Buffer.byteLength(payload) + fs.statSync(inventoryPath).size + 8192;
  if (total > plan.budgets.contextBytes) throw new Error(`request context budget insufficient: ${total} > ${plan.budgets.contextBytes} bytes including instruction reserve`);
  const script = path.join(installedRuntimeRoot(), 'skills/review-swarm/scripts/bin/review_one.py');
  const command = ['python3', script, '--model', plan.model, '--role', phase === 'source' ? 'notebook-batch' : 'notebook-crosscheck',
    '--artifact', payloadPath, '--context', inventoryPath, '--out-dir', path.join(dir, 'review'), '--timeout-secs', String(seconds), '--max-attempts', '1', '--max-prompt-bytes', String(plan.budgets.contextBytes), '--context-tokens', String(plan.budgets.contextTokens)];
  if (plan.model.startsWith('claude/')) command.push('--claude-live-capture');
  const stdoutPath = path.join(dir, 'stdout.txt'); const stderrPath = path.join(dir, 'stderr.txt');
  const stdout = fs.openSync(stdoutPath, 'wx'); const stderr = fs.openSync(stderrPath, 'wx');
  const started = new Date().toISOString();
  const exit = await new Promise<number | null>(resolve => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command[0]!, command.slice(1), { cwd: root, detached: grouped, stdio: ['ignore', stdout, stderr] });
    const signal = (name: NodeJS.Signals) => { try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* process already exited */ } };
    let escalation: NodeJS.Timeout | undefined;
    const kill = () => { signal('SIGTERM'); escalation ??= setTimeout(() => signal('SIGKILL'), 2000); };
    const timer = setTimeout(kill, seconds * 1000);
    const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); process.off('SIGINT', kill); process.off('SIGTERM', kill); };
    process.once('SIGINT', kill); process.once('SIGTERM', kill);
    child.once('error', () => { cleanup(); resolve(null); });
    child.once('close', code => { cleanup(); resolve(code); });
  });
  fs.closeSync(stdout); fs.closeSync(stderr);
  const receipt: BatchReceipt = { schema_version: 1, run_id: runId, phase, key, unit_ids: unitIds, inventory_ref: inventoryRef, payload_ref: payloadRef,
    command, started_at: started, finished_at: new Date().toISOString(), exit_status: exit, stdout_ref: createRunArtifactRef(runId, runDir, stdoutPath, 'review_stdout'), stderr_ref: createRunArtifactRef(runId, runDir, stderrPath, 'review_stderr'), captured_refs: [] };
  for (const [field, name, kind] of [['manifest_ref', 'inputs/review_input_manifest.json', 'review_input_manifest'], ['meta_ref', 'meta.json', 'review_metadata'],
    ['trace_ref', 'trace.jsonl', 'review_trace'], ['pre_freshness_ref', 'pre_review_freshness.json', 'review_freshness'], ['post_freshness_ref', 'post_review_freshness.json', 'review_freshness']] as const) {
    const file = path.join(dir, 'review', name); if (fs.existsSync(file)) receipt[field] = createRunArtifactRef(runId, runDir, file, kind);
  }
  if (receipt.meta_ref) {
    const meta = loadVerifiedRunJson<any>(runDir, runId, receipt.meta_ref, 'batch metadata');
    const output = meta.agents?.[0]?.out;
    if (typeof output === 'string' && fs.existsSync(output)) receipt.report_ref = createRunArtifactRef(runId, runDir, output, 'notebook_batch_reviewer_report');
  }
  const capture = (directory: string): string[] => !fs.existsSync(directory) ? [] : fs.readdirSync(directory, { withFileTypes: true }).flatMap(e => {
    const f = path.join(directory, e.name); if (e.isSymbolicLink()) throw new Error('batch captures cannot be symlinks'); return e.isDirectory() ? capture(f) : e.isFile() ? [f] : [];
  });
  receipt.captured_refs = capture(path.join(dir, 'review')).map(f => createRunArtifactRef(runId, runDir, f, 'review_capture'));
  const receiptPath = path.join(dir, 'receipt.json'); saveJson(receiptPath, receipt);
  return { origin_run_id: runId, receipt_ref: createRunArtifactRef(runId, runDir, receiptPath, 'notebook_batch_execution') };
}
function readEntry(root: string, entry: BatchEntry): { dir: string; receipt: BatchReceipt } {
  if (!/^[a-zA-Z0-9_-]+$/.test(entry.origin_run_id)) throw new Error('invalid batch origin run');
  const dir = path.join(root, 'artifacts/runs', entry.origin_run_id);
  return { dir, receipt: loadVerifiedRunJson<BatchReceipt>(dir, entry.origin_run_id, entry.receipt_ref, 'original batch execution') };
}
/** A completed aggregate and an interrupted run use the same immutable plan.
 * Checkpoints only locate receipts; each reused receipt still passes the full
 * original-input, runtime-observation and freshness checks below. */
export function loadNotebookBatchHistory(root: string, runId: string): BatchExecution {
  const dir = path.join(root, 'artifacts/runs', runId);
  assertNoSymlinkComponents(root, dir, 'notebook resume history');
  const final = path.join(dir, 'review_execution.json');
  if (fs.existsSync(final)) {
    const execution = JSON.parse(fs.readFileSync(final, 'utf8'));
    if (!execution.batch_execution_ref) throw new Error('resume requires a batched notebook review; start a fresh review for a single-call run');
    return loadVerifiedRunJson<BatchExecution>(dir, runId, execution.batch_execution_ref, 'previous immutable batch execution');
  }
  const start = path.join(dir, 'batches/start.json');
  if (!fs.existsSync(start)) throw new Error('interrupted notebook review has no batch plan; resume its recorded intake in a fresh run');
  let state = JSON.parse(fs.readFileSync(start, 'utf8')) as BatchExecution;
  loadVerifiedRunJson<BatchPlan>(dir, runId, state.plan_ref, 'interrupted immutable batch plan');
  const checkpoints = fs.readdirSync(path.dirname(start)).filter(f => /^checkpoint-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  for (const name of checkpoints) {
    const filename = path.join(dir, 'batches', name); assertNoSymlinkComponents(root, filename, 'immutable batch checkpoint');
    const next = JSON.parse(fs.readFileSync(filename, 'utf8')) as BatchExecution;
    if (next.schema_version !== 1 || !equal(next.plan_ref, state.plan_ref) || !Array.isArray(next.entries)
      || next.entries.length !== Number(name.match(/\d+/)![0]) || !equal(next.entries.slice(0, state.entries.length), state.entries)) throw new Error('interrupted batch checkpoint chain is invalid');
    state = next;
  }
  // A crash can occur after the receipt is durable but before its checkpoint.
  // Locate those completed receipts without rewriting any historical bytes.
  for (const item of fs.readdirSync(path.dirname(start), { withFileTypes: true })) {
    if (!item.isDirectory() || !/^source-\d+$/.test(item.name)) continue;
    const file = path.join(dir, 'batches', item.name, 'receipt.json');
    assertNoSymlinkComponents(root, file, 'interrupted batch receipt', { allowMissingLeaf: true });
    if (!fs.existsSync(file)) continue;
    const ref = createRunArtifactRef(runId, dir, file, 'notebook_batch_execution');
    if (!state.entries.some(e => e.origin_run_id === runId && equal(e.receipt_ref, ref))) state = { ...state, entries: [...state.entries, { origin_run_id: runId, receipt_ref: ref }] };
  }
  return state;
}
export async function executeNotebookBatches(root: string, runDir: string, runId: string, scope: NotebookReviewScope, budgets: NotebookBudgets,
  model: string, timeout: number, resume?: string): Promise<BatchExecution> {
  const sources = sourceBytes(scope, runDir, runId); const entries: BatchEntry[] = []; let priorPlan: BatchPlan | undefined;
  if (resume) {
    if (!/^\d{8}T\d{6}-notebook-review-[a-f\d]{8}$/.test(resume)) throw new Error('resume requires an existing notebook-review run id');
    const origin = path.join(root, 'artifacts/runs', resume); assertNoSymlinkComponents(root, origin, 'notebook resume history');
    const old = loadNotebookBatchHistory(root, resume);
    priorPlan = loadVerifiedRunJson<BatchPlan>(origin, resume, old.plan_ref, 'previous batch plan');
    if (priorPlan.model !== model) throw new Error('resumed batch reviewer model must match the original model');
    if (priorPlan.budgets.contextTokens !== budgets.contextTokens) throw new NotebookRequestCapacityError('Historical source receipts require their unchanged original token window; execute a fresh review for a different window.');
    assertPlan(priorPlan, scope, sources);
    for (const entry of old.entries) {
      const { dir, receipt } = readEntry(root, entry);
      if (receipt.phase !== 'source') continue;
      try {
        const checked = assessReceipt(root, dir, entry.origin_run_id, receipt, priorPlan);
        if (checked.fresh && receipt.phase === 'source') {
          assertSourcePacket(dir, entry.origin_run_id, receipt, priorPlan, sources, scope);
          assertUnitReport(checked.report, receipt, priorPlan, sources);
          if (checked.report.coverage_status === 'complete' && !checked.report.missing_dependencies.length
            && checked.report.units.every((u: any) => u.status === 'complete') && !entries.some(e => readEntry(root, e).receipt.key === receipt.key)) entries.push(entry);
        }
      } catch (error) {
        if (error instanceof NotebookRequestCapacityError && error.message.includes("capacity policy")) throw error;
        /* unavailable/partial history is never counted or overwritten */
      }
    }
  }
  const plan: BatchPlan = { schema_version: 1, material_sha256: materialIdentity(scope), model, budgets,
    units: priorPlan?.units ?? partitionNotebookSources(sources, Math.floor((budgets.contextBytes - 12000) / 4)),
    text_bytes: [scope.notebook, ...scope.dependencies].reduce((n, i) => n + i.bytes, 0), material_bytes: [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])].reduce((n, i) => n + i.bytes, 0) };
  assertPlan(plan, scope, sources);
  const planPath = path.join(runDir, 'inputs/batch-plan.json'); saveJson(planPath, plan);
  const state: BatchExecution = { schema_version: 1, plan_ref: createRunArtifactRef(runId, runDir, planPath, 'notebook_batch_plan'), entries, stop_reason: null, resumed_from: resume ?? null };
  const deadline = Date.now() + timeout * 1000; let calls = 0;
  const completed = new Set(entries.flatMap(e => readEntry(root, e).receipt.unit_ids));
  const progress = () => saveJson(path.join(runDir, 'batches', `checkpoint-${state.entries.length}.json`), state);
  fs.mkdirSync(path.join(runDir, 'batches'), { recursive: true });
  saveJson(path.join(runDir, 'batches/start.json'), state);
  try {
    for (const unit of plan.units) {
      if (completed.has(unit.unit_id)) continue;
      if (!liveMaterial(root, scope)) { state.stop_reason = 'Original notebook or dependency changed during batched review.'; break; }
      if (++calls > budgets.maxBatches || Date.now() >= deadline) { state.stop_reason = 'Execution budget exhausted before every raw interval was reviewed.'; break; }
      const inventory = { schema_version: 1, review_kind: 'notebook_batch', material_sha256: plan.material_sha256, units: [unit],
        sources: [scope.notebook, ...scope.dependencies].map(i => ({ path: i.path, sha256: i.sha256, bytes: i.bytes })),
        navigation_links: scope.navigation_links ?? [],
        run_states: scope.run_states,
        interval_policy: 'All original primary bytes; adjacent raw context only. Cross-section closure is deferred to the separate original-context audit.' };
      const entry = await executeBatch(root, runDir, runId, plan, 'source', unit.unit_id, [unit.unit_id], sourcePayload(plan, sources, unit), inventory, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      state.entries.push(entry); progress();
      const { dir, receipt } = readEntry(root, entry); const checked = assessReceipt(root, dir, entry.origin_run_id, receipt, plan);
      assertUnitReport(checked.report, receipt, plan, sources);
      if (!checked.fresh || checked.report.coverage_status !== 'complete' || checked.report.units.some((u: any) => u.status !== 'complete')) { state.stop_reason = 'A raw source interval was not completely reviewed.'; break; }
    }
    if (!state.stop_reason) {
      if (++calls > budgets.maxBatches || Date.now() >= deadline) state.stop_reason = 'Execution budget exhausted before the cross-section audit.';
      else {
        const payload = crossPayload(sources);
        const inventory = { schema_version: 1, review_kind: 'notebook_cross_section', material_sha256: plan.material_sha256,
          units: plan.units, opaque_links: (scope.opaque_links ?? []).map(i => ({ path: i.path, sha256: i.sha256 })),
          directory_links: scope.directory_links, remote_links: scope.remote_links, navigation_links: scope.navigation_links ?? [],
          run_states: scope.run_states,
          obligations: 'Read every full original source and every interval jointly. Check all definitions, assumptions, conventions, formal claims and cross-section inferences. Each original_unit_coverage entry requires anchors: an array of exact original path/start_byte/end_byte/quote objects within that unit, including substantive body text when present. Empty or whitespace-only units use an empty anchors array. No selected quote or summary substitutes for the full original joint input.' };
        const entry = await executeBatch(root, runDir, runId, plan, 'cross_section', 'cross-section', [], payload, inventory, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
        state.entries.push(entry); progress();
        if (!liveMaterial(root, scope)) state.stop_reason = 'Original notebook or dependency changed during the full-original joint audit.';
      }
    }
  } catch (error) { state.stop_reason = error instanceof Error ? error.message : String(error); }
  return state;
}
export function assessNotebookBatches(root: string, runDir: string, runId: string, scope: NotebookReviewScope, execution: BatchExecution, base: NotebookContentReview):
  { report: NotebookContentReview; executionAccepted: boolean; sourceRefs: ArtifactRefV1[]; outputRefs: ArtifactRefV1[] } {
  const plan = loadVerifiedRunJson<BatchPlan>(runDir, runId, execution.plan_ref, 'full batch plan'); const sources = sourceBytes(scope, runDir, runId); assertPlan(plan, scope, sources);
  if (execution.schema_version !== 1 || !Array.isArray(execution.entries)) throw new Error('invalid batch execution set');
  const seen = new Set<string>(); const covered = new Set<string>(); const findings: unknown[] = []; const families: unknown[] = []; const tokenEvidence: unknown[] = []; let complete = true; let passes = true; let fresh = liveMaterial(root, scope); let cross: Record<string, any> | undefined; let invalid = false;
  const outputRefs: ArtifactRefV1[] = [];
  for (const entry of execution.entries) {
    const { dir, receipt } = readEntry(root, entry);
    if (seen.has(receipt.key)) throw new Error('duplicate source/cross batch execution'); seen.add(receipt.key);
    // Preserve declared output identity even when runtime authority is currently
    // unavailable, so immutable canonical history remains readable as such.
    if (receipt.report_ref) outputRefs.push(receipt.report_ref);
    try {
      if (receipt.phase === 'cross_section' && entry.origin_run_id !== runId) throw new Error('The full-original joint audit must originate in the current review run.');
      const checked = assessReceipt(root, dir, entry.origin_run_id, receipt, plan); const report = checked.report;
      if (receipt.phase === 'source') {
        assertSourcePacket(dir, entry.origin_run_id, receipt, plan, sources, scope);
      }

      fresh &&= checked.fresh; families.push(checked.family); tokenEvidence.push(checked.token_evidence); findings.push(...report.blocking_issues);
      complete &&= report.coverage_status === 'complete' && !report.missing_dependencies.length; passes &&= report.verdict === 'PASS' && !report.blocking_issues.length;
      if (receipt.phase === 'source') {
        assertUnitReport(report, receipt, plan, sources);
        const done = report.coverage_status === 'complete' && !report.missing_dependencies.length && report.units.every((u: any) => u.status === 'complete');
        complete &&= done; if (done) for (const id of receipt.unit_ids) covered.add(id);
      } else { if (cross || receipt.key !== 'cross-section' || receipt.unit_ids.length) throw new Error('invalid or duplicate cross-section review'); cross = report; }
    } catch (error) { complete = false; invalid = true; findings.push(error instanceof Error ? error.message : String(error)); }
  }
  const pending = plan.units.filter(u => !covered.has(u.unit_id)).map(u => u.unit_id); complete &&= !pending.length;
  if (!cross) complete = false;
  else {
    if (typeof cross.cross_section_reasoning !== 'string' || !cross.cross_section_reasoning.trim()) throw new Error('cross-section original-context reasoning is missing');
    if (!Array.isArray(cross.original_unit_coverage) || cross.original_unit_coverage.length !== plan.units.length
      || !equal(cross.original_unit_coverage.map((c: any) => c.unit_id).sort(), plan.units.map(c => c.unit_id).sort())
      || cross.original_unit_coverage.some((c: any) => typeof c.reasoning !== 'string' || !c.reasoning.trim())) throw new Error('joint audit omitted original source intervals');
    const unitsById = new Map(plan.units.map(unit => [unit.unit_id, unit]));
    for (const coverage of cross.original_unit_coverage) {
      const unit = unitsById.get(coverage.unit_id)!; const bytes = sources.get(unit.path)!;
      if (!Array.isArray(coverage.anchors)) throw new Error('joint interval coverage requires original byte anchors');
      const grounded = coverage.anchors.map((a: unknown) => anchor(a, sources, unit));
      const nonempty = decode(bytes.subarray(unit.start_byte, unit.end_byte)).trim();
      const hasBody = bodyAnchor({ path: unit.path, start_byte: unit.start_byte, end_byte: unit.end_byte, quote: nonempty }, bytes);
      if (nonempty && (!grounded.length || (hasBody && !grounded.some((a: Anchor) => bodyAnchor(a, bytes))))) throw new Error('joint interval coverage lacks an original substantive byte anchor');
    }
    complete &&= cross.dependency_closure === 'complete' && !cross.missing_dependencies.length;
    if ((scope.opaque_links ?? []).length) {
      if (!Array.isArray(cross.opaque_sources) || cross.opaque_sources.length !== scope.opaque_links!.length) throw new Error('cross-review omitted opaque source assessment');
      for (const i of scope.opaque_links!) { const matches = cross.opaque_sources.filter((a: any) => a.path === i.path && a.sha256 === i.sha256);
        if (matches.length !== 1 || typeof matches[0].required_for_reasoning !== 'boolean' || !matches[0].reasoning?.trim()) throw new Error('opaque assessment is invalid'); if (matches[0].required_for_reasoning) complete = false; }
    }
    const crossEntry = execution.entries.find(e => readEntry(root, e).receipt.phase === 'cross_section')!; const { dir, receipt } = readEntry(root, crossEntry);
    const supplied = loadVerifiedRunJson<any>(dir, crossEntry.origin_run_id, receipt.inventory_ref, 'cross-section inventory');
    const raw = resolveVerifiedRunArtifact(dir, crossEntry.origin_run_id, receipt.payload_ref, 'cross original contexts').bytes.toString('utf8');
    if (supplied.material_sha256 !== plan.material_sha256 || !equal(supplied.units, plan.units)
      || !equal(supplied.opaque_links, (scope.opaque_links ?? []).map(i => ({ path: i.path, sha256: i.sha256 })))
      || !equal(supplied.directory_links, scope.directory_links) || !equal(supplied.remote_links, scope.remote_links)
      || !equal(supplied.navigation_links ?? [], scope.navigation_links ?? [])
      || !equal(supplied.run_states, scope.run_states)
      || raw !== crossPayload(sources)) throw new Error('cross-section report did not receive the full original-context closure');
  }
  fresh &&= liveMaterial(root, scope);
  const accepted = fresh && complete && passes && !invalid && !execution.stop_reason;
  const reason = !fresh ? 'Original source, referenced run state or batch inputs changed; the aggregate review is stale.' : execution.stop_reason ?? (accepted ? cross!.summary : complete ? 'The executed source or cross-section review rejected the notebook.' : 'Necessary original interval or cross-section review remains incomplete.');
  const lines = decode(sources.get(scope.notebook.path)!).split('\n'); const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + Buffer.byteLength(line) + 1);
  const report = { ...base, status: !fresh ? 'stale' : invalid ? 'unavailable' : accepted ? 'accepted' : complete ? 'rejected' : 'incomplete', reason,
    run_id: runId, reviewed_notebook_sha256: scope.notebook.sha256, sections_total: scope.sections.length,
    sections_reviewed: scope.sections.filter(s => plan.units.filter(u => u.path === scope.notebook.path && u.start_byte < offsets[s.end_line]! && u.end_byte > offsets[s.start_line - 1]!).every(u => covered.has(u.unit_id))).length,
    findings, independence: { review_seats: 1, batch_executions: execution.entries.length, family_evidence: families, method_diversity: false, method: 'full raw interval assessments and a joint original-context consistency audit', input_independence: 'not_machine_verified', model_family_diversity: 'not_claimed' },
    progress: { closure_complete: true, material_bytes: plan.material_bytes, text_bytes: plan.text_bytes, files_total: [scope.notebook, ...scope.dependencies, ...(scope.opaque_links ?? [])].length,
      units_total: plan.units.length, units_reviewed: plan.units.length - pending.length, pending_units: pending, cross_section_reviewed: !!cross && complete,
      pending_intervals: plan.units.filter(u => !covered.has(u.unit_id)).map(u => ({ unit_id: u.unit_id, path: u.path, start_byte: u.start_byte, end_byte: u.end_byte })),
      joint_original_bytes: Buffer.byteLength(crossPayload(sources)),
      budgets: plan.budgets, capacity_evidence: { policy: 'caller-configured backend window; conservative byte bound or captured backend token usage; backend limit not introspected', batches: tokenEvidence },
      resume_command: `nullius --project-root ${notebookShellWord(root)} notebook review --model ${notebookShellWord(plan.model)} --resume ${runId} --context-bytes ${plan.budgets.contextBytes} --context-tokens ${plan.budgets.contextTokens} --snapshot-bytes ${plan.budgets.snapshotBytes} --max-files ${plan.budgets.maxFiles} --max-batches ${plan.budgets.maxBatches}` } } as NotebookContentReview;
  return { report, executionAccepted: accepted, sourceRefs: [execution.plan_ref, scope.notebook.snapshot_ref, ...scope.dependencies.map(d => d.snapshot_ref), ...(scope.opaque_links ?? []).map(d => d.snapshot_ref)], outputRefs };
}
