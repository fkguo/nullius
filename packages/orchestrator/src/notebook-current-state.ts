import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { writeBytesAtomicDurable } from '@nullius/shared';
import { canonicalJson, readValidityLedger, type ValidityLedgerView } from './validity-ledger.js';
import { validateResultRegistry } from './result-registry.js';

/** The machine-written current-state block in research_notebook.md.
 *
 *  The block renders EXCLUSIVELY from the results-registry projection —
 *  deliberately not from the ledger head: binding it to the last event id
 *  would rewrite a human-owned file on every stamp at fast run cadence
 *  (hundreds per day in the field), race open editors, and make opting out
 *  the rational move. With the projection rule the block is stamp-stable by
 *  construction: it changes exactly when registry-relevant state changes
 *  (a result registered/superseded, a registered run's validity ruled on,
 *  a registry defect appearing).
 *
 *  Freshness is two-channel and strict: the recorded digest names WHY a
 *  block is behind (projection moved), the byte comparison against a fresh
 *  render also catches hand edits inside the markers that keep the digest
 *  line intact. A present block CLAIMS currency, so out-of-sync is a
 *  fold-boundary refusal; a MISSING block claims nothing and only warns. */

export const CURRENT_STATE_START = '<!-- NOTEBOOK_CURRENT_STATE_START -->';
export const CURRENT_STATE_END = '<!-- NOTEBOOK_CURRENT_STATE_END -->';
const DIGEST_LINE_PATTERN = /<!--\s*state-digest:\s*([0-9a-f]{64})\s*-->/;

export type CurrentStateRow = {
  result_id: string;
  run_id: string;
  effective_commit: string | null;
  has_snapshot: boolean;
  artifact: string | null;
  defective: boolean;
};

export type CurrentStateProjection = {
  current_rows: CurrentStateRow[];
  total_rows: number;
  issue_codes: string[];
};

type ValidatedRegistry = ReturnType<typeof validateResultRegistry>;

/** Projection from an ALREADY-validated registry — the traceability view
 *  passes its own validation result here so one status read never parses
 *  the ledger twice. */
export function projectionFromRegistryState(registry: ValidatedRegistry): CurrentStateProjection {
  return {
    current_rows: registry.current.map(row => ({
      result_id: row.result_id,
      run_id: row.run_id,
      effective_commit: row.effective_commit,
      has_snapshot: row.has_snapshot,
      artifact: row.artifact_target,
      defective: registry.defective_result_ids.has(row.result_id),
    })),
    total_rows: registry.rows.length,
    issue_codes: [...new Set(registry.issues.map(entry => entry.code))].sort(),
  };
}

export function computeCurrentStateProjection(
  projectRoot: string,
  ledgerView?: ValidityLedgerView,
): CurrentStateProjection {
  const ledger = ledgerView ?? readValidityLedger(projectRoot);
  return projectionFromRegistryState(validateResultRegistry(projectRoot, ledger));
}

export function projectionDigest(projection: CurrentStateProjection): string {
  return createHash('sha256').update(canonicalJson(projection), 'utf-8').digest('hex');
}

/** The full block, markers inclusive. Deterministic: byte-compare against
 *  this render is the freshness truth, so nothing non-deterministic (dates,
 *  counters) may appear here. */
export function renderCurrentStateBlock(projection: CurrentStateProjection): string {
  const lines: string[] = [];
  lines.push(CURRENT_STATE_START);
  lines.push(`<!-- state-digest: ${projectionDigest(projection)} -->`);
  lines.push('**Current state (auto-maintained).** Machine-rendered from the results');
  lines.push('registry and the validity ledger. Do not edit between these markers —');
  lines.push('refresh with `nullius notebook sync`; full answer: `nullius current`.');
  lines.push('');
  if (projection.current_rows.length === 0) {
    if (projection.total_rows === 0) {
      lines.push('No result is promoted yet: the results registry has no rows — an honest');
      lines.push('state, not an error. Sections below are the current understanding; no');
      lines.push('number in them has passed the promotion bar. Register a headline result');
      lines.push('at milestone convergence with `nullius result set-current`.');
    } else {
      lines.push(`${projection.total_rows} result row(s) are registered but none is a valid current`);
      lines.push('head (registry defects present). Repair before trusting any of them —');
      lines.push('see `nullius current` for the defect list.');
    }
  } else {
    lines.push('| Result | Run | Identity | Artifact |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of projection.current_rows) {
      const identity = row.effective_commit === null
        ? '(no exact identity)'
        : `${row.effective_commit.slice(0, 12)}${row.has_snapshot ? '+snapshot' : ''}`;
      const artifact = row.artifact === null ? '(none)' : `[${row.artifact}](${row.artifact})`;
      const marker = row.defective ? ' **DEFECTIVE**' : '';
      lines.push(`| ${row.result_id}${marker} | ${row.run_id} | ${identity} | ${artifact} |`);
    }
  }
  if (projection.issue_codes.length > 0 && projection.current_rows.length > 0) {
    lines.push('');
    lines.push(`Registry issues present: ${projection.issue_codes.join(', ')} — see \`nullius current\`.`);
  }
  lines.push(CURRENT_STATE_END);
  return lines.join('\n');
}

export type CurrentStateBlockStatus = {
  notebook_found: boolean;
  block_found: boolean;
  /** More than one START or END marker: refused, never guessed. */
  duplicated_markers: boolean;
  /** Strict verdict: on-disk block bytes equal the canonical render. Null
   *  when the block (or the notebook) is absent. */
  in_sync: boolean | null;
  /** Named cause when in_sync is false: the digest channel distinguishes
   *  "state moved since the block was written" from "hand edit or renderer
   *  change with unchanged state". */
  reason: string | null;
};

type BlockBounds = { start: number; end: number };

function locateBlock(text: string): { bounds: BlockBounds | null; duplicated: boolean } {
  const firstStart = text.indexOf(CURRENT_STATE_START);
  const firstEnd = text.indexOf(CURRENT_STATE_END);
  const duplicated = text.indexOf(CURRENT_STATE_START, firstStart + 1) !== -1
    || text.indexOf(CURRENT_STATE_END, firstEnd + 1) !== -1;
  if (firstStart === -1 || firstEnd === -1 || firstEnd < firstStart) {
    return { bounds: null, duplicated };
  }
  return { bounds: { start: firstStart, end: firstEnd + CURRENT_STATE_END.length }, duplicated };
}

export function checkCurrentStateBlock(
  projectRoot: string,
  projection: CurrentStateProjection,
): CurrentStateBlockStatus {
  const status: CurrentStateBlockStatus = {
    notebook_found: false, block_found: false, duplicated_markers: false, in_sync: null, reason: null,
  };
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  let text: string;
  try {
    text = fs.readFileSync(notebookPath, 'utf-8');
  } catch {
    return status;
  }
  status.notebook_found = true;
  const { bounds, duplicated } = locateBlock(text);
  status.duplicated_markers = duplicated;
  if (duplicated) {
    status.reason = 'duplicated current-state markers — repair by hand, then `nullius notebook sync`';
    return status;
  }
  if (!bounds) return status;
  status.block_found = true;
  const onDisk = text.slice(bounds.start, bounds.end);
  const rendered = renderCurrentStateBlock(projection);
  if (onDisk === rendered) {
    status.in_sync = true;
    return status;
  }
  status.in_sync = false;
  const digestMatch = DIGEST_LINE_PATTERN.exec(onDisk);
  status.reason = digestMatch === null || digestMatch[1] !== projectionDigest(projection)
    ? 'registry/validity state changed since the block was written'
    : 'block text differs from the canonical render (hand edit inside the markers, or a renderer update)';
  return status;
}

/** Remove the machine-written block (markers inclusive) from notebook text.
 *  Consumers judging whether a notebook carries SUBSTANTIVE research content
 *  must not count the rendered block — it is a machine view, present even in
 *  a pristine scaffold. With duplicated markers nothing is removed (the
 *  repair path owns that state). */
export function stripCurrentStateBlock(text: string): string {
  const { bounds, duplicated } = locateBlock(text);
  if (!bounds || duplicated) return text;
  return text.slice(0, bounds.start) + text.slice(bounds.end);
}

export type RefreshOutcome = {
  action: 'inserted' | 'rewritten' | 'unchanged' | 'skipped';
  reason: string | null;
};

/** Insert position: immediately before the first `##` heading outside
 *  fenced code (front matter placement — structurally invisible to the
 *  section-based staleness classifier); a notebook with no headings gets
 *  the block appended. */
function insertionOffset(text: string): number {
  const lines = text.split('\n');
  let inFence = false;
  let offset = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^##\s+/.test(line)) return offset;
    offset += line.length + 1;
  }
  return text.length;
}

export function refreshNotebookCurrentState(
  projectRoot: string,
  options?: { insertIfMissing?: boolean; ledgerView?: ValidityLedgerView },
): RefreshOutcome {
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  let text: string;
  try {
    text = fs.readFileSync(notebookPath, 'utf-8');
  } catch {
    return { action: 'skipped', reason: 'research_notebook.md not found' };
  }
  const { bounds, duplicated } = locateBlock(text);
  if (duplicated) {
    return { action: 'skipped', reason: 'duplicated current-state markers — repair by hand first' };
  }
  const rendered = renderCurrentStateBlock(computeCurrentStateProjection(projectRoot, options?.ledgerView));
  if (!bounds) {
    if (!options?.insertIfMissing) {
      return { action: 'skipped', reason: 'no current-state block (run `nullius notebook sync` to adopt)' };
    }
    const offset = insertionOffset(text);
    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const needsLeadingNewline = before.length > 0 && !before.endsWith('\n\n') && before.endsWith('\n');
    const updated = `${before}${needsLeadingNewline ? '\n' : ''}${rendered}\n\n${after}`;
    writeBytesAtomicDurable(notebookPath, Buffer.from(updated, 'utf-8'));
    return { action: 'inserted', reason: null };
  }
  const onDisk = text.slice(bounds.start, bounds.end);
  if (onDisk === rendered) return { action: 'unchanged', reason: null };
  const updated = text.slice(0, bounds.start) + rendered + text.slice(bounds.end);
  writeBytesAtomicDurable(notebookPath, Buffer.from(updated, 'utf-8'));
  return { action: 'rewritten', reason: null };
}
