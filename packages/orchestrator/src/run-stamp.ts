import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOriginV1, ValidityEventV1 } from '@nullius/shared';
import { mintUlid, ULID_PATTERN, writeBytesAtomicDurable } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from './validity-ledger.js';
import { captureRunOrigin, isTraceabilityArtifactPath } from './run-origin.js';
import { refreshNotebookCurrentState } from './notebook-current-state.js';

/** The actor recorded on ledger events when the caller has no better name:
 *  the OS user, matching what the hand-invoked CLI has always written. */
export function defaultStampActor(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The full origin-stamp write flow, shared by every stamp entrance: the
 *  `nullius trace stamp` CLI verb and the computation front door's automatic
 *  launch stamp. One implementation so the containment rules (run-root
 *  membership, canonical-root preference, symlink refusal), the event-id
 *  idempotency contract, and the mirror-rollback discipline cannot drift
 *  between the hand-invoked and machine-invoked paths.
 *
 *  Results are structured, not printed: callers own their rendering. A
 *  `rejected` outcome carries the exact operator-facing sentence the CLI
 *  historically printed, so the CLI wrapper stays byte-identical. */

export type StampRunOptions = {
  actor: string;
  /** Crash-recovery retry of the SAME logical stamp: when set, the ledger is
   *  the retry entrance (was this event recorded?), never a payload compare. */
  eventId?: string | null;
  /** Dependency repositories to record, keyed by a caller-chosen name. */
  deps?: Record<string, string>;
};

export type StampRunResult =
  /** Preflight refused; `message` is the operator-facing reason. */
  | { kind: 'rejected'; message: string }
  /** --event-id preflight found the event already recorded for this run. */
  | { kind: 'already_recorded'; runId: string; eventId: string }
  /** A stamp for this run (under a DIFFERENT event id) is already on the
   *  ledger — one run id carries one stamp, so nothing was appended.
   *  `recordedOrigin` is the authoritative stamp payload (null only when
   *  the ledger line lacks one), for the caller to grade the current tree
   *  against (same tree → benign no-op; different tree → stale). */
  | { kind: 'run_already_stamped'; runId: string; recordedOrigin: RunOriginV1 | null }
  /** Capture ran and the ledger append completed (or found the identical
   *  line already present under the lock). */
  | {
    kind: 'stamped';
    runId: string;
    eventId: string;
    origin: RunOriginV1;
    mirrorWritten: boolean;
    appendOutcome: 'appended' | 'already_present';
  };

/** Resolve a stamp target the way the CLI always has: absolute paths stand,
 *  relative paths resolve against the PROJECT ROOT (not the shell cwd). */
export function resolveStampTarget(projectRoot: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
}

/** True when `runDir` sits DIRECTLY under one of the two stampable run
 *  roots. Symlink-resolved on BOTH sides — every root-membership decision
 *  (the stamp containment below AND the front door's identity check) must
 *  share this one predicate: two callers answering "inside a run root?"
 *  with different resolution semantics is how a symlinked project root
 *  makes one of them stamp what the other refused to bind. A path that
 *  cannot be resolved is not inside any root. */
export function isInsideStampableRoot(projectRoot: string, runDir: string): boolean {
  let resolvedRunDir: string;
  try {
    resolvedRunDir = fs.realpathSync(runDir);
  } catch {
    return false;
  }
  return ['artifacts/runs', 'team/runs'].some((relRoot) => {
    const root = path.resolve(projectRoot, relRoot);
    if (!fs.existsSync(root)) return false;
    try {
      return path.dirname(resolvedRunDir) === fs.realpathSync(root);
    } catch {
      return false;
    }
  });
}

/** The commit whose TREE is the code a stamp describes: snapshot when
 *  tracked files were dirty, else the baseline. Null for aligned/unbound
 *  stamps (no exact identity to compare against). */
export function stampedCodeCommit(origin: unknown): string | null {
  const record = origin as Record<string, unknown> | null;
  if (!record) return null;
  if (record.binding_quality === 'aligned_heuristic' || record.binding_quality === 'unbound') return null;
  const snapshot = typeof record.snapshot_commit === 'string' ? record.snapshot_commit : null;
  const baseline = typeof record.baseline_commit === 'string' ? record.baseline_commit : null;
  return snapshot ?? baseline;
}

/** Control-plane bookkeeping the execution machinery itself rewrites on
 *  every launch (run state, the decision ledger, approval receipts under
 *  .nullius/). Counting those as research-code drift would make EVERY
 *  relaunch read as "different code" — the same self-referential noise the
 *  untracked-side exclusion (isTraceabilityArtifactPath) already handles. */
function isControlPlanePath(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  return normalized === '.nullius' || normalized.startsWith('.nullius/');
}

/** True when two stamped code identities differ ONLY in control-plane
 *  bookkeeping — i.e. the RESEARCH code is the same tree. Throws when git
 *  cannot compare the objects (e.g. a recorded commit missing from this
 *  repository); callers map that to an explicit failure, never to "same". */
export function sameResearchCode(projectRoot: string, commitA: string, commitB: string): boolean {
  if (commitA === commitB) return true;
  const diff = execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, 'diff', '--name-only', commitA, commitB],
    { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return diff
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .every(line => isControlPlanePath(line) || isTraceabilityArtifactPath(line));
}

/** What a stamp rollback may do to the mirror file: undo only what THIS
 *  invocation wrote. Between our mirror write and the rollback a concurrent
 *  stamper may have won the ledger race and written ITS mirror — removing
 *  or overwriting the winner's file would orphan a successful stamp that
 *  just reported its mirror written. So: bytes on disk are ours → restore
 *  whatever preceded us (previous content, or remove what we created);
 *  bytes are anyone else's (or the file is gone) → leave it alone. */
export function mirrorRollbackAction(
  currentBytes: string | null,
  ourBytes: string,
  previousBytes: string | null,
): 'restore_previous' | 'remove' | 'leave' {
  if (currentBytes !== ourBytes) return 'leave';
  return previousBytes !== null ? 'restore_previous' : 'remove';
}

export type ExistingStampGrade =
  | { grade: 'same_tree'; bindingQuality: string }
  | { grade: 'untracked_delta'; bindingQuality: string; signalUntracked: number }
  | { grade: 'different_tree' };

/** Grade an already-recorded stamp against the CURRENT tree.
 *
 *  - same_tree: the tracked research code is the same AND no new
 *    code-bearing untracked paths appeared — a benign re-entry.
 *  - untracked_delta: the tracked tree is unchanged, but the recorded
 *    stamp claims an EXACT grade while the probe now sees SIGNAL
 *    untracked paths (the run's own directory, or outside the run roots).
 *    The recorded exactness no longer describes what a relaunch would
 *    execute; commit the new files or use a fresh run id. The signal
 *    scope is deliberate: FOREIGN runs' accumulation (which the honesty
 *    grade conservatively keeps counting) must not trip this, or every
 *    re-entry in a busy project would false-alarm — quality asks "how
 *    certain is this stamp" (full set), re-entry asks "did code RELEVANT
 *    TO THIS RUN change" (signal set).
 *  - different_tree: the tracked code itself changed — the honest
 *    response is a fresh run id, never a silent rebind.
 *
 *  The probe is read-only apart from a git stat-cache refresh
 *  (pin:false — no ref is created). */
export function gradeExistingStamp(
  projectRoot: string,
  runId: string,
  recordedOrigin: RunOriginV1 | null,
): ExistingStampGrade {
  const probe = captureRunOrigin(projectRoot, runId, { pin: false });
  const knownCommit = stampedCodeCommit(recordedOrigin);
  const probeCommit = stampedCodeCommit(probe);
  const same = knownCommit === null || probeCommit === null
    ? knownCommit === probeCommit
    : sameResearchCode(projectRoot, knownCommit, probeCommit);
  if (!same) return { grade: 'different_tree' };
  const recordedRecord = recordedOrigin as unknown as Record<string, unknown> | null;
  const recordedQuality = typeof recordedRecord?.binding_quality === 'string'
    ? recordedRecord.binding_quality
    : 'unknown';
  if (recordedQuality === 'exact_clean' || recordedQuality === 'exact_tracked_snapshot') {
    const signalUntracked = countCodeBearingUntracked(projectRoot, runId);
    if (signalUntracked > 0) {
      return { grade: 'untracked_delta', bindingQuality: recordedQuality, signalUntracked };
    }
  }
  return { grade: 'same_tree', bindingQuality: recordedQuality };
}

/** The run's declared OUTPUT paths, workspace-relative, read from its own
 *  manifest. A manifest may declare outputs anywhere inside the workspace
 *  (including under scripts/), so metabolism-vs-code cannot be decided by
 *  location alone — the declaration decides. Unreadable or malformed
 *  manifest → empty set (conservative: nothing gets excluded on its say-so). */
function declaredOutputPaths(projectRoot: string, ownRunPrefix: string): Set<string> {
  const declared = new Set<string>();
  try {
    const manifestPath = path.join(projectRoot, ownRunPrefix, 'computation', 'manifest.json');
    if (!fs.existsSync(manifestPath)) return declared;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      steps?: Array<{ expected_outputs?: string[] }>;
    };
    for (const step of parsed.steps ?? []) {
      for (const output of step.expected_outputs ?? []) {
        if (typeof output === 'string' && output.length > 0) {
          declared.add(path.posix.join(`${ownRunPrefix}/computation`, output.split('\\').join('/')));
        }
      }
    }
  } catch {
    // Conservative: an unreadable manifest excludes nothing.
  }
  return declared;
}

/** The runner's own write surface inside a run directory — files the
 *  execution machinery itself produces on every launch. Counting these as
 *  code deltas would flag every same-tree relaunch of a completed run. */
function isRunnerWriteSurface(insideOwnRun: string): boolean {
  return insideOwnRun === 'computation/execution_status.json'
    || insideOwnRun.startsWith('computation/logs/')
    || insideOwnRun.startsWith('computation/outputs/')
    || insideOwnRun.startsWith('computation/workspace/')
    || insideOwnRun.startsWith('artifacts/');
}

/** Untracked paths that bear on THIS run's code identity, for re-entry
 *  grading. Signal = everything untracked EXCEPT (a) control-plane and
 *  traceability bookkeeping, (b) OTHER runs' directories (their
 *  accumulation is not this run's code — the honesty GRADE still counts
 *  them conservatively; this narrower scope answers a different question:
 *  did code relevant to this run change), (c) stray files directly ON a
 *  run root (indistinguishable from machine-maintained files — stated
 *  limit), and (d) inside the run's OWN directory, the runner's write
 *  surface plus the manifest's DECLARED expected outputs. Everything else
 *  in the own directory — a helper module, an undeclared file, the
 *  manifest itself — is conservatively signal: manifests may reference
 *  scripts anywhere in the workspace, so no location whitelist can clear
 *  a file as non-code, and an undeclared output SHOULD have been declared
 *  (the manifest contract) — its one-line fix is to declare or commit it. */
function countCodeBearingUntracked(projectRoot: string, runId: string): number {
  const output = execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, 'ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ownRunPrefixes = ['artifacts/runs', 'team/runs'].map(root => `${root}/${runId}`);
  const declaredOutputs = new Set<string>(
    ownRunPrefixes.flatMap(prefix => [...declaredOutputPaths(projectRoot, prefix)]),
  );
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !isTraceabilityArtifactPath(line))
    .filter(line => !isControlPlanePath(line))
    .filter((line) => {
      const own = ownRunPrefixes.find(prefix => line.startsWith(`${prefix}/`));
      if (own) {
        const inside = line.slice(own.length + 1);
        if (isRunnerWriteSurface(inside)) return false;
        if (declaredOutputs.has(line)) return false;
        return true;
      }
      // Inside a run root but another run's directory, or a stray file
      // directly on the root: not this run's code signal.
      if (line.startsWith('artifacts/runs/') || line.startsWith('team/runs/')) return false;
      return true;
    })
    .length;
}

export function stampRunDirectory(
  projectRoot: string,
  target: string,
  options: StampRunOptions,
): StampRunResult {
  const runDir = resolveStampTarget(projectRoot, target);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    return { kind: 'rejected', message: `trace stamp: run directory not found: ${runDir}` };
  }
  // Only the two run roots are stampable: a stamp elsewhere would land
  // in the ledger but be invisible to every directory scan — a record
  // about a run the read model can never show is a silent hole. The
  // check is SYMLINK-RESOLVED on both sides, and a run directory that is
  // itself a symlink is refused outright: the directory scan skips
  // symlink entries, so stamping one would create the same invisible
  // record through a side door.
  if (fs.lstatSync(runDir).isSymbolicLink()) {
    return {
      kind: 'rejected',
      message: `trace stamp: ${target} is a symlink; run directories must be real directories under a run root`,
    };
  }
  if (!isInsideStampableRoot(projectRoot, runDir)) {
    return {
      kind: 'rejected',
      message: 'trace stamp: run directories live directly under artifacts/runs/ or team/runs/; '
        + `${target} is outside both roots and would be invisible to the read model`,
    };
  }
  const runId = path.basename(runDir);
  // Canonical-root rule (D9): when the same run id exists under BOTH run
  // roots, artifacts/runs is the canonical location and stamps are
  // written there — stamping the team/runs mirror would seed two
  // divergent origin records for one logical run.
  const canonicalDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  const mirrorDirOfCanonical = path.join(projectRoot, 'team', 'runs', runId);
  if (
    path.resolve(runDir) === path.resolve(mirrorDirOfCanonical)
    && fs.existsSync(canonicalDir)
  ) {
    return {
      kind: 'rejected',
      message: `trace stamp: ${runId} exists under artifacts/runs (canonical) and team/runs (review mirror); `
        + `stamp the canonical directory: artifacts/runs/${runId}`,
    };
  }
  // One logical stamp = one ULID for life: with --event-id the retry
  // entrance is the LEDGER (was this event already recorded?), not a
  // payload comparison — a re-capture would legitimately differ (time
  // moved, the tree may have moved) and must not read as divergence.
  // The short-circuit accepts ONLY a stamp event for THIS run: reusing
  // an id that belongs to any other event must fail loudly, never
  // report a stamp that was not taken. Validation happens BEFORE any
  // mirror write so a rejected id leaves no half-state behind.
  if (options.eventId) {
    if (!ULID_PATTERN.test(options.eventId)) {
      return {
        kind: 'rejected',
        message: `trace stamp: --event-id ${JSON.stringify(options.eventId)} is not a ULID`,
      };
    }
    const ledgerView = readValidityLedger(projectRoot);
    // Divergent ids are excluded from `events` by the reader's dedup —
    // check the defect list too, or a divergent id would sail past this
    // preflight into a mirror write before the append rejects it.
    if (ledgerView.integrity_defects.some(defect => defect.event_id === options.eventId)) {
      return {
        kind: 'rejected',
        message: `trace stamp: event ${options.eventId} is a ledger-integrity defect (divergent payloads); `
          + 'repair the ledger and mint a fresh event id',
      };
    }
    const existing = ledgerView.events.find(event => event.event_id === options.eventId);
    if (existing) {
      if (existing.event !== 'stamp' || existing.run_id !== runId) {
        return {
          kind: 'rejected',
          message: `trace stamp: event ${options.eventId} is already recorded as a ${existing.event} `
            + `for ${existing.run_id}; it cannot identify a stamp of ${runId}`,
        };
      }
      return { kind: 'already_recorded', runId: existing.run_id, eventId: options.eventId };
    }
  }
  // One run id, one stamp: a stamp already on the ledger (under another
  // event id) short-circuits before any capture or write. This unlocked
  // pre-read serves the common re-entry case; the race two concurrent
  // stampers would run past it is closed by the same predicate evaluated
  // INSIDE the append lock below.
  const preRead = readValidityLedger(projectRoot);
  const preKnown = preRead.runs.get(runId);
  if (preKnown?.stamped) {
    return { kind: 'run_already_stamped', runId, recordedOrigin: preKnown.origin };
  }
  const eventId = options.eventId ?? mintUlid();
  const origin = captureRunOrigin(projectRoot, runId, {
    deps: options.deps ?? {},
    eventId,
  });
  // Mirror attempted before the append so its outcome is recorded in the
  // authoritative event; AUTHORITY stays with the ledger regardless of
  // write order (all consumers read the ledger, D2).
  const mirrorPath = path.join(runDir, 'run_origin.json');
  const previousMirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
  let mirrorWritten = true;
  try {
    writeBytesAtomicDurable(mirrorPath, `${JSON.stringify(origin, null, 2)}\n`);
  } catch {
    mirrorWritten = false;
    // Commit-uncertain: the atomic helper renames before its final
    // durability step, so on failure the destination may already hold
    // the new bytes. Best-effort restore either way — harmless when the
    // rename never happened, and the only defense against clobbering a
    // pre-existing legacy mirror with no ledger event behind it.
    try {
      if (previousMirror !== null) writeBytesAtomicDurable(mirrorPath, previousMirror);
      else fs.rmSync(mirrorPath, { force: true });
    } catch {
      // Restore is best-effort; the divergence scan surfaces leftovers.
    }
  }
  const payload = {
    ...(origin as unknown as Record<string, unknown>),
    ...(mirrorWritten ? {} : { run_dir_unwritable: true }),
  };
  const event = buildValidityEvent({
    event: 'stamp',
    run_id: runId,
    actor: options.actor,
    reason: null,
    stamp: payload as ValidityEventV1['stamp'],
    event_id: eventId,
    ts_utc: (payload as { captured_at_utc: string }).captured_at_utc,
  });
  const writtenMirrorBytes = `${JSON.stringify(origin, null, 2)}\n`;
  const rollbackMirror = () => {
    if (!mirrorWritten) return;
    try {
      const current = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
      const action = mirrorRollbackAction(current, writtenMirrorBytes, previousMirror);
      if (action === 'restore_previous') writeBytesAtomicDurable(mirrorPath, previousMirror!);
      else if (action === 'remove') fs.rmSync(mirrorPath, { force: true });
      // (A writer sneaking in between the read above and the write here is
      // a residual window; its worst case is the same divergence the
      // mirror scan already surfaces.)
    } catch {
      // A failing restore must not mask the primary outcome; the
      // divergence scan surfaces the leftover mirror on the next read.
    }
  };
  let appendOutcome;
  try {
    appendOutcome = appendValidityEvent(projectRoot, event, { onlyIfRunUnstamped: true });
  } catch (error) {
    // No orphan and no clobber: a mirror this invocation created is
    // removed; a pre-existing one is restored to its prior content.
    rollbackMirror();
    throw error;
  }
  if (appendOutcome === 'skipped_run_already_stamped') {
    // A concurrent stamper won the race between our pre-read and the lock:
    // their stamp is the record, our capture and mirror are not. Roll the
    // mirror back and report theirs.
    rollbackMirror();
    const postRead = readValidityLedger(projectRoot);
    return {
      kind: 'run_already_stamped',
      runId,
      recordedOrigin: postRead.runs.get(runId)?.origin ?? null,
    };
  }
  // Best-effort notebook current-state refresh at the ONE writer shared by
  // the CLI stamp verb and the computation front door's launch stamp. The
  // block renders from the registry projection, so a plain stamp almost
  // never changes it (zero writes at fast cadence); it does change when a
  // stamp flips a REGISTERED run's sentinel status. Computing the full
  // projection re-hashes every registered artifact — unacceptable per stamp
  // at field cadence — so the hot path first checks cheaply whether this
  // run id appears in project_index.md at all: a stamp for an unregistered
  // run cannot alter the projection. (Unrelated pre-existing staleness is
  // the read side's job to name, not this hook's job to repair.) A refresh
  // failure must never fail the stamp — the ledger event is the record.
  if (appendOutcome === 'appended') {
    try {
      let registryMentionsRun = false;
      try {
        registryMentionsRun = fs
          .readFileSync(path.join(projectRoot, 'project_index.md'), 'utf-8')
          .includes(runId);
      } catch {
        // no index, nothing registered, nothing to refresh
      }
      if (registryMentionsRun) {
        refreshNotebookCurrentState(projectRoot, { insertIfMissing: false });
      }
    } catch {
      // surfaced on the next status/current read as out-of-sync
    }
  }
  return {
    kind: 'stamped',
    runId,
    eventId: event.event_id,
    origin: payload as unknown as RunOriginV1,
    mirrorWritten,
    appendOutcome,
  };
}
