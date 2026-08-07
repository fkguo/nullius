import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOriginV1, ValidityEventV1 } from '@nullius/shared';
import { mintUlid, ULID_PATTERN, writeBytesAtomicDurable } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from './validity-ledger.js';
import { captureRunOrigin, isTraceabilityArtifactPath } from './run-origin.js';

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

export type ExistingStampGrade =
  | { grade: 'same_tree'; bindingQuality: string }
  | { grade: 'different_tree' };

/** Grade an already-recorded stamp against the CURRENT tree: same research
 *  code (a benign re-entry — nothing new to record) or a different tree
 *  (the recorded stamp no longer describes what would run — the honest
 *  response is a fresh run id, never a silent rebind). The probe is
 *  read-only (pin:false). */
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
  if (same) {
    const quality = (recordedOrigin as unknown as Record<string, unknown> | null)?.binding_quality;
    return { grade: 'same_tree', bindingQuality: typeof quality === 'string' ? quality : 'unknown' };
  }
  return { grade: 'different_tree' };
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
  const resolvedRunDir = fs.realpathSync(runDir);
  const inRunRoot = ['artifacts/runs', 'team/runs'].some((relRoot) => {
    const root = path.resolve(projectRoot, relRoot);
    if (!fs.existsSync(root)) return false;
    return path.dirname(resolvedRunDir) === fs.realpathSync(root);
  });
  if (!inRunRoot) {
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
  const rollbackMirror = () => {
    if (!mirrorWritten) return;
    try {
      if (previousMirror !== null) writeBytesAtomicDurable(mirrorPath, previousMirror);
      else fs.rmSync(mirrorPath, { force: true });
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
  return {
    kind: 'stamped',
    runId,
    eventId: event.event_id,
    origin: payload as unknown as RunOriginV1,
    mirrorWritten,
    appendOutcome,
  };
}
