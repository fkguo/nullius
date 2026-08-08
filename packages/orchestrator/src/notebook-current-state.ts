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
        : `${row.effective_commit.slice(0, 12)}${row.has_snapshot ? '+snapshot' : ''}`;
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

type BlockBounds = { start: number; end: number };

type BlockLocation = {
  bounds: BlockBounds | null;
  /** True only when marker duplication coexists with at least one complete
   *  START..END pair — a renderable structure that CLAIMS currency
   *  ambiguously. Stray unpaired marker lines in prose claim nothing and
   *  must stay advisory (R3), never a refusal. */
  duplicated: boolean;
  /** Any marker line present at all (paired or stray) — adoption must not
   *  insert a second structure next to leftovers. */
  markerLinesPresent: boolean;
  /** Marker lines not consumed by a complete pair: advisory garbage. */
  strayMarkerLines: number;
  /** Byte offset of the first `##` heading outside fences/indented code
   *  (text.length when none) — the block's required position is strictly
   *  before it. */
  firstHeadingOffset: number;
  /** False when a well-formed block sits at or after the first heading:
   *  inside a section it would be read as section content by the staleness
   *  classifier and its links would read as citations — the front-matter
   *  position is load-bearing, not cosmetic. */
  positionOk: boolean;
};

/** Fence-aware, line-based marker location: an example QUOTING the markers
 *  inside a fenced block OR a four-space/tab indented code block
 *  (CommonMark's other code form) must neither count as a block nor trip
 *  the duplicated-markers refusal. */
function locateBlock(text: string): BlockLocation {
  const lines = text.split('\n');
  let inFence = false;
  let offset = 0;
  let firstHeadingOffset = text.length;
  type MarkerLine = BlockBounds & { lineIndex: number };
  const starts: MarkerLine[] = [];
  const ends: MarkerLine[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    // A CRLF file splits into lines with a trailing '\r'; the marker-line
    // extent must exclude it so block slices never carry a stray '\r'.
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    const contentEnd = offset + content.length;
    const indentedCode = /^(?: {4}|\t)/.test(content);
    if (/^\s{0,3}(```|~~~)/.test(content)) {
      inFence = !inFence;
    } else if (!inFence && !indentedCode) {
      const trimmed = content.trim();
      if (trimmed === CURRENT_STATE_START) starts.push({ start: offset, end: contentEnd, lineIndex });
      else if (trimmed === CURRENT_STATE_END) ends.push({ start: offset, end: contentEnd, lineIndex });
      else if (/^##\s+/.test(content) && firstHeadingOffset === text.length) firstHeadingOffset = offset;
    }
    offset = offset + line.length + 1;
  }
  const markerLinesPresent = starts.length > 0 || ends.length > 0;
  // INNERMOST pairing: each END claims the NEAREST PRECEDING unclaimed
  // START. Outermost pairing was a proven data-loss hazard — a stray START
  // above the real block claimed the real block's END, the bounds spanned
  // the human prose (headings included) in between, and the next
  // best-effort refresh spliced it all away. With innermost pairing a
  // block never contains another marker line; nested pairs surface as TWO
  // complete blocks (duplicated → refusal, no write). One complete block
  // plus stray markers is an unambiguous claim with garbage nearby —
  // advisory, never a refusal.
  const pairedBlocks: Array<{ bounds: BlockBounds; interiorLines: string[] }> = [];
  const unclaimedStarts: MarkerLine[] = [];
  let strayEnds = 0;
  const markers = [...starts.map(marker => ({ ...marker, kind: 'start' as const })),
    ...ends.map(marker => ({ ...marker, kind: 'end' as const }))]
    .sort((a, b) => a.start - b.start);
  for (const marker of markers) {
    if (marker.kind === 'start') {
      unclaimedStarts.push(marker);
    } else if (unclaimedStarts.length > 0) {
      const opener = unclaimedStarts.pop()!;
      pairedBlocks.push({
        bounds: { start: opener.start, end: marker.end },
        interiorLines: lines.slice(opener.lineIndex + 1, marker.lineIndex),
      });
    } else {
      strayEnds += 1;
    }
  }
  // Interior validation — the last line of defense against splicing away
  // researcher prose. A REAL block's interior is machine-rendered (always
  // carries the digest line); the template placeholder's interior is a
  // short contiguous note (no blank line). An interior with a `##` heading,
  // or with blank lines but no digest, is a stray marker pair wrapped
  // around human prose: its markers are strays, never a rewritable block.
  let strayFromInvalidPairs = 0;
  const completeBlocks: BlockBounds[] = [];
  for (const pair of pairedBlocks) {
    const interiorContent = pair.interiorLines
      .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
    const containsHeading = interiorContent.some(line => /^##\s+/.test(line));
    const containsBlank = interiorContent.some(line => line.trim() === '');
    const containsDigest = DIGEST_LINE_PATTERN.test(interiorContent.join('\n'));
    if (containsHeading || (containsBlank && !containsDigest)) {
      strayFromInvalidPairs += 2;
      continue;
    }
    completeBlocks.push(pair.bounds);
  }
  const duplicated = completeBlocks.length > 1;
  const bounds = completeBlocks.length === 1 ? completeBlocks[0]! : null;
  const strayMarkerLines = unclaimedStarts.length + strayEnds + strayFromInvalidPairs;
  // The whole block must sit BEFORE the first heading: a start-only check
  // would bless a span that swallowed the heading.
  const positionOk = bounds === null ? true : bounds.end <= firstHeadingOffset;
  return { bounds, duplicated, markerLinesPresent, strayMarkerLines, firstHeadingOffset, positionOk };
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
  const { bounds, duplicated, markerLinesPresent, strayMarkerLines, positionOk } = locateBlock(text);
  status.duplicated_markers = duplicated;
  if (duplicated) {
    status.reason = 'duplicated current-state markers — repair by hand, then `nullius notebook sync`';
    return status;
  }
  if (!bounds) {
    if (markerLinesPresent) {
      // Stray unpaired marker lines claim nothing (never a refusal), but
      // adoption is blocked until they are removed — say so.
      status.reason = 'stray current-state marker line(s) present without a complete block — '
        + 'remove them, then `nullius notebook sync`';
    }
    return status;
  }
  // One complete block plus stray marker garbage: the block's own verdict
  // proceeds below; the strays ride along as an advisory suffix.
  const straySuffix = strayMarkerLines > 0
    ? `; ${strayMarkerLines} stray marker line(s) also present — remove them`
    : '';
  status.block_found = true;
  if (!positionOk) {
    // A block inside a section is not the fixed front surface the contract
    // names — and mechanically its links would read as section citations.
    status.in_sync = false;
    status.reason = 'block is not in the front matter (before the first `##` heading) — '
      + `\`nullius notebook sync\` relocates it${straySuffix}`;
    return status;
  }
  // EOL-normalized comparison: an editor or a checkout filter converting
  // the file to CRLF is not a content change, and treating it as one would
  // make the block permanently out-of-sync on such setups (an unrepairable
  // fold refusal — sync writes LF, the next save re-converts, forever).
  const onDisk = normalizeEol(text.slice(bounds.start, bounds.end));
  const rendered = renderCurrentStateBlock(projection);
  if (onDisk === rendered) {
    status.in_sync = true;
    if (straySuffix.length > 0) {
      status.reason = `in sync${straySuffix}`;
    }
    return status;
  }
  status.in_sync = false;
  const digestMatch = DIGEST_LINE_PATTERN.exec(onDisk);
  status.reason = (digestMatch === null
    ? 'the block was never rendered (template placeholder, or its digest line was removed) — '
      + 'run `nullius notebook sync`'
    : digestMatch[1] !== projectionDigest(projection)
      ? 'registry/validity state changed since the block was written'
      : 'block text differs from the canonical render (hand edit inside the markers, or a renderer update)')
    + straySuffix;
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
  /** The projection this refresh rendered (and wrote, unless skipped). A
   *  caller that wants a post-write freshness verdict must check against
   *  THIS projection, not recompute its own: between a recompute and the
   *  earlier write another writer may land, and the check would then
   *  compare the file against a projection nobody rendered — reporting a
   *  freshly-written block as stale or, worse, a stale one as current. */
  projection: CurrentStateProjection;
};

const normalizeEol = (value: string): string => value.replace(/\r\n/g, '\n');

/** Front-matter insertion (before the first `##` heading, fence-aware),
 *  with blank-line padding on both sides IN THE FILE'S OWN EOL FLAVOR. A
 *  memo with no `##` heading at all gets the block right after its opening
 *  `#` title line (or at the very top) — appending an "opening surface" to
 *  EOF would be the opposite of its contract — and a file without a
 *  trailing newline gains one so the markers are never glued onto prose. */
function insertAtFrontMatter(text: string, rendered: string, eol: string): string {
  let offset = locateBlock(text).firstHeadingOffset;
  if (offset === text.length) {
    const firstLineEnd = text.indexOf('\n');
    offset = text.startsWith('# ') && firstLineEnd !== -1 ? firstLineEnd + 1 : 0;
  }
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const normalizedBefore = normalizeEol(before);
  const separator = normalizedBefore.length === 0 || normalizedBefore.endsWith('\n\n')
    ? ''
    : normalizedBefore.endsWith('\n') ? eol : `${eol}${eol}`;
  return `${before}${separator}${rendered}${eol}${eol}${after}`;
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
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  const projection = options?.projection
    ?? computeCurrentStateProjection(projectRoot, options?.ledgerView);
  const rendered = renderCurrentStateBlock(projection);
  // Optimistic concurrency: the notebook is a human-owned file an editor may
  // save between our read and our write, and a whole-file reconstruction
  // built on a stale read would silently discard that prose. Re-reading
  // immediately before the atomic replace and restarting on any difference
  // shrinks the loss window to the replace itself; persistent contention
  // yields an honest skip (the next read names the block out-of-sync).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let text: string;
    try {
      text = fs.readFileSync(notebookPath, 'utf-8');
    } catch {
      return { projection, action: 'skipped', reason: 'research_notebook.md not found' };
    }
    const { bounds, duplicated, markerLinesPresent, positionOk } = locateBlock(text);
    if (duplicated) {
      return { projection, action: 'skipped', reason: 'duplicated current-state markers — repair by hand first' };
    }
    // Respect the file's own end-of-line flavor: comparison is
    // EOL-normalized, and a CRLF file gets a CRLF block spliced in —
    // rewriting it to LF would fight the editor/checkout filter forever.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const renderedForFile = eol === '\r\n' ? rendered.replace(/\n/g, '\r\n') : rendered;
    let updated: string;
    let action: RefreshOutcome['action'];
    if (!bounds) {
      if (markerLinesPresent) {
        // Inserting a fresh block NEXT TO leftover marker lines would
        // manufacture the duplicated state the gate refuses on.
        return {
          projection,
          action: 'skipped',
          reason: 'stray current-state marker line(s) present without a complete block — remove them first',
        };
      }
      if (!options?.insertIfMissing) {
        return { projection, action: 'skipped', reason: 'no current-state block (run `nullius notebook sync` to adopt)' };
      }
      updated = insertAtFrontMatter(text, renderedForFile, eol);
      action = 'inserted';
    } else if (!positionOk) {
      // Relocate: a block below the first heading is inside a section,
      // where the classifier and the citation analyzer would read it as
      // content. Remove it there, reinsert canonically in front matter.
      const removed = text.slice(0, bounds.start) + text.slice(bounds.end);
      updated = insertAtFrontMatter(removed, renderedForFile, eol);
      action = 'rewritten';
    } else {
      const onDisk = text.slice(bounds.start, bounds.end);
      if (normalizeEol(onDisk) === rendered) return { projection, action: 'unchanged', reason: null };
      updated = text.slice(0, bounds.start) + renderedForFile + text.slice(bounds.end);
      action = 'rewritten';
    }
    // Preserve the researcher's own file mode; the guard re-validates the
    // optimistic read at the last userspace point before the rename (the
    // repo's beforeRename primitive exists for exactly this), shrinking the
    // clobber window from the whole staged write to the rename itself.
    let mode: number | undefined;
    try {
      mode = fs.statSync(notebookPath).mode & 0o7777;
    } catch {
      mode = undefined;
    }
    try {
      writeBytesAtomicDurable(notebookPath, Buffer.from(updated, 'utf-8'), mode, () => {
        let latest: string;
        try {
          latest = fs.readFileSync(notebookPath, 'utf-8');
        } catch {
          // The notebook vanished mid-refresh: abort the write and report
          // an honest skip, never a raw filesystem error.
          throw new Error('notebook unreadable during refresh');
        }
        if (latest !== text) {
          throw new Error('concurrent notebook edit during refresh');
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('concurrent notebook edit')) {
        continue; // recompute on the new content
      }
      if (error instanceof Error && error.message.includes('notebook unreadable')) {
        return { projection, action: 'skipped', reason: 'research_notebook.md unreadable during refresh' };
      }
      throw error;
    }
    return { projection, action, reason: null };
  }
  return {
    projection,
    action: 'skipped',
    reason: 'concurrent notebook edits kept landing during refresh — re-run `nullius notebook sync`',
  };
}
