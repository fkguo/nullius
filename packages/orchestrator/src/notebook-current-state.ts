import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, readValidityLedger, type ValidityLedgerView } from './validity-ledger.js';
import { validateResultRegistry } from './result-registry.js';
import {
  checkManagedBlock,
  locateManagedBlock,
  refreshManagedBlock,
  type ManagedBlockLocation,
  type ManagedBlockSpec,
} from './managed-block.js';

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
  /** Present (true) only for head_plus_untracked bindings. OPTIONAL so
   *  that adding the qualifier does not change the projection digest of
   *  every pre-existing exact row — a field that is false everywhere
   *  would flip every in-sync notebook block to out-of-sync while its
   *  rendered bytes are identical. */
  has_untracked?: true;
  artifact: string | null;
  defective: boolean;
};

export type CurrentStateProjection = {
  /** False when project_index.md carries no RESULT_REGISTRY block at all —
   *  a distinct honest state: "nothing is registered" and "there is nowhere
   *  to register" must never render as the same sentence. */
  registry_block_found: boolean;
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
    registry_block_found: registry.block_found,
    current_rows: registry.current.map(row => ({
      result_id: row.result_id,
      run_id: row.run_id,
      effective_commit: row.effective_commit,
      has_snapshot: row.has_snapshot,
      ...(row.has_untracked ? { has_untracked: true as const } : {}),
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
  if (!projection.registry_block_found) {
    // "Nowhere to register" is not "nothing registered": calling a missing
    // registry an honest empty state would send the researcher to a
    // `result set-current` that can only refuse.
    lines.push('project_index.md carries no results-registry block, so nothing can be');
    lines.push('registered yet. Restore or paste the RESULT_REGISTRY section there');
    lines.push('(fresh scaffolds carry it), then register results with');
    lines.push('`nullius result set-current`.');
  } else if (projection.current_rows.length === 0) {
    if (projection.total_rows === 0 && projection.issue_codes.length > 0) {
      // Zero PARSED rows with parse issues means a written row may be
      // unseen — the exact misdiagnosis the registry parser guards
      // against must not be re-introduced by this surface.
      lines.push('The results registry did not parse cleanly and zero rows were read —');
      lines.push('a written row may be going unseen. Repair the registry block before');
      lines.push('trusting this surface; `nullius current` lists the defects.');
    } else if (projection.total_rows === 0) {
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
        : `${row.effective_commit.slice(0, 12)}${row.has_snapshot ? '+snapshot' : ''}${row.has_untracked ? '+untracked' : ''}`;
      const artifact = row.artifact === null ? '(none)' : `[${row.artifact}](${row.artifact})`;
      const marker = row.defective ? ' **DEFECTIVE**' : '';
      lines.push(`| ${row.result_id}${marker} | ${row.run_id} | ${identity} | ${artifact} |`);
    }
  }
  // Issue codes render UNCONDITIONALLY: suppressing them behind a
  // rows-present guard hid malformed-row diagnostics exactly when they
  // mattered most (zero parsed rows).
  if (projection.issue_codes.length > 0) {
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

/** The notebook block's spec for the shared managed-block engine. Every
 *  locating/validating/splicing rule lives in managed-block.ts (extracted
 *  verbatim from this module after its review rounds); this module keeps
 *  only the notebook-specific projection, rendering, and wording. */
const NOTEBOOK_BLOCK_SPEC: ManagedBlockSpec = {
  startMarker: CURRENT_STATE_START,
  endMarker: CURRENT_STATE_END,
  digestFirstLinePattern: /^ {0,3}<!--\s*state-digest:\s*[0-9a-f]{64}\s*--> *$/,
  blockNoun: 'current-state',
  syncCommand: '`nullius notebook sync`',
  fileLabel: 'research_notebook.md',
  carrierNoun: 'notebook',
  frontMatterPosition: true,
  positionReason: 'block is not in the front matter (before the first `##` heading) — '
    + '`nullius notebook sync` relocates it',
  stateChangedReason: 'registry/validity state changed since the block was written',
};

/** Fence-aware, line-based marker location: an example QUOTING the markers
 *  inside a fenced block OR a four-space/tab indented code block
 *  (CommonMark's other code form) must neither count as a block nor trip
 *  the duplicated-markers refusal. */
function locateBlock(text: string): ManagedBlockLocation {
  return locateManagedBlock(text, NOTEBOOK_BLOCK_SPEC);
}

export function checkCurrentStateBlock(
  projectRoot: string,
  projection: CurrentStateProjection,
): CurrentStateBlockStatus {
  const generic = checkManagedBlock(
    path.join(projectRoot, 'research_notebook.md'),
    renderCurrentStateBlock(projection),
    NOTEBOOK_BLOCK_SPEC,
    DIGEST_LINE_PATTERN,
    projectionDigest(projection),
  );
  return {
    notebook_found: generic.file_found,
    block_found: generic.block_found,
    duplicated_markers: generic.duplicated_markers,
    in_sync: generic.in_sync,
    reason: generic.reason,
  };
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
  /** The projection this refresh rendered (and wrote, unless skipped). A
   *  caller that wants a post-write freshness verdict must check against
   *  THIS projection, not recompute its own: between a recompute and the
   *  earlier write another writer may land, and the check would then
   *  compare the file against a projection nobody rendered — reporting a
   *  freshly-written block as stale or, worse, a stale one as current. */
  projection: CurrentStateProjection;
};

/** Insertion offset for a notebook with no block yet: before the first
 *  `##` heading; a memo with no `##` heading gets the block right after
 *  its opening `#` title line (or at the very top) — appending an
 *  "opening surface" to EOF would be the opposite of its contract. */
function frontMatterInsertOffset(text: string, location: ManagedBlockLocation): number {
  let offset = location.firstHeadingOffset;
  if (offset === text.length) {
    const firstLineEnd = text.indexOf('\n');
    offset = text.startsWith('# ') && firstLineEnd !== -1 ? firstLineEnd + 1 : 0;
  }
  return offset;
}

export function refreshNotebookCurrentState(
  projectRoot: string,
  options?: {
    insertIfMissing?: boolean;
    ledgerView?: ValidityLedgerView;
    /** A caller that already computed the projection passes it here so one
     *  command never hashes the registered artifacts twice. */
    projection?: CurrentStateProjection;
  },
): RefreshOutcome {
  // EVERY attempt — the first included — recomputes from fresh state,
  // never from a caller-supplied projection: the supplied value predates
  // the carrier read, and a rival's registry write can land in exactly
  // that window (the engine's optimistic guard only catches rivals that
  // touch the carrier AFTER our read). The supplied projection/ledgerView
  // seed only the returned projection on the render-free skip path, so a
  // normal refresh computes exactly one projection.
  let latestProjection: CurrentStateProjection | null = null;
  const outcome = refreshManagedBlock(
    path.join(projectRoot, 'research_notebook.md'),
    () => {
      latestProjection = computeCurrentStateProjection(projectRoot);
      return renderCurrentStateBlock(latestProjection);
    },
    NOTEBOOK_BLOCK_SPEC,
    {
      insertIfMissing: options?.insertIfMissing === true,
      missingBlockReason: 'no current-state block (run `nullius notebook sync` to adopt)',
      insertAt: frontMatterInsertOffset,
    },
  );
  return {
    projection: latestProjection
      ?? options?.projection
      ?? computeCurrentStateProjection(projectRoot, options?.ledgerView),
    action: outcome.action,
    reason: outcome.reason,
  };
}
