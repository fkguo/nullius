import * as fs from 'node:fs';
import { writeBytesAtomicDurable } from '@nullius/shared';

/** Shared engine for MACHINE-OWNED markdown blocks (the notebook
 *  current-state block, the project-index run-index block): one set of
 *  battle-tested rules for locating, validating, splicing, and refreshing
 *  a marker-delimited region inside a human-owned file.
 *
 *  Everything subtle in here was paid for by review rounds on the first
 *  consumer and is deliberately shared so the second consumer cannot
 *  drift from it:
 *  - fence-aware AND indented-code-aware marker scanning (a doc QUOTING
 *    the markers is neither a block nor a duplication);
 *  - INNERMOST pairing (outermost pairing was a proven data-loss hazard:
 *    a stray START above the real block swallowed the prose between);
 *  - CR-excluded marker extents (a CRLF file must never leak a stray \r
 *    into slices);
 *  - interior WHITELIST (a blacklist of prose shapes proved unwinnable):
 *    only a digest-first interior with no ATX heading, or the scaffold's
 *    parenthetical placeholder (empty included), is rewritable — every
 *    other marker pair is stray garbage wrapped around human content,
 *    advisory and never spliced;
 *  - EOL-normalized comparison with EOL-preserving splice (a checkout
 *    filter converting the file to CRLF is not a content change);
 *  - optimistic concurrency with a pre-rename re-validation, so a human
 *    save between read and write is retried, never clobbered.
 */

export type ManagedBlockSpec = {
  startMarker: string;
  endMarker: string;
  /** Anchored test for the FIRST interior line of a rendered block (the
   *  digest comment). Must match the whole line (legal 0-3 space indent
   *  tolerated by the caller's pattern). */
  digestFirstLinePattern: RegExp;
  /** Short noun used in operator-facing reasons, e.g. 'current-state'. */
  blockNoun: string;
  /** The repair verb, e.g. '`nullius notebook sync`'. */
  syncCommand: string;
  /** Human name of the carrier file for skip reasons. */
  fileLabel: string;
  /** Short noun for the carrier in the persistent-contention reason,
   *  e.g. 'notebook'. */
  carrierNoun: string;
  /** When true the block must sit BEFORE the first `##` heading and gets
   *  relocated there; when false position is unconstrained. */
  frontMatterPosition: boolean;
  /** Reason rendered when frontMatterPosition is violated. */
  positionReason?: string;
  /** Reason for a digest that no longer matches the projection. */
  stateChangedReason: string;
};

export type BlockBounds = { start: number; end: number };

export type ManagedBlockLocation = {
  bounds: BlockBounds | null;
  duplicated: boolean;
  markerLinesPresent: boolean;
  strayMarkerLines: number;
  firstHeadingOffset: number;
  positionOk: boolean;
};

export const normalizeEol = (value: string): string => value.replace(/\r\n/g, '\n');

/** A CommonMark fenced-code delimiter.  Closing fences must match the
 * opener's character and be at least as long; a different delimiter inside
 * a fence is ordinary code, not a close. */
export type MarkdownFence = { marker: '`' | '~'; length: number };

/** Advance a fenced-code state by one physical line.  The caller owns what
 * to do with a fence line; returning the same object means that the line is
 * ordinary content inside an open fence. */
export function advanceMarkdownFence(
  active: MarkdownFence | null,
  line: string,
): MarkdownFence | null {
  if (active !== null) {
    const closing = new RegExp(`^ {0,3}${active.marker}{${active.length},}[ \\t]*$`);
    return closing.test(line) ? null : active;
  }
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (opening === null) return null;
  const delimiter = opening[1]!;
  return { marker: delimiter[0]! as MarkdownFence['marker'], length: delimiter.length };
}

export function locateManagedBlock(text: string, spec: ManagedBlockSpec): ManagedBlockLocation {
  const lines = text.split('\n');
  let fence: MarkdownFence | null = null;
  let offset = 0;
  let firstHeadingOffset = text.length;
  type MarkerLine = BlockBounds & { lineIndex: number };
  const starts: MarkerLine[] = [];
  const ends: MarkerLine[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    const contentEnd = offset + content.length;
    const indentedCode = /^(?: {4}|\t)/.test(content);
    const priorFence: MarkdownFence | null = fence;
    fence = advanceMarkdownFence(fence, content);
    if (priorFence === fence && fence === null && !indentedCode) {
      const trimmed = content.trim();
      if (trimmed === spec.startMarker) starts.push({ start: offset, end: contentEnd, lineIndex });
      else if (trimmed === spec.endMarker) ends.push({ start: offset, end: contentEnd, lineIndex });
      else if (/^##\s+/.test(content) && firstHeadingOffset === text.length) firstHeadingOffset = offset;
    }
    offset = offset + line.length + 1;
  }
  const markerLinesPresent = starts.length > 0 || ends.length > 0;
  // INNERMOST pairing: each END claims the NEAREST PRECEDING unclaimed
  // START, so a block never contains another marker line and nested pairs
  // surface as TWO complete blocks (duplicated → refusal, no write).
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
  // Interior WHITELIST — the last line of defense against splicing away
  // human prose. Rewritable interiors are exactly:
  //  (a) the rendered block: digest comment as the FIRST interior line and
  //      no ATX heading at legal indent anywhere (a real block's END
  //      deleted would pair its START with a leftover END far below and
  //      swallow whole sections; the canonical render emits no heading);
  //  (b) the scaffold placeholder: one short parenthetical note — no blank
  //      lines, no ATX heading of any level, no setext underline, no link
  //      syntax — or a fully EMPTY interior (nothing to lose; self-heals).
  // Recorded limitation: heading detection is ATX-only.
  let strayFromInvalidPairs = 0;
  const completeBlocks: BlockBounds[] = [];
  for (const pair of pairedBlocks) {
    const interiorContent = pair.interiorLines
      .map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
    const digestFirst = spec.digestFirstLinePattern.test(interiorContent[0] ?? '')
      && !interiorContent.some(line => /^ {0,3}#{1,6}(?:\s|$)/.test(line));
    const trimmedInterior = interiorContent.join('\n').trim();
    const placeholderShaped = trimmedInterior === ''
      || (interiorContent.length <= 6
        && trimmedInterior.length <= 400
        && !interiorContent.some(line => line.trim() === '')
        && !interiorContent.some(line => /^ {0,3}#{1,6}(?:\s|$)/.test(line))
        && !interiorContent.some(line => /^ {0,3}(?:=+|-+) *$/.test(line))
        && trimmedInterior.startsWith('(')
        && trimmedInterior.endsWith(')')
        && !trimmedInterior.includes('](')
        && !trimmedInterior.includes(']['));
    if (!digestFirst && !placeholderShaped) {
      strayFromInvalidPairs += 2;
      continue;
    }
    completeBlocks.push(pair.bounds);
  }
  const duplicated = completeBlocks.length > 1;
  const bounds = completeBlocks.length === 1 ? completeBlocks[0]! : null;
  const strayMarkerLines = unclaimedStarts.length + strayEnds + strayFromInvalidPairs;
  // The WHOLE block must satisfy the position rule: an end-side overrun
  // would swallow the heading a start-only check blesses.
  const positionOk = bounds === null || !spec.frontMatterPosition
    ? true
    : bounds.end <= firstHeadingOffset;
  return { bounds, duplicated, markerLinesPresent, strayMarkerLines, firstHeadingOffset, positionOk };
}

export type ManagedBlockStatus = {
  file_found: boolean;
  block_found: boolean;
  duplicated_markers: boolean;
  in_sync: boolean | null;
  reason: string | null;
};

/** Freshness verdict for the block inside `filePath` against the caller's
 *  canonical `rendered` bytes (LF-normalized). `digestOf` extracts the
 *  digest hex from a rendered/on-disk block, used to distinguish "state
 *  moved" from "hand edit / renderer change". */
export function checkManagedBlock(
  filePath: string,
  rendered: string,
  spec: ManagedBlockSpec,
  digestPattern: RegExp,
  expectedDigest: string,
): ManagedBlockStatus {
  const status: ManagedBlockStatus = {
    file_found: false, block_found: false, duplicated_markers: false, in_sync: null, reason: null,
  };
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return status;
  }
  status.file_found = true;
  const { bounds, duplicated, markerLinesPresent, strayMarkerLines, positionOk } = locateManagedBlock(text, spec);
  status.duplicated_markers = duplicated;
  if (duplicated) {
    status.reason = `duplicated ${spec.blockNoun} markers — repair by hand, then ${spec.syncCommand}`;
    return status;
  }
  if (!bounds) {
    if (markerLinesPresent) {
      status.reason = `stray ${spec.blockNoun} marker line(s) present — unpaired, or a marker pair whose `
        + `interior is not machine-rendered content; remove them, then ${spec.syncCommand}`;
    }
    return status;
  }
  const straySuffix = strayMarkerLines > 0
    ? `; ${strayMarkerLines} stray marker line(s) also present — remove them`
    : '';
  status.block_found = true;
  if (!positionOk) {
    status.in_sync = false;
    status.reason = `${spec.positionReason ?? 'block is misplaced'}${straySuffix}`;
    return status;
  }
  const onDisk = normalizeEol(text.slice(bounds.start, bounds.end));
  if (onDisk === rendered) {
    status.in_sync = true;
    if (straySuffix.length > 0) {
      status.reason = `in sync${straySuffix}`;
    }
    return status;
  }
  status.in_sync = false;
  const digestMatch = digestPattern.exec(onDisk);
  status.reason = (digestMatch === null
    ? `the block was never rendered (template placeholder, or its digest line was removed) — `
      + `run ${spec.syncCommand}`
    : digestMatch[1] !== expectedDigest
      ? spec.stateChangedReason
      : 'block text differs from the canonical render (hand edit inside the markers, or a renderer update)')
    + straySuffix;
  return status;
}

export type ManagedBlockRefreshOutcome = {
  action: 'inserted' | 'rewritten' | 'unchanged' | 'skipped';
  reason: string | null;
};

/** Refresh the block in place. `renderLatest` is invoked ONCE PER RETRY
 *  ATTEMPT: on a detected concurrent edit the loop must re-render from the
 *  now-current state, or a writer that lost the first race would replace
 *  the winner's NEWER block with its own stale bytes (real for any block
 *  whose projection moves on every write — the run index — and harmless
 *  redundancy for stamp-stable blocks). `insertAt` chooses the insertion
 *  offset for a file that has no block yet. The engine owns padding, EOL
 *  flavor, the optimistic-concurrency retry loop, and mode preservation. */
export function refreshManagedBlock(
  filePath: string,
  renderLatest: () => string,
  spec: ManagedBlockSpec,
  options: {
    insertIfMissing: boolean;
    missingBlockReason: string;
    insertAt: (text: string, location: ManagedBlockLocation) => number;
  },
): ManagedBlockRefreshOutcome {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { action: 'skipped', reason: `${spec.fileLabel} not found` };
    }
    // Render AFTER the carrier read: a rival whose ledger write precedes
    // its carrier write is then either visible to this render (rival's
    // carrier write already landed → our read saw it → our render reads
    // even later state) or caught by the optimistic guard at write time
    // (rival lands between our read and our rename → text changed →
    // retry). Rendering first would leave a window where a stale render
    // silently replaces the rival's fresher block.
    const rendered = renderLatest();
    const location = locateManagedBlock(text, spec);
    const { bounds, duplicated, markerLinesPresent, positionOk } = location;
    if (duplicated) {
      return { action: 'skipped', reason: `duplicated ${spec.blockNoun} markers — repair by hand first` };
    }
    // EOL flavor: a REPLACED block keeps its own local convention (a
    // mixed-EOL file must not have its LF block flipped to CRLF by one
    // stray CRLF line elsewhere); an INSERTED block follows the file.
    const blockLocalEol = bounds !== null && text.slice(bounds.start, bounds.end).includes('\r\n');
    const eol = (bounds !== null ? blockLocalEol : text.includes('\r\n')) ? '\r\n' : '\n';
    const renderedForFile = eol === '\r\n' ? rendered.replace(/\n/g, '\r\n') : rendered;
    const insertRendered = (base: string): string => {
      const offset = options.insertAt(base, locateManagedBlock(base, spec));
      const before = base.slice(0, offset);
      const after = base.slice(offset);
      const normalizedBefore = normalizeEol(before);
      const separator = normalizedBefore.length === 0 || normalizedBefore.endsWith('\n\n')
        ? ''
        : normalizedBefore.endsWith('\n') ? eol : `${eol}${eol}`;
      return `${before}${separator}${renderedForFile}${eol}${eol}${after}`;
    };
    let updated: string;
    let action: ManagedBlockRefreshOutcome['action'];
    if (!bounds) {
      if (markerLinesPresent) {
        return {
          action: 'skipped',
          reason: `stray ${spec.blockNoun} marker line(s) present (unpaired, or a pair whose interior is not `
            + 'machine-rendered content) — remove them first',
        };
      }
      if (!options.insertIfMissing) {
        return { action: 'skipped', reason: options.missingBlockReason };
      }
      updated = insertRendered(text);
      action = 'inserted';
    } else if (!positionOk) {
      const removed = text.slice(0, bounds.start) + text.slice(bounds.end);
      updated = insertRendered(removed);
      action = 'rewritten';
    } else {
      const onDisk = text.slice(bounds.start, bounds.end);
      if (normalizeEol(onDisk) === rendered) return { action: 'unchanged', reason: null };
      updated = text.slice(0, bounds.start) + renderedForFile + text.slice(bounds.end);
      action = 'rewritten';
    }
    let mode: number | undefined;
    try {
      mode = fs.statSync(filePath).mode & 0o7777;
    } catch {
      mode = undefined;
    }
    try {
      writeBytesAtomicDurable(filePath, Buffer.from(updated, 'utf-8'), mode, () => {
        let latest: string;
        try {
          latest = fs.readFileSync(filePath, 'utf-8');
        } catch {
          throw new Error('carrier unreadable during refresh');
        }
        if (latest !== text) {
          throw new Error('concurrent carrier edit during refresh');
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('concurrent carrier edit')) {
        continue;
      }
      if (error instanceof Error && error.message.includes('carrier unreadable')) {
        return { action: 'skipped', reason: `${spec.fileLabel} unreadable during refresh` };
      }
      throw error;
    }
    return { action, reason: null };
  }
  return {
    action: 'skipped',
    reason: `concurrent ${spec.carrierNoun} edits kept landing during refresh — re-run ${spec.syncCommand}`,
  };
}

/** Cell text rendered into a managed block often comes from UNTRUSTED
 *  names (directory basenames, registry cells) — hostile names
 *  are possible, and an unescaped `|` mints extra table columns while `]`
 *  terminates a link label. Control characters (a legal POSIX basename may
 *  carry a NEWLINE) are replaced outright: one smuggled line break would
 *  end the table row mid-cell — or fabricate a heading/marker line that
 *  wedges the whole block behind the interior whitelist, with the machine's
 *  own markers reported as strays the operator cannot meaningfully remove.
 *  Then backslash-escape the structural characters — INCLUDING `<`/`>`: a
 *  basename carrying a literal `<!-- RESULT_REGISTRY_START -->` would
 *  otherwise mint a second marker substring and make the registry parser
 *  refuse the genuine block. Backticks stay (they cannot break table,
 *  link, or marker structure). */
export function escapeMarkdownCell(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/([\\|[\]<>])/g, '\\$1');
}

/** Link destination: percent-encode so spaces, parentheses, angle
 *  brackets, control characters, and the reserved `#`/`?` (which encodeURI
 *  leaves alone but which start a fragment/query in a rendered link) in a
 *  directory name cannot terminate or corrupt the target. */
export function encodeLinkTarget(target: string): string {
  return encodeURI(target).replace(/[()#?\u0000-\u001f\u007f]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
