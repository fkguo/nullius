import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOriginV1, ValidityEventV1 } from '@nullius/shared';
import { mintUlid, ULID_PATTERN, writeBytesAtomicDurable } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from './validity-ledger.js';
import { captureRunOrigin } from './run-origin.js';

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
  let appendOutcome;
  try {
    appendOutcome = appendValidityEvent(projectRoot, event);
  } catch (error) {
    // No orphan and no clobber: a mirror this invocation created is
    // removed; a pre-existing one is restored to its prior content.
    if (mirrorWritten) {
      try {
        if (previousMirror !== null) writeBytesAtomicDurable(mirrorPath, previousMirror);
        else fs.rmSync(mirrorPath, { force: true });
      } catch {
        // A failing restore must not mask the append error; the
        // divergence scan surfaces the leftover mirror on the next read.
      }
    }
    throw error;
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
