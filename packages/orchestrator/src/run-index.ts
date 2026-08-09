import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, readValidityLedger, type ValidityLedgerView } from './validity-ledger.js';
import { parseResultRegistry } from './result-registry.js';
import { listRunDirectories, slugFamilyOf } from './run-directories.js';
import {
  checkManagedBlock,
  refreshManagedBlock,
  type ManagedBlockLocation,
  type ManagedBlockSpec,
  type ManagedBlockStatus,
} from './managed-block.js';

/** The machine-written run index in project_index.md.
 *
 *  Measured problem (2026-08 usage audit of a real project): 85 of one
 *  milestone's 148 run directories appeared in no planning document, and
 *  the only browsable map — the task board — held ONE line for all of
 *  them. The index renders the ledger's answer per slug FAMILY (a dozen
 *  rows, not 148): how many runs, how their validity splits, which run is
 *  latest, which results currently rest on the family. Per-run machine
 *  detail stays in `nullius status --json`; this surface is for a human
 *  browsing the project file.
 *
 *  One block, one writer: this block is orchestrator-owned. The adjacent
 *  PROJECT_INDEX_AUTO block belongs to the research-team latest-pointers
 *  updater and is never touched.
 *
 *  Deterministic render + digest/byte dual-channel freshness, exactly the
 *  notebook current-state block's contract (shared engine). Inputs are
 *  the directory scan, the ledger view, and the registry PARSE only —
 *  no artifact hashing and no git subprocesses, so the per-ledger-write
 *  refresh hooks stay cheap. */

export const RUN_INDEX_START = '<!-- RUN_INDEX_START -->';
export const RUN_INDEX_END = '<!-- RUN_INDEX_END -->';
const DIGEST_LINE_PATTERN = /<!--\s*run-index-digest:\s*([0-9a-f]{64})\s*-->/;
const PROJECT_INDEX_AUTO_START = '<!-- PROJECT_INDEX_AUTO_START -->';

const RUN_INDEX_BLOCK_SPEC: ManagedBlockSpec = {
  startMarker: RUN_INDEX_START,
  endMarker: RUN_INDEX_END,
  digestFirstLinePattern: /^ {0,3}<!--\s*run-index-digest:\s*[0-9a-f]{64}\s*--> *$/,
  blockNoun: 'run-index',
  syncCommand: '`nullius index sync`',
  fileLabel: 'project_index.md',
  carrierNoun: 'project_index.md',
  frontMatterPosition: false,
  stateChangedReason: 'run/ledger state changed since the block was written',
};

export type RunIndexFamilyLatest = {
  run_id: string;
  /** Canonical root, POSIX-style, for the rendered link. */
  root: string;
  validity: 'active' | 'superseded' | 'void' | 'unclassified';
  stamped: boolean;
  /** 1 = single attempt; >1 = the run was retried. */
  latest_ordinal: number;
};

export type RunIndexFamily = {
  family: string;
  runs: number;
  active: number;
  superseded: number;
  void: number;
  /** Directories with no ledger event at all (legacy / never stamped). */
  unclassified: number;
  latest: RunIndexFamilyLatest;
  /** CURRENT registry rows whose run belongs to this family. A row is
   *  DEFECTIVE when the ledger already contradicts its currency claim
   *  (run not active, resultless head attempt, chain/identity defects,
   *  inexact binding) — pure Map lookups on the ledger view, never the
   *  validator's artifact re-hash. */
  current_results: Array<{ result_id: string; defective: boolean }>;
};

export type RunIndexProjection = {
  run_directories: number;
  mirrored: number;
  totals: { active: number; superseded: number; void: number; unclassified: number; stamped: number };
  families: RunIndexFamily[];
  /** Ledger honesty defects — rendered unconditionally when nonzero.
   *  (The crashed-unretried ambient scan needs workspace discovery and
   *  stays on `nullius current`; this projection reads no run interiors.) */
  defects: {
    conflicting_stamps: string[];
    attempt_chain_defects: string[];
    no_authoritative_identity: string[];
    /** Ledger events about run ids with no directory on disk. */
    ledger_only: string[];
    /** CURRENT registry rows naming a run with NO directory on disk —
     *  the star would otherwise silently vanish from every family row. */
    registry_only_current: string[];
  };
  registry_block_found: boolean;
};

export function computeRunIndexProjection(
  projectRoot: string,
  ledgerView?: ValidityLedgerView,
): RunIndexProjection {
  const ledger = ledgerView ?? readValidityLedger(projectRoot);
  // PARSE, never validate: the projection consumes only the parsed rows
  // and block presence. validateResultRegistry re-reads and SHA-256s
  // EVERY registered artifact — a cost the notebook hook deliberately
  // gates behind registryMentionsRun, and which must never ride on the
  // ungated per-stamp index hook (nor run twice per status read).
  const registry = parseResultRegistry(projectRoot);
  const directories = listRunDirectories(projectRoot);
  const directoryIds = new Set(directories.map(entry => entry.run_id));

  const currentByRun = new Map<string, string[]>();
  for (const row of registry.rows) {
    if (row.superseded_by !== 'none') continue;
    const list = currentByRun.get(row.run_id) ?? [];
    list.push(row.result_id);
    currentByRun.set(row.run_id, list);
  }

  type FamilyAccumulator = {
    family: string;
    runs: number;
    active: number;
    superseded: number;
    void: number;
    unclassified: number;
    latest: RunIndexFamilyLatest;
    /** Sort key for "latest": the run id itself (date-prefixed by
     *  convention, so lexicographic order IS launch order). Capture time
     *  deliberately does not participate: in a family mixing stamped and
     *  unstamped runs an unstamped run has no capture time, and any
     *  time-first key would make a September hand-made directory lose to
     *  an August stamped run — the exact directory a browsing researcher
     *  is looking for. (D3 revised accordingly; ids without a date prefix
     *  order lexicographically, an honest stated limit.) */
    latestKey: string;
    current_results: Array<{ result_id: string; defective: boolean }>;
  };
  const families = new Map<string, FamilyAccumulator>();
  const totals = { active: 0, superseded: 0, void: 0, unclassified: 0, stamped: 0 };
  let mirrored = 0;

  for (const entry of directories) {
    if (entry.mirrored) mirrored += 1;
    const known = ledger.runs.get(entry.run_id);
    const validity: RunIndexFamilyLatest['validity'] = known ? known.validity : 'unclassified';
    totals[validity] += 1;
    const stamped = known?.stamped === true;
    if (stamped) totals.stamped += 1;
    const latest: RunIndexFamilyLatest = {
      run_id: entry.run_id,
      root: entry.canonical_root.split(path.sep).join('/'),
      validity,
      stamped,
      latest_ordinal: known?.attempts.latest_ordinal ?? 1,
    };
    const family = slugFamilyOf(entry.run_id);
    const accumulator = families.get(family) ?? {
      family, runs: 0, active: 0, superseded: 0, void: 0, unclassified: 0,
      latest, latestKey: entry.run_id, current_results: [],
    };
    accumulator.runs += 1;
    accumulator[validity] += 1;
    if (entry.run_id > accumulator.latestKey || accumulator.runs === 1) {
      accumulator.latest = latest;
      accumulator.latestKey = entry.run_id;
    }
    const currents = currentByRun.get(entry.run_id);
    if (currents) {
      const bindingQuality = (known?.origin as { binding_quality?: string } | null | undefined)?.binding_quality;
      const defective = !known
        // Active-but-UNSTAMPED is reachable (e.g. a reinstate-only entry)
        // and carries no origin at all — the binding-quality arm below
        // cannot see it, and the registry read side calls it defective.
        || !known.stamped
        || known.validity !== 'active'
        || known.no_authoritative_identity
        || known.conflicting_stamps
        || known.attempts.chain_defect
        || known.attempts.conflicting_attempts
        || known.attempts.latest_failed
        || bindingQuality === 'aligned_heuristic'
        || bindingQuality === 'unbound';
      accumulator.current_results.push(...currents.map(resultId => ({ result_id: resultId, defective })));
    }
    families.set(family, accumulator);
  }

  const ledgerOnly = [...ledger.runs.keys()].filter(runId => !directoryIds.has(runId)).sort();
  // A CURRENT registry row naming a run with NO directory would otherwise
  // simply vanish from every family row — the star must fail loudly, not
  // silently.
  const registryOnlyCurrent = [...currentByRun.entries()]
    .filter(([runId]) => !directoryIds.has(runId))
    .flatMap(([runId, resultIds]) => resultIds.map(resultId => `${resultId} (run ${runId})`))
    .sort();

  return {
    run_directories: directories.length,
    mirrored,
    totals,
    families: [...families.values()]
      .sort((a, b) => b.runs - a.runs || (a.family < b.family ? -1 : 1))
      .map(({ latestKey: _latestKey, ...family }) => ({
        ...family,
        current_results: [...family.current_results]
          .sort((a, b) => (a.result_id < b.result_id ? -1 : 1)),
      })),
    defects: {
      conflicting_stamps: [...ledger.runs.values()].filter(entry => entry.conflicting_stamps)
        .map(entry => entry.run_id).sort(),
      attempt_chain_defects: [...ledger.runs.values()]
        .filter(entry => entry.attempts.chain_defect || entry.attempts.conflicting_attempts)
        .map(entry => entry.run_id).sort(),
      no_authoritative_identity: [...ledger.runs.values()].filter(entry => entry.no_authoritative_identity)
        .map(entry => entry.run_id).sort(),
      ledger_only: ledgerOnly,
      registry_only_current: registryOnlyCurrent,
    },
    registry_block_found: registry.block_found,
  };
}

export function runIndexDigest(projection: RunIndexProjection): string {
  return createHash('sha256').update(canonicalJson(projection), 'utf-8').digest('hex');
}

const listWithCap = (ids: string[], cap = 5): string =>
  `${ids.slice(0, cap).map(escapeMarkdownCell).join(', ')}${ids.length > cap ? `, +${ids.length - cap} more` : ''}`;

/** Run ids and family stems come from DIRECTORY BASENAMES — hostile names
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
function escapeMarkdownCell(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/([\\|[\]<>])/g, '\\$1');
}

/** Link destination: percent-encode so spaces, parentheses, angle
 *  brackets, control characters, and the reserved `#`/`?` (which encodeURI
 *  leaves alone but which start a fragment/query in a rendered link) in a
 *  directory name cannot terminate or corrupt the target. */
function encodeLinkTarget(target: string): string {
  return encodeURI(target).replace(/[()#?\u0000-\u001f\u007f]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The full block, markers inclusive. Deterministic — byte-compare against
 *  this render is the freshness truth (no dates, no counters). */
export function renderRunIndexBlock(projection: RunIndexProjection): string {
  const lines: string[] = [];
  lines.push(RUN_INDEX_START);
  lines.push(`<!-- run-index-digest: ${runIndexDigest(projection)} -->`);
  lines.push('**Run index (auto-maintained).** Machine-rendered from the run');
  lines.push('directories and the validity ledger, grouped by slug family. Do not');
  lines.push('edit between these markers — refresh with `nullius index sync`; full');
  lines.push('answer (defect details, crashed runs, attempt chains): `nullius current`.');
  lines.push('');
  if (projection.run_directories === 0) {
    lines.push('No run directories yet under artifacts/runs/ or team/runs/ — an honest');
    lines.push('empty state, not an error. Runs appear here as they are created.');
  } else {
    const { totals } = projection;
    lines.push(`${projection.run_directories} run director${projection.run_directories === 1 ? 'y' : 'ies'}`
      + `${projection.mirrored > 0 ? ` (${projection.mirrored} mirrored in both roots)` : ''}: `
      + `${totals.active} active · ${totals.superseded} superseded · ${totals.void} void · `
      + `${totals.unclassified} unclassified · ${totals.stamped} stamped.`);
    lines.push('');
    lines.push('| Family | Runs | Active | Sup. | Void | Uncl. | Latest run | Current results |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const family of projection.families) {
      const latest = family.latest;
      const notes: string[] = [];
      if (latest.validity !== 'active') notes.push(latest.validity);
      if (latest.latest_ordinal > 1) notes.push(`attempt ${latest.latest_ordinal}`);
      const latestCell = `[${escapeMarkdownCell(latest.run_id)}](${encodeLinkTarget(`${latest.root}/${latest.run_id}/`)})`
        + (notes.length > 0 ? ` (${notes.join(', ')})` : '');
      const currentCell = family.current_results.length > 0
        ? family.current_results
          .map(entry => `★${escapeMarkdownCell(entry.result_id)}${entry.defective ? ' (DEFECTIVE)' : ''}`)
          .join(', ')
        : '—';
      lines.push(`| ${escapeMarkdownCell(family.family)} | ${family.runs} | ${family.active} | ${family.superseded} `
        + `| ${family.void} | ${family.unclassified} | ${latestCell} | ${currentCell} |`);
    }
  }
  const { defects } = projection;
  const defectParts: string[] = [];
  if (defects.conflicting_stamps.length > 0) {
    defectParts.push(`${defects.conflicting_stamps.length} conflicting stamp(s): ${listWithCap(defects.conflicting_stamps)}`);
  }
  if (defects.attempt_chain_defects.length > 0) {
    defectParts.push(`${defects.attempt_chain_defects.length} attempt-chain defect(s): ${listWithCap(defects.attempt_chain_defects)}`);
  }
  if (defects.no_authoritative_identity.length > 0) {
    defectParts.push(`${defects.no_authoritative_identity.length} run(s) without authoritative identity: ${listWithCap(defects.no_authoritative_identity)}`);
  }
  if (defects.ledger_only.length > 0) {
    defectParts.push(`${defects.ledger_only.length} ledger-only run id(s) with no directory: ${listWithCap(defects.ledger_only)}`);
  }
  if (defects.registry_only_current.length > 0) {
    defectParts.push(`${defects.registry_only_current.length} CURRENT result(s) naming a run with no directory: ${listWithCap(defects.registry_only_current)}`);
  }
  if (defectParts.length > 0) {
    lines.push('');
    lines.push(`Defects: ${defectParts.join('; ')} — repair before trusting; see \`nullius current\`.`);
  }
  if (!projection.registry_block_found && projection.run_directories > 0) {
    lines.push('');
    lines.push('(No results-registry block found in this file — current-result markers');
    lines.push('cannot render until the RESULT_REGISTRY section is restored.)');
  }
  lines.push(RUN_INDEX_END);
  return lines.join('\n');
}

export type RunIndexBlockStatus = {
  project_index_found: boolean;
  block_found: boolean;
  duplicated_markers: boolean;
  in_sync: boolean | null;
  reason: string | null;
};

export function checkRunIndexBlock(
  projectRoot: string,
  projection: RunIndexProjection,
): RunIndexBlockStatus {
  const generic: ManagedBlockStatus = checkManagedBlock(
    path.join(projectRoot, 'project_index.md'),
    renderRunIndexBlock(projection),
    RUN_INDEX_BLOCK_SPEC,
    DIGEST_LINE_PATTERN,
    runIndexDigest(projection),
  );
  return {
    project_index_found: generic.file_found,
    block_found: generic.block_found,
    duplicated_markers: generic.duplicated_markers,
    in_sync: generic.in_sync,
    reason: generic.reason,
  };
}

/** Insertion offset for a project_index.md with no block yet: immediately
 *  before the PROJECT_INDEX_AUTO block when present (the two machine
 *  regions sit together near the file's end), else end of file. The AUTO
 *  marker is matched as a whole line outside code the same way the
 *  engine's own scanner reads markers. */
function runIndexInsertOffset(text: string, _location: ManagedBlockLocation): number {
  const lines = text.split('\n');
  let inFence = false;
  let offset = 0;
  for (const line of lines) {
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^\s{0,3}(```|~~~)/.test(content)) {
      inFence = !inFence;
    } else if (!inFence && !/^(?: {4}|\t)/.test(content) && content.trim() === PROJECT_INDEX_AUTO_START) {
      return offset;
    }
    offset += line.length + 1;
  }
  return text.length;
}

export type RunIndexRefreshOutcome = {
  action: 'inserted' | 'rewritten' | 'unchanged' | 'skipped';
  reason: string | null;
  projection: RunIndexProjection;
};

export function refreshRunIndexBlock(
  projectRoot: string,
  options?: {
    insertIfMissing?: boolean;
    ledgerView?: ValidityLedgerView;
    projection?: RunIndexProjection;
  },
): RunIndexRefreshOutcome {
  // The index projection moves on EVERY write, so the stale-render race
  // is real here: EVERY attempt recomputes from a fresh ledger read
  // (never a caller-supplied projection or ledger view — those predate
  // the carrier read, which is exactly the window a rival's append hides
  // in). The engine renders after reading the carrier, so a rival is
  // either folded into this recompute or caught by the write guard.
  // The supplied projection/ledgerView therefore never reach a RENDER;
  // they only seed the returned projection on the one path that renders
  // nothing (carrier missing → skipped), so a normal refresh computes
  // exactly one projection.
  let latestProjection: RunIndexProjection | null = null;
  const outcome = refreshManagedBlock(
    path.join(projectRoot, 'project_index.md'),
    () => {
      latestProjection = computeRunIndexProjection(projectRoot);
      return renderRunIndexBlock(latestProjection);
    },
    RUN_INDEX_BLOCK_SPEC,
    {
      insertIfMissing: options?.insertIfMissing === true,
      missingBlockReason: 'no run-index block (run `nullius index sync` to adopt)',
      insertAt: runIndexInsertOffset,
    },
  );
  return {
    projection: latestProjection
      ?? options?.projection
      ?? computeRunIndexProjection(projectRoot, options?.ledgerView),
    action: outcome.action,
    reason: outcome.reason,
  };
}
