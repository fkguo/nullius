import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readValidityLedger, validityLedgerPath, type ValidityLedgerView, type RunValidity } from './validity-ledger.js';
import { isTraceabilityArtifactPath, listSubmodulePaths } from './run-origin.js';

/** ONE read model behind both consumers of the acceptance sentence:
 *  `nullius status --json` embeds this object as its `traceability` block
 *  (so the existing reconnect path carries the warnings), and
 *  `nullius current` renders the SAME object as human prose. No second
 *  truth source exists — that is the lesson of the measured death of a
 *  hand-maintained current-pointer nobody read.
 *
 *  Honesty contract: clauses this view cannot answer for a project are
 *  reported as explicitly unanswerable EVERY time (no repository, legacy
 *  unclassified runs, heuristic bindings), never silently omitted and never
 *  over-claimed. The standing binding caveat rides along unconditionally.
 */

export const BINDING_CAVEAT =
  'exact refers to the snapshot object captured at stamp time; runs launched while the same '
  + 'worktree was being edited concurrently are outside this guarantee (one-worktree-per-lane norm)';

const RUN_ROOTS = [path.join('artifacts', 'runs'), path.join('team', 'runs')] as const;

export type RunDirEntry = {
  run_id: string;
  /** Canonical location: artifacts/runs when present there, else team/runs. */
  canonical_root: string;
  mirrored: boolean;
};

export type TraceabilityRunClass = 'active' | 'superseded' | 'void' | 'unclassified';

export type TraceabilityView = {
  git: {
    is_repo: boolean;
    head: string | null;
    head_describe: string | null;
    tracked_modified: number | null;
    untracked_count: number | null;
    submodules_dirty: number | null;
  };
  runs: {
    total_directories: number;
    mirrored_ids: number;
    counts: Record<TraceabilityRunClass, number>;
    stamped: number;
    /** Distribution of stamp binding qualities among stamped runs. The
     *  aligned_heuristic and unbound buckets are the honesty-critical ones:
     *  they must be visible, never folded into exact-sounding wording. */
    binding_quality_counts: Record<string, number>;
    conflicting_stamps: string[];
    /** Ledger events about run_ids with no directory on disk (renames,
     *  removals): reported, never silently dropped. */
    ledger_only_run_ids: string[];
    superseded: Array<{ run_id: string; by: string | null; reason: string | null }>;
    voided: Array<{ run_id: string; reason: string | null }>;
    no_authoritative_identity: string[];
  };
  ledger: {
    exists: boolean;
    events: number;
    malformed_lines: number;
    integrity_defects: number;
    /** True when artifacts/runs/.gitattributes declares the union merge for
     *  the ledger; false means a branch merge will conflict loudly instead
     *  of union-merging (safe direction, but worth surfacing). */
    merge_union_declared: boolean;
  };
  manuscript: {
    registry_block_found: boolean;
    pointer_parse_ok: boolean;
    current_report_id: string | null;
    current_report_link: string | null;
    /** Deep validation stays with the authoritative parser behind
     *  `nullius report-validate`; this reader never claims validated. */
    validation: 'deferred';
  };
  /** Clauses of the acceptance sentence this view cannot answer yet or
   *  cannot answer for this project, each with its reason. Honest
   *  unanswerability is the contract — an empty list means every clause has
   *  a live mechanism behind it. */
  unanswerable: Array<{ clause: string; reason: string }>;
  binding_caveat: string;
};

function git(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, ...args],
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
}

export function listRunDirectories(projectRoot: string): RunDirEntry[] {
  const seen = new Map<string, RunDirEntry>();
  for (const relRoot of RUN_ROOTS) {
    const absRoot = path.join(projectRoot, relRoot);
    if (!fs.existsSync(absRoot)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const existing = seen.get(entry.name);
      if (existing) {
        // Same run id in both roots: ONE logical run; artifacts/runs is the
        // canonical location (it is scanned first), team/runs the mirror.
        existing.mirrored = true;
        continue;
      }
      seen.set(entry.name, { run_id: entry.name, canonical_root: relRoot, mirrored: false });
    }
  }
  return [...seen.values()].sort((a, b) => a.run_id.localeCompare(b.run_id));
}

const REGISTRY_START = '<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->';
const REGISTRY_END = '<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->';

/** Pointer-lines-only reader of the existing manuscript registry block.
 *  Deliberately light: it extracts the current pointer for display and
 *  DEFERS all validation (SHA-256, chain integrity) to the authoritative
 *  project-contracts parser behind `nullius report-validate`. */
export function readManuscriptPointer(projectRoot: string): TraceabilityView['manuscript'] {
  const result: TraceabilityView['manuscript'] = {
    registry_block_found: false,
    pointer_parse_ok: false,
    current_report_id: null,
    current_report_link: null,
    validation: 'deferred',
  };
  const indexPath = path.join(projectRoot, 'project_index.md');
  if (!fs.existsSync(indexPath)) return result;
  let text: string;
  try {
    text = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return result;
  }
  const start = text.indexOf(REGISTRY_START);
  const end = text.indexOf(REGISTRY_END);
  if (start < 0 || end < 0 || end <= start) return result;
  result.registry_block_found = true;
  const block = text.slice(start, end);
  const idMatch = block.match(/^- Current report ID:\s*`?([^`\n]+?)`?\s*$/m);
  const reportMatch = block.match(/^- Current report:\s*(.+?)\s*$/m);
  if (!idMatch || !reportMatch) return result;
  result.pointer_parse_ok = true;
  const id = idMatch[1]!.trim();
  result.current_report_id = id === '(none yet)' ? null : id;
  const linkMatch = reportMatch[1]!.match(/\[[^\]]*\]\(([^)]+)\)/);
  result.current_report_link = linkMatch ? linkMatch[1]! : null;
  return result;
}

export function buildTraceabilityView(projectRoot: string): TraceabilityView {
  const insideWorkTree = git(projectRoot, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
  const head = insideWorkTree
    ? (git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim() || null)
    : null;
  const headDescribe = head
    ? (git(projectRoot, ['describe', '--always', '--tags'])?.trim() ?? null)
    : null;
  let trackedModified: number | null = null;
  let untrackedCount: number | null = null;
  let submodulesDirty: number | null = null;
  if (head) {
    const status = git(projectRoot, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=untracked', '--', '.']);
    trackedModified = status === null
      ? null
      : status.split('\n').filter(line => line.trim().length > 0).length;
    const untracked = git(projectRoot, ['ls-files', '--others', '--exclude-standard']);
    untrackedCount = untracked === null
      ? null
      : untracked.split('\n')
        .filter(line => line.trim().length > 0)
        .filter(line => !isTraceabilityArtifactPath(line)).length;
    // Same submodule honesty as the stamp: content dirty INSIDE a submodule
    // is invisible to the superproject probes above and must not read clean.
    submodulesDirty = 0;
    for (const submodulePath of listSubmodulePaths(projectRoot)) {
      const absolute = path.join(projectRoot, submodulePath);
      if (!fs.existsSync(path.join(absolute, '.git'))) continue;
      const inner = git(absolute, ['status', '--porcelain']);
      if (inner === null || inner.trim().length > 0) submodulesDirty += 1;
    }
  }

  const ledger: ValidityLedgerView = readValidityLedger(projectRoot);
  const directories = listRunDirectories(projectRoot);
  const directoryIds = new Set(directories.map(entry => entry.run_id));

  const counts: Record<TraceabilityRunClass, number> = {
    active: 0, superseded: 0, void: 0, unclassified: 0,
  };
  let stamped = 0;
  const bindingQualityCounts: Record<string, number> = {};
  const conflictingStamps: string[] = [];
  const superseded: TraceabilityView['runs']['superseded'] = [];
  const voided: TraceabilityView['runs']['voided'] = [];
  const noIdentity: string[] = [];
  for (const entry of directories) {
    const known: RunValidity | undefined = ledger.runs.get(entry.run_id);
    if (!known || (!known.stamped && known.scoped_annotations.length === 0
      && known.validity === 'active' && !known.no_authoritative_identity
      && ledger.events.every(e => e.run_id !== entry.run_id && e.by_run_id !== entry.run_id))) {
      // No stamp AND no ledger event: the legacy `unclassified` class —
      // reported as its own class, never silently counted valid.
      counts.unclassified += 1;
      continue;
    }
    counts[known.validity] += 1;
    if (known.stamped) stamped += 1;
    if (known.validity === 'superseded') {
      superseded.push({ run_id: entry.run_id, by: known.superseded_by, reason: known.reason });
    } else if (known.validity === 'void') {
      voided.push({ run_id: entry.run_id, reason: known.reason });
    }
    if (known.no_authoritative_identity) noIdentity.push(entry.run_id);
  }
  const ledgerOnly = [...ledger.runs.keys()].filter(runId => !directoryIds.has(runId)).sort();

  // Binding-quality distribution and stamp conflicts cover EVERY stamped run
  // the ledger knows — including ledger-only ids whose directory is gone. A
  // heuristic or unbound stamp does not stop deserving its caveat because
  // someone removed the directory.
  for (const known of ledger.runs.values()) {
    if (!known.stamped) continue;
    const originRecord = known.origin as unknown as Record<string, unknown> | null;
    const quality = originRecord && typeof originRecord.binding_quality === 'string'
      ? originRecord.binding_quality
      : 'unknown';
    bindingQualityCounts[quality] = (bindingQualityCounts[quality] ?? 0) + 1;
    if (known.conflicting_stamps) conflictingStamps.push(known.run_id);
  }
  conflictingStamps.sort();

  const manuscript = readManuscriptPointer(projectRoot);

  const unanswerable: TraceabilityView['unanswerable'] = [];
  if (!insideWorkTree) {
    unanswerable.push({
      clause: 'exact code revision',
      reason: 'project root is not a git repository — run `nullius init` to bootstrap one, or the clause stays unanswerable',
    });
  } else if (!head) {
    // A repository with an unborn HEAD has no commit to bind anything to —
    // exactly as unanswerable as no repository, and stated the same way.
    unanswerable.push({
      clause: 'exact code revision',
      reason: 'repository has no commit yet (unborn HEAD); commit once and the clause becomes answerable',
    });
  } else if (trackedModified === null || untrackedCount === null) {
    unanswerable.push({
      clause: 'exact code revision',
      reason: 'working-tree measurement failed (git status/ls-files errored); dirtiness is UNKNOWN, not clean',
    });
  }
  const aligned = bindingQualityCounts['aligned_heuristic'] ?? 0;
  const unbound = bindingQualityCounts['unbound'] ?? 0;
  if (aligned > 0 || unbound > 0) {
    unanswerable.push({
      clause: 'exact code revision (per-run)',
      reason: `${aligned} run stamp(s) are retroactive timestamp alignments (heuristic, never exact) and `
        + `${unbound} are unbound; only exact_clean / exact_tracked_snapshot stamps identify code exactly`,
    });
  }
  if (counts.unclassified > 0) {
    unanswerable.push({
      clause: 'runs still valid vs superseded',
      reason: `${counts.unclassified} legacy run directories carry no stamp and no ledger event (unclassified); `
        + 'they are not counted valid and not counted superseded until classified',
    });
  }
  if (!manuscript.registry_block_found) {
    unanswerable.push({
      clause: 'current manuscript',
      reason: 'project_index.md has no manuscript registry block',
    });
  } else if (!manuscript.pointer_parse_ok) {
    // A present block whose pointer lines do not parse is a FORMAT problem,
    // not a missing promotion — say which one it is.
    unanswerable.push({
      clause: 'current manuscript',
      reason: 'the manuscript registry block is present but its current-pointer lines did not parse; '
        + 'run `nullius report-validate` for the authoritative diagnosis',
    });
  } else if (manuscript.current_report_id === null) {
    unanswerable.push({
      clause: 'current manuscript',
      reason: 'no report is promoted yet (registry pointer is "(none yet)")',
    });
  } else if (manuscript.current_report_link === null) {
    unanswerable.push({
      clause: 'current manuscript',
      reason: `the registry names ${manuscript.current_report_id} as current but its pointer line carries `
        + 'no Markdown link; run `nullius report-validate` for the authoritative diagnosis',
    });
  }
  // Result registry (current best result) and notebook staleness land in
  // later delivery stages; until then the clauses are honestly open.
  unanswerable.push({
    clause: 'current best result',
    reason: 'the current-results registry is not implemented yet (delivery stage 2)',
  });
  unanswerable.push({
    clause: 'notebook sections current vs stale',
    reason: 'the written-against section checker is not implemented yet (delivery stage 3)',
  });

  let mergeUnionDeclared = false;
  try {
    const attributesPath = path.join(path.dirname(validityLedgerPath(projectRoot)), '.gitattributes');
    mergeUnionDeclared = fs.existsSync(attributesPath)
      && fs.readFileSync(attributesPath, 'utf-8')
        .split('\n')
        .some(line => line.trim().startsWith('validity_ledger.jsonl') && line.includes('merge=union'));
  } catch {
    mergeUnionDeclared = false;
  }

  return {
    git: {
      is_repo: insideWorkTree,
      head,
      head_describe: headDescribe,
      tracked_modified: trackedModified,
      untracked_count: untrackedCount,
      submodules_dirty: submodulesDirty,
    },
    runs: {
      total_directories: directories.length,
      mirrored_ids: directories.filter(entry => entry.mirrored).length,
      counts,
      stamped,
      binding_quality_counts: bindingQualityCounts,
      conflicting_stamps: conflictingStamps,
      ledger_only_run_ids: ledgerOnly,
      superseded,
      voided,
      no_authoritative_identity: noIdentity,
    },
    ledger: {
      exists: ledger.exists,
      events: ledger.events.length,
      malformed_lines: ledger.malformed_lines,
      integrity_defects: ledger.integrity_defects.length,
      merge_union_declared: mergeUnionDeclared,
    },
    manuscript,
    unanswerable,
    binding_caveat: BINDING_CAVEAT,
  };
}

/** Human prose rendering — the acceptance sentence, answered in order, with
 *  every unanswerable clause stated rather than skipped. */
export function renderTraceabilityProse(view: TraceabilityView): string {
  const lines: string[] = [];
  lines.push('# Current project state');
  lines.push('');

  // Ledger-integrity conditions come FIRST: while they stand, every
  // downstream classification is provisional, and burying that below the
  // sections it undermines would be its own dishonesty.
  if (view.ledger.integrity_defects > 0 || view.runs.conflicting_stamps.length > 0
    || view.ledger.malformed_lines > 0) {
    lines.push('## LEDGER INTEGRITY CONDITION');
    if (view.ledger.integrity_defects > 0) {
      lines.push(
        `${view.ledger.integrity_defects} event id(s) carry divergent payloads; affected runs are `
        + `quarantined at their worst candidate state and have no authoritative identity: `
        + `${view.runs.no_authoritative_identity.join(', ') || '(none currently on disk)'}.`,
      );
    }
    if (view.runs.conflicting_stamps.length > 0) {
      lines.push(
        `${view.runs.conflicting_stamps.length} run(s) carry CONFLICTING origin stamps (never resolved by guessing): `
        + `${view.runs.conflicting_stamps.join(', ')}.`,
      );
    }
    if (view.ledger.malformed_lines > 0) {
      lines.push(
        `${view.ledger.malformed_lines} ledger line(s) are malformed or contract-invalid; they are `
        + 'counted, never replayed — every classification below is provisional until they are repaired.',
      );
    }
    lines.push('');
  }

  lines.push('## Current best result');
  const resultClause = view.unanswerable.find(entry => entry.clause === 'current best result');
  lines.push(resultClause ? `Unanswerable: ${resultClause.reason}.` : '(rendered from the results registry)');
  lines.push('');

  lines.push('## Code revision');
  if (!view.git.is_repo) {
    lines.push('Unanswerable: this project is not a git repository, so no result can be bound to an exact code revision. `nullius init` bootstraps one.');
  } else if (!view.git.head) {
    lines.push('Unanswerable: the repository has no commit yet (unborn HEAD); commit once and this clause becomes answerable.');
  } else if (view.git.tracked_modified === null || view.git.untracked_count === null) {
    // A failed measurement must read as UNKNOWN, never as clean.
    lines.push(`HEAD is ${view.git.head_describe ?? view.git.head}; working-tree dirtiness could NOT be measured (git status/ls-files failed) — unknown, not clean.`);
  } else {
    const dirtyBits: string[] = [];
    if (view.git.tracked_modified) dirtyBits.push(`${view.git.tracked_modified} tracked file(s) modified`);
    if (view.git.untracked_count) dirtyBits.push(`${view.git.untracked_count} untracked file(s) pending a track-or-ignore decision`);
    if (view.git.submodules_dirty) dirtyBits.push(`${view.git.submodules_dirty} submodule(s) with dirty contents`);
    lines.push(`HEAD is ${view.git.head_describe ?? view.git.head}${dirtyBits.length > 0 ? ` (${dirtyBits.join('; ')})` : ' (clean tracked tree)'}.`);
    lines.push(`Note: ${view.binding_caveat}.`);
  }
  lines.push('');

  lines.push('## Current manuscript');
  if (view.manuscript.current_report_id) {
    lines.push(`${view.manuscript.current_report_id} → ${view.manuscript.current_report_link ?? '(link missing)'} (structural validation via \`nullius report-validate\`).`);
  } else {
    const clause = view.unanswerable.find(entry => entry.clause === 'current manuscript');
    lines.push(`Unanswerable: ${clause?.reason ?? 'no manuscript pointer found'}.`);
  }
  lines.push('');

  lines.push('## Notebook sections');
  const notebookClause = view.unanswerable.find(entry => entry.clause === 'notebook sections current vs stale');
  lines.push(notebookClause ? `Unanswerable: ${notebookClause.reason}.` : '(rendered from the section checker)');
  lines.push('');

  lines.push('## Runs');
  const { counts, total_directories, mirrored_ids, stamped } = view.runs;
  lines.push(
    `${total_directories} run directories (${mirrored_ids} mirrored across both roots): `
    + `${counts.active} active, ${counts.superseded} superseded, ${counts.void} void, `
    + `${counts.unclassified} unclassified legacy; ${stamped} carry origin stamps.`,
  );
  const qualityEntries = Object.entries(view.runs.binding_quality_counts);
  if (qualityEntries.length > 0) {
    lines.push(`- stamp binding qualities: ${qualityEntries.map(([q, n]) => `${n} ${q}`).join(', ')}`
      + `${(view.runs.binding_quality_counts['aligned_heuristic'] ?? 0) > 0 || (view.runs.binding_quality_counts['unbound'] ?? 0) > 0
        ? ' (aligned_heuristic and unbound never identify code exactly)'
        : ''}`);
  }
  for (const entry of view.runs.superseded.slice(0, 10)) {
    lines.push(`- superseded: ${entry.run_id}${entry.by ? ` → ${entry.by}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  for (const entry of view.runs.voided.slice(0, 10)) {
    lines.push(`- void: ${entry.run_id}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
  if (view.runs.no_authoritative_identity.length > 0) {
    lines.push(`- LEDGER INTEGRITY: ${view.runs.no_authoritative_identity.length} run(s) have divergent ledger events and no authoritative identity: ${view.runs.no_authoritative_identity.join(', ')}`);
  }
  if (view.runs.ledger_only_run_ids.length > 0) {
    lines.push(`- ${view.runs.ledger_only_run_ids.length} ledger-known run id(s) have no directory on disk: ${view.runs.ledger_only_run_ids.slice(0, 5).join(', ')}${view.runs.ledger_only_run_ids.length > 5 ? ', …' : ''}`);
  }
  if (view.ledger.malformed_lines > 0 || view.ledger.integrity_defects > 0) {
    lines.push(`- ledger health: ${view.ledger.malformed_lines} malformed line(s), ${view.ledger.integrity_defects} integrity defect(s).`);
  }
  lines.push('');
  return lines.join('\n');
}
