import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readValidityLedger, validityLedgerPath, type ValidityLedgerView, type RunValidity } from './validity-ledger.js';
import { isTraceabilityArtifactPath, listSubmodulePaths } from './run-origin.js';
import { validateResultRegistry } from './result-registry.js';
import { checkNotebookStaleness, type NotebookStalenessReport } from './notebook-staleness.js';
import { canonicalJson } from './validity-ledger.js';

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
  results: {
    block_found: boolean;
    current: Array<{
      result_id: string;
      run_id: string;
      effective_commit: string | null;
      /** True when the identity is a dirty-tree snapshot commit — rendered
       *  with the +snapshot qualifier so it is never mistaken for plain
       *  HEAD (design D4/D5 snapshot qualification). */
      has_snapshot: boolean;
      artifact: string | null;
      /** True when validation raised issues touching this row — renderers
       *  must mark it, never present it as a clean current result. */
      defective: boolean;
    }>;
    rows: number;
    issues: Array<{ code: string; message: string }>;
  };
  notebook: {
    found: boolean;
    counts: NotebookStalenessReport['counts'];
    stale: Array<{ heading: string; cause: string }>;
    incomparable: Array<{ heading: string; cause: string }>;
  };
  warnings: {
    /** Slugs whose run count crossed the bounded-rounds threshold. An
     *  OBSERVATION in a different dimension than the team-cycle tag-round
     *  enforcement, which stays authoritative where it applies. */
    round_cap: Array<{ slug: string; runs: number; threshold: number }>;
    /** Runs whose run-directory mirror diverges from the authoritative
     *  ledger stamp (the narrow unlocked-preflight window, or a hand edit).
     *  The ledger is the truth; a divergent mirror misleads humans browsing
     *  the run directory. */
    mirror_divergence: string[];
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
    if (known.no_authoritative_identity && !noIdentity.includes(known.run_id)) {
      // A quarantined run stays visible even when its directory is gone —
      // the defect list must cover every run the ledger knows.
      noIdentity.push(known.run_id);
    }
    if (!known.stamped) continue;
    const originRecord = known.origin as unknown as Record<string, unknown> | null;
    const quality = originRecord && typeof originRecord.binding_quality === 'string'
      ? originRecord.binding_quality
      : 'unknown';
    bindingQualityCounts[quality] = (bindingQualityCounts[quality] ?? 0) + 1;
    if (known.conflicting_stamps) conflictingStamps.push(known.run_id);
  }
  conflictingStamps.sort();
  noIdentity.sort();

  const manuscript = readManuscriptPointer(projectRoot);
  // Reuse the ledger view built above — validate would otherwise reparse
  // the whole ledger a second time on every status read.
  const resultRegistry = validateResultRegistry(projectRoot, ledger);
  const notebook = checkNotebookStaleness(projectRoot, ledger);

  // D9 round-cap observation: same-slug run counts across BOTH roots against
  // the configured team-cycle threshold (default 5). Slug = run id minus
  // timestamp/milestone/ordinal prefixes and the trailing round suffix.
  let roundThreshold = 5;
  try {
    const teamConfigPath = path.join(projectRoot, 'research_team_config.json');
    if (fs.existsSync(teamConfigPath)) {
      const parsed = JSON.parse(fs.readFileSync(teamConfigPath, 'utf-8')) as {
        bounded_rounds?: { max_per_tag_family?: number };
      };
      const raw = parsed.bounded_rounds?.max_per_tag_family;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) roundThreshold = raw;
    }
  } catch {
    // unreadable config keeps the default
  }
  const slugCounts = new Map<string, number>();
  const SLUG_FROM_ID = /^(?:\d{8}(?:T\d{6}Z)?)[-_.](?:m\d+-)?(?:r\d+-)?(.+?)(?:-r\d+)?$/;
  for (const entry of directories) {
    const slug = SLUG_FROM_ID.exec(entry.run_id)?.[1] ?? entry.run_id;
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }
  const roundCap = [...slugCounts.entries()]
    .filter(([, count]) => count > roundThreshold)
    .map(([slug, runs]) => ({ slug, runs, threshold: roundThreshold }))
    .sort((a, b) => b.runs - a.runs);

  // Mirror-vs-ledger divergence (stage-1 acceptance hook): the ledger is the
  // authority; a run-directory mirror that no longer matches it — the narrow
  // unlocked-preflight window, or a hand edit — is surfaced, never trusted.
  const mirrorDivergence: string[] = [];
  for (const entry of directories) {
    const known = ledger.runs.get(entry.run_id);
    if (!known?.stamped || !known.origin) continue;
    const mirrorPath = path.join(projectRoot, entry.canonical_root, entry.run_id, 'run_origin.json');
    if (!fs.existsSync(mirrorPath)) {
      // A mirror the stamp reported WRITTEN that has since disappeared is
      // divergence too — silence here would hide a deletion. Only a ledger
      // payload that recorded run_dir_unwritable legitimately has no mirror.
      const ledgerPayload = known.origin as unknown as Record<string, unknown>;
      if (ledgerPayload.run_dir_unwritable !== true) {
        mirrorDivergence.push(entry.run_id);
      }
      continue;
    }
    try {
      const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf-8')) as Record<string, unknown>;
      // The ledger payload may carry run_dir_unwritable appended at stamp
      // time; compare modulo that writer-side annotation.
      const ledgerPayload = { ...(known.origin as unknown as Record<string, unknown>) };
      delete ledgerPayload.run_dir_unwritable;
      const mirrorPayload = { ...mirror };
      delete mirrorPayload.run_dir_unwritable;
      if (canonicalJson(mirrorPayload) !== canonicalJson(ledgerPayload)) {
        mirrorDivergence.push(entry.run_id);
      }
    } catch {
      mirrorDivergence.push(entry.run_id);
    }
  }
  mirrorDivergence.sort();

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
  if (!resultRegistry.block_found) {
    unanswerable.push({
      clause: 'current best result',
      reason: 'project_index.md has no RESULT_REGISTRY block — new scaffolds carry it; existing '
        + 'projects paste the Current results section once, then register rows with `nullius result set-current`',
    });
  } else if (resultRegistry.current.length === 0) {
    unanswerable.push({
      clause: 'current best result',
      reason: resultRegistry.rows.length === 0
        ? 'the current-results registry is empty — no result has been registered yet '
          + '(`nullius result set-current` at milestone convergence)'
        : `${resultRegistry.rows.length} result row(s) are registered but none is a valid current head `
          + '(registry defects present — see the defect list; repair before trusting any of them)',
    });
  }
  if (!notebook.notebook_found) {
    unanswerable.push({
      clause: 'notebook sections current vs stale',
      reason: 'research_notebook.md not found',
    });
  } else if (notebook.sections.length === 0) {
    unanswerable.push({
      clause: 'notebook sections current vs stale',
      reason: 'the notebook has no ## sections to classify',
    });
  } else if (notebook.counts.unstamped === notebook.sections.length) {
    unanswerable.push({
      clause: 'notebook sections current vs stale',
      reason: `none of the ${notebook.sections.length} sections carries a written-against stamp yet `
        + '(add `<!-- written-against: <commit-sha> -->` when rewriting a section)',
    });
  }

  let mergeUnionDeclared = false;
  try {
    const attributesPath = path.join(path.dirname(validityLedgerPath(projectRoot)), '.gitattributes');
    // Exact token match: "merge=unionish" or a glob pattern that merely
    // CONTAINS the token must not report the union driver as declared.
    mergeUnionDeclared = fs.existsSync(attributesPath)
      && fs.readFileSync(attributesPath, 'utf-8')
        .split('\n')
        .some((line) => {
          const fields = line.trim().split(/\s+/);
          return fields[0] === 'validity_ledger.jsonl' && fields.includes('merge=union');
        });
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
    notebook: {
      found: notebook.notebook_found,
      counts: notebook.counts,
      stale: notebook.sections.filter(section => section.class === 'stale')
        .map(section => ({ heading: section.heading, cause: section.cause })),
      incomparable: notebook.sections.filter(section => section.class === 'incomparable')
        .map(section => ({ heading: section.heading, cause: section.cause })),
    },
    warnings: {
      round_cap: roundCap,
      mirror_divergence: mirrorDivergence,
    },
    results: {
      block_found: resultRegistry.block_found,
      current: resultRegistry.current.map(row => ({
        result_id: row.result_id,
        run_id: row.run_id,
        effective_commit: row.effective_commit,
        has_snapshot: row.has_snapshot,
        artifact: row.artifact_target,
        defective: resultRegistry.defective_result_ids.has(row.result_id),
      })),
      rows: resultRegistry.rows.length,
      issues: resultRegistry.issues.map(entry => ({ code: entry.code, message: entry.message })),
    },
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
  if (resultClause) {
    lines.push(`Unanswerable: ${resultClause.reason}.`);
  } else {
    for (const row of view.results.current) {
      // A defective row is never presented as a clean current result — the
      // defect marker rides on the same line the reader would trust.
      lines.push(
        `- ${row.result_id}: run ${row.run_id}`
        + `${row.effective_commit ? ` @ ${row.effective_commit}${row.has_snapshot ? '+snapshot' : ''}` : ''}`
        + `${row.artifact ? ` → ${row.artifact}` : ''}`
        + `${row.defective ? ' — DEFECTIVE (see registry defects below; do not trust until repaired)' : ''}`,
      );
    }
  }
  if (view.results.issues.length > 0) {
    lines.push(`- REGISTRY DEFECTS: ${view.results.issues.length} issue(s) — ${view.results.issues.slice(0, 5).map(entry => entry.code).join(', ')}${view.results.issues.length > 5 ? ', …' : ''}`);
  }
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
  if (view.manuscript.current_report_id && view.manuscript.current_report_link) {
    lines.push(`${view.manuscript.current_report_id} → ${view.manuscript.current_report_link} (structural validation via \`nullius report-validate\`).`);
  } else {
    // Any degraded pointer state (missing block, unparseable lines, none
    // promoted, or a name without a link) renders through its unanswerable
    // reason — the prose never presents a half-pointer as the current one.
    const clause = view.unanswerable.find(entry => entry.clause === 'current manuscript');
    lines.push(`Unanswerable: ${clause?.reason ?? 'no manuscript pointer found'}.`);
  }
  lines.push('');

  lines.push('## Notebook sections');
  const notebookClause = view.unanswerable.find(entry => entry.clause === 'notebook sections current vs stale');
  if (notebookClause) {
    lines.push(`Unanswerable: ${notebookClause.reason}.`);
  } else {
    const counts = view.notebook.counts;
    lines.push(
      `${counts.current} current, ${counts['current-modulo-untracked']} current-modulo-untracked, `
      + `${counts.stale} stale, ${counts.unstamped} unstamped, ${counts.incomparable} incomparable.`,
    );
    for (const section of view.notebook.stale.slice(0, 10)) {
      lines.push(`- STALE: ${section.heading} (${section.cause})`);
    }
    for (const section of view.notebook.incomparable.slice(0, 5)) {
      lines.push(`- incomparable: ${section.heading} (${section.cause})`);
    }
  }
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
  for (const cap of view.warnings.round_cap.slice(0, 5)) {
    lines.push(
      `- ROUND CAP: ${cap.runs} runs share the object "${cap.slug}" (threshold ${cap.threshold}) — `
      + 'an observation in the slug dimension; the team-cycle tag-round gate stays authoritative where it applies.',
    );
  }
  if (view.warnings.mirror_divergence.length > 0) {
    lines.push(
      `- MIRROR DIVERGENCE: ${view.warnings.mirror_divergence.length} run director(y/ies) hold a run_origin.json `
      + `that no longer matches the authoritative ledger stamp: ${view.warnings.mirror_divergence.slice(0, 5).join(', ')}`
      + `${view.warnings.mirror_divergence.length > 5 ? ', …' : ''} — trust the ledger.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
