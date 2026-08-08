import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitNotebookSections } from './notebook-staleness.js';
import { stripCurrentStateBlock } from './notebook-current-state.js';
import type { ValidityLedgerView, ValidityState } from './validity-ledger.js';

/** Link-derived run citations, append-drift signals, and dead-citation
 *  acknowledgment for the living research memo. Everything here is inferred
 *  from the ordinary relative markdown links the memo already carries —
 *  zero per-paragraph annotations — and every verdict is ADVISORY: the only
 *  fail-closed consumer is the fold-boundary gate, and only for sections a
 *  convergence packet explicitly declares rewritten.
 *
 *  Design notes that are load-bearing (judge-panel verified):
 *  - The ascending-chronology signal orders runs by their stamp events'
 *    effective (ts_utc, event_id) order but EXCLUDES same-ts_utc pairs from
 *    numerator and denominator: sub-millisecond ULID order is minted, not
 *    measured, and must never be presented as chronology. Below the
 *    comparable-pairs floor the section is `assessed: false`, never guessed.
 *  - A contiguous list (tight or loose) is ONE citation block: a curated
 *    ascending evidence list inside a healthy rewritten section must not
 *    read as forty-five append-log paragraphs. The deliberate cost of that
 *    choice: an append log REWRITTEN AS a bullet list (or a table) is one
 *    block too and therefore invisible to the drift signals — a recorded
 *    limitation, chosen over false-flagging curated lists, and bounded by
 *    the fact that drift is advisory everywhere.
 *  - Dead-citation acknowledgment is a UNION of channels: a replacement-
 *    chain link (language-neutral), a small fixed token list (the charter's
 *    own lesson idiom links the OLD run record, and void runs have no
 *    replacement chain — link-only acknowledgment would refuse charter-exact
 *    prose), or a declared `log` section role. Acknowledgment aggregates at
 *    SECTION scope: one honest sentence covers its section's other mentions.
 */

export const DRIFT_FLOOR_CITING_PARAGRAPHS = 8;
export const DRIFT_FLOOR_DISTINCT_RUNS = 8;
export const DRIFT_FLOOR_COMPARABLE_PAIRS = 6;
export const DRIFT_ASCENDING_SHARE_THRESHOLD = 0.85;
export const DRIFT_SINGLE_RUN_FRACTION_THRESHOLD = 0.6;

/** Kept deliberately small: a token only matters inside a paragraph that
 *  already links a dead run, and widening the list widens accidental
 *  masking. Non-English memos use the replacement-link channel or the
 *  section-role escape (recorded limitation, not an oversight). */
export const DEAD_ACK_TOKENS = [
  'supersede', 'supersedes', 'superseded', 'void', 'voided', 'replaced', 'ruled out', 'dead end',
] as const;

/** Section-scoped escape for deliberate chronicles. Grants no currency and
 *  is always visible in the JSON report as `exempt_declared_log`. */
const SECTION_ROLE_PATTERN = /<!--\s*notebook-section-role:\s*log\s*-->/;

/** Inline markdown link targets, plus the two explicit reference-link forms
 *  (`[text][label]`, `[label][]`) resolved against same-section definitions
 *  (`[label]: target`). Shortcut references (`[label]` alone) and autolinks
 *  are not parsed — plain bracketed prose is indistinguishable from a
 *  shortcut without a full CommonMark pass, and guessing would create false
 *  citations. A dead run cited ONLY via a shortcut reference escapes the
 *  analysis (recorded limitation). */
const LINK_TARGET_PATTERN = /\]\(([^()\s]+)\)/g;
const REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/;
const REFERENCE_FULL_PATTERN = /\[[^\]]*\]\[([^\]]+)\]/g;
const REFERENCE_COLLAPSED_PATTERN = /\[([^\]]+)\]\[\]/g;
const RUN_LINK_PATTERN = /^(?:\.\/)?(?:artifacts|team)\/runs\/([^/#?]+)/;

/** Inline code spans and HTML comments are not prose: a dead-run link inside
 *  backticks documents a path, it does not cite evidence — counting it would
 *  manufacture false fold refusals. (Fenced blocks are already excluded by
 *  the shared section splitter.) The section-role marker is read from the
 *  RAW body before this sanitization. */
function sanitizeProse(text: string): string {
  // Code spans open with a run of backticks and close with an EQUAL run
  // (CommonMark) — a single-backtick-only pattern would leave
  // double-backtick examples (the idiom for code containing a backtick)
  // visible to extraction.
  return text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/(`+)[\s\S]*?\1/g, ' ');
}

/** For TOKEN matching only: link destinations are paths, not prose — a run
 *  directory slug containing "-void-" or "-superseded-" is word-bounded by
 *  its hyphens and would otherwise acknowledge its own death. Blank every
 *  inline destination and reference-definition target before scanning. */
function blankLinkDestinations(text: string): string {
  return text
    .replace(/\]\([^()\s]+\)/g, '](#)')
    .split('\n')
    .map(line => line.replace(REFERENCE_DEFINITION_PATTERN, (_full, label: string) => `[${label}]: #`))
    .join('\n');
}

export type AckChannel = 'replacement-link' | 'token' | 'declared-log';

export type DeadCitation = {
  section: string;
  run_id: string;
  validity: Exclude<ValidityState, 'active'>;
  acknowledged: boolean;
  ack_channel: AckChannel | null;
};

export type SectionDriftReport = {
  heading: string;
  declared_log_role: boolean;
  citing_paragraphs: number;
  distinct_runs: number;
  /** Fraction of citing paragraphs citing exactly one run; null when no
   *  paragraph cites. */
  single_run_fraction: number | null;
  comparable_pairs: number;
  /** Ascending fraction over comparable adjacent pairs; null when no pair
   *  is comparable. */
  ascending_share: number | null;
  /** True only when every floor is met — below floors the verdict is
   *  `insufficient_signal` and the numbers above are disclosure, not
   *  evidence. */
  assessed: boolean;
  verdict: 'drifted' | 'insufficient_signal' | 'not_drifted' | 'exempt_declared_log';
};

export type NotebookRunLinksReport = {
  notebook_found: boolean;
  sections: SectionDriftReport[];
  drifted_sections: string[];
  dead_citations: DeadCitation[];
  unacknowledged_dead: DeadCitation[];
  /** Run-shaped link targets (no file extension) with no ledger event and
   *  no run directory — likely typos or deleted runs. Advisory. */
  unknown_run_ids: string[];
};

/** One drift-counting block, carrying its token-scope UNITS: a plain
 *  paragraph is one unit; a merged list is one unit PER ITEM, because a
 *  token in one bullet must not acknowledge a dead run linked from the
 *  next bullet — list merging is a drift-granularity decision and must not
 *  widen acknowledgment scope. */
type TokenUnit = { runIds: string[]; tokenText: string };
type CitationBlock = { runIds: string[]; units: TokenUnit[] };

/** Split a merged list block back into items (continuation lines attach to
 *  the item above); non-list blocks are a single unit. */
function splitTokenUnits(blockText: string): string[] {
  const lines = blockText.split('\n');
  const listShaped = lines.every(line => LIST_ITEM_PATTERN.test(line) || /^\s{2,}/.test(line));
  if (!listShaped) return [blockText];
  const items: string[][] = [];
  for (const line of lines) {
    if (LIST_ITEM_PATTERN.test(line) || items.length === 0) items.push([line]);
    else items[items.length - 1]!.push(line);
  }
  return items.map(item => item.join('\n'));
}

const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Blank-line paragraph segmentation over a section body (already
 *  fence-stripped by the shared splitter), then consecutive list-item
 *  blocks merge into ONE block — tight or loose, a list is one citation
 *  unit. */
export function segmentCitationBlocks(body: string[]): string[] {
  const rawBlocks: string[][] = [];
  let current: string[] = [];
  for (const line of body) {
    if (line.trim() === '') {
      if (current.length > 0) { rawBlocks.push(current); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) rawBlocks.push(current);

  const merged: string[][] = [];
  for (const block of rawBlocks) {
    const isList = block.every(line => LIST_ITEM_PATTERN.test(line) || /^\s{2,}/.test(line));
    const prev = merged.length > 0 ? merged[merged.length - 1]! : null;
    const prevIsList = prev !== null && prev.every(line => LIST_ITEM_PATTERN.test(line) || /^\s{2,}/.test(line));
    if (isList && prevIsList && prev) {
      prev.push(...block);
    } else {
      merged.push([...block]);
    }
  }
  return merged.map(block => block.join('\n'));
}

function runIdFromTarget(rawTarget: string): string | null {
  // CommonMark permits an angle-bracketed destination in both inline links
  // and reference definitions: `[r]: <artifacts/runs/x/f>`.
  const target = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget;
  const runMatch = RUN_LINK_PATTERN.exec(target);
  if (!runMatch) return null;
  const id = runMatch[1]!;
  if (id.includes('.')) return null; // a file directly under the runs root (ledger, attributes), not a run
  return id;
}

/** Reference-link definitions of one section: lowercased label → run id.
 *  A definition line renders invisibly, so the definition's own block never
 *  counts as a citation — only blocks that USE the label do. */
function collectReferenceDefinitions(body: string[]): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const line of body) {
    const match = REFERENCE_DEFINITION_PATTERN.exec(sanitizeProse(line));
    if (!match) continue;
    const id = runIdFromTarget(match[2]!);
    if (id !== null) definitions.set(match[1]!.trim().toLowerCase(), id);
  }
  return definitions;
}

function extractRunIds(sanitizedBlockText: string, definitions: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  const push = (id: string | null): void => {
    if (id !== null && !ids.includes(id)) ids.push(id);
  };
  for (const match of sanitizedBlockText.matchAll(LINK_TARGET_PATTERN)) {
    push(runIdFromTarget(match[1]!));
  }
  for (const match of sanitizedBlockText.matchAll(REFERENCE_FULL_PATTERN)) {
    push(definitions.get(match[1]!.trim().toLowerCase()) ?? null);
  }
  for (const match of sanitizedBlockText.matchAll(REFERENCE_COLLAPSED_PATTERN)) {
    push(definitions.get(match[1]!.trim().toLowerCase()) ?? null);
  }
  return ids;
}

/** Word-bounded token matching: `void` must not match inside `avoid`, and
 *  multi-word tokens tolerate any whitespace run between words. */
const ACK_TOKEN_PATTERNS = DEAD_ACK_TOKENS.map(
  token => new RegExp(`\\b${token.replace(/ /g, '\\s+')}\\b`, 'i'),
);

/** Follow the supersede chain from a dead run, cycle-guarded. Returns every
 *  run id reachable as a replacement (any of which acknowledges the death
 *  when linked from the same section). */
function replacementChain(ledger: ValidityLedgerView, runId: string): Set<string> {
  const chain = new Set<string>();
  let cursor = ledger.runs.get(runId)?.superseded_by ?? null;
  let hops = 0;
  while (cursor && !chain.has(cursor) && hops < 32) {
    chain.add(cursor);
    cursor = ledger.runs.get(cursor)?.superseded_by ?? null;
    hops += 1;
  }
  return chain;
}

export function analyzeNotebookRunLinks(
  projectRoot: string,
  ledger: ValidityLedgerView,
  existingRunDirIds: ReadonlySet<string>,
): NotebookRunLinksReport {
  const report: NotebookRunLinksReport = {
    notebook_found: false,
    sections: [],
    drifted_sections: [],
    dead_citations: [],
    unacknowledged_dead: [],
    unknown_run_ids: [],
  };
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  if (!fs.existsSync(notebookPath)) return report;
  report.notebook_found = true;
  let text: string;
  try {
    text = fs.readFileSync(notebookPath, 'utf-8');
  } catch {
    return report;
  }

  // First stamp event per run in the ledger's effective order gives the
  // chronology axis. ts_utc alone is compared; equal timestamps are later
  // excluded pair-by-pair.
  const stampTs = new Map<string, string>();
  for (const event of ledger.events) {
    if (event.event === 'stamp' && !stampTs.has(event.run_id)) {
      stampTs.set(event.run_id, event.ts_utc);
    }
  }

  const unknownSeen = new Set<string>();
  // The machine-rendered current-state block is a view, not prose: its
  // artifact links must never count as citations, wherever the block sits.
  for (const section of splitNotebookSections(stripCurrentStateBlock(text))) {
    const body = section.body.join('\n');
    // Role detection reads the RAW body — the marker IS an HTML comment.
    const declaredLog = SECTION_ROLE_PATTERN.test(body);
    const definitions = collectReferenceDefinitions(section.body);
    const blocks: CitationBlock[] = [];
    for (const blockText of segmentCitationBlocks(section.body)) {
      const sanitized = sanitizeProse(blockText);
      const candidates = extractRunIds(sanitized, definitions);
      const runIds = candidates.filter(id => ledger.runs.has(id) || existingRunDirIds.has(id));
      for (const id of candidates) {
        if (!ledger.runs.has(id) && !existingRunDirIds.has(id) && !unknownSeen.has(id)) {
          unknownSeen.add(id);
          report.unknown_run_ids.push(id);
        }
      }
      if (runIds.length > 0) {
        const units = splitTokenUnits(blockText).map(unitText => {
          const unitSanitized = sanitizeProse(unitText);
          return {
            runIds: extractRunIds(unitSanitized, definitions)
              .filter(id => ledger.runs.has(id) || existingRunDirIds.has(id)),
            tokenText: blankLinkDestinations(unitSanitized),
          };
        });
        blocks.push({ runIds, units });
      }
    }

    const citing = blocks.length;
    const distinct = new Set(blocks.flatMap(block => block.runIds)).size;
    const singleRunBlocks = blocks.filter(block => block.runIds.length === 1);
    const singleRunFraction = citing > 0 ? singleRunBlocks.length / citing : null;

    // Adjacent pairs over the single-run sequence in document order.
    let comparable = 0;
    let ascending = 0;
    for (let i = 1; i < singleRunBlocks.length; i += 1) {
      const a = stampTs.get(singleRunBlocks[i - 1]!.runIds[0]!);
      const b = stampTs.get(singleRunBlocks[i]!.runIds[0]!);
      if (a === undefined || b === undefined) continue; // unstamped: not orderable, excluded
      if (a === b) continue; // same-ts tie: minted order, never chronology
      comparable += 1;
      if (a < b) ascending += 1;
    }
    const ascendingShare = comparable > 0 ? ascending / comparable : null;

    const floorsMet = citing >= DRIFT_FLOOR_CITING_PARAGRAPHS
      && distinct >= DRIFT_FLOOR_DISTINCT_RUNS
      && comparable >= DRIFT_FLOOR_COMPARABLE_PAIRS;
    let verdict: SectionDriftReport['verdict'];
    if (declaredLog) {
      verdict = 'exempt_declared_log';
    } else if (!floorsMet) {
      verdict = 'insufficient_signal';
    } else if (
      (ascendingShare ?? 0) >= DRIFT_ASCENDING_SHARE_THRESHOLD
      && (singleRunFraction ?? 0) >= DRIFT_SINGLE_RUN_FRACTION_THRESHOLD
    ) {
      verdict = 'drifted';
    } else {
      verdict = 'not_drifted';
    }
    report.sections.push({
      heading: section.heading,
      declared_log_role: declaredLog,
      citing_paragraphs: citing,
      distinct_runs: distinct,
      single_run_fraction: singleRunFraction,
      comparable_pairs: comparable,
      ascending_share: ascendingShare,
      assessed: floorsMet && !declaredLog,
      verdict,
    });
    if (verdict === 'drifted') report.drifted_sections.push(section.heading);

    // Dead citations. Channel scopes differ deliberately:
    //  - replacement-link: SECTION scope — a chain member names the specific
    //    dead run it replaces, so it can never acknowledge a different one;
    //  - token: the CITING BLOCK only — generic words ("superseded") in one
    //    paragraph must not blanket-acknowledge every other dead run the
    //    section happens to cite (the charter's lesson idiom puts word and
    //    link in the same sentence anyway);
    //  - declared-log: SECTION scope by definition.
    const deadInSection = new Map<string, Exclude<ValidityState, 'active'>>();
    const sectionRunIds = new Set(blocks.flatMap(block => block.runIds));
    for (const id of sectionRunIds) {
      const validity = ledger.runs.get(id)?.validity;
      if (validity === 'superseded' || validity === 'void') deadInSection.set(id, validity);
    }
    if (deadInSection.size === 0) continue;
    for (const [id, validity] of deadInSection) {
      let channel: AckChannel | null = null;
      if (declaredLog) {
        channel = 'declared-log';
      } else {
        const chain = replacementChain(ledger, id);
        if ([...chain].some(replacement => sectionRunIds.has(replacement))) {
          channel = 'replacement-link';
        } else if (blocks.some(block => block.units.some(unit => unit.runIds.includes(id)
          && ACK_TOKEN_PATTERNS.some(pattern => pattern.test(unit.tokenText))))) {
          channel = 'token';
        }
      }
      const citation: DeadCitation = {
        section: section.heading,
        run_id: id,
        validity,
        acknowledged: channel !== null,
        ack_channel: channel,
      };
      report.dead_citations.push(citation);
      if (!citation.acknowledged) report.unacknowledged_dead.push(citation);
    }
  }
  return report;
}
