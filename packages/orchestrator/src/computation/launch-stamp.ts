import { defaultStampActor, gradeExistingStamp, stampRunDirectory } from '../run-stamp.js';
import type { ExecutionOriginStampOutcome } from './types.js';

/** Automatic origin stamp at the computation front door.
 *
 *  The stamp happens at LAUNCH — after approval clears, before the first
 *  step runs — because that is the moment the tree state and the results
 *  are the same fact. Measured adoption showed the alternative: hundreds of
 *  runs whose origin had to be reconstructed heuristically because stamping
 *  relied on an agent remembering a second command. The front door is a
 *  mandatory machine moment, so the binding happens here by construction.
 *
 *  One path: everything goes through the shared writer
 *  (`stampRunDirectory`), whose containment preflight runs BEFORE any
 *  ledger read — a run directory outside the stampable roots is `skipped`
 *  and never consults (or pollutes) the ledger under a colliding basename.
 *  One-stamp-per-run is enforced atomically inside the ledger lock, so a
 *  concurrent double launch cannot manufacture a conflicting-stamps defect.
 *
 *  Outcome semantics (never blocks execution — a computation must not die
 *  for a bookkeeping failure; a missing stamp is an honest, visible state
 *  in the read model, while a killed run is lost science):
 *  - `stamped`: origin recorded on the ledger, exact-at-launch.
 *  - `already_stamped`: a recorded stamp already binds the SAME research
 *    tree (a same-tree relaunch); no duplicate ledger event exists or was
 *    written.
 *  - `stale_stamp`: a recorded stamp binds a DIFFERENT research tree: this
 *    relaunch is about to overwrite results that the recorded stamp no
 *    longer describes. Deliberately NOT auto-restamped — the snapshot ref
 *    is create-if-absent by contract (a run id never silently rebinds), and
 *    the honest fix is a fresh run id (the round-suffix convention).
 *  - `skipped`: the run directory failed the stamp preflight (outside the
 *    stampable run roots, a symlink, …); the reason names the rule.
 *  - `failed`: capture, comparison, or ledger append threw (git errors —
 *    including a recorded commit missing from this repository — ledger I/O,
 *    lock contention); the error is carried, the computation proceeds, and
 *    the run surfaces as unstamped in the read model until stamped by
 *    hand. */
export type ExecutionOriginStamp = ExecutionOriginStampOutcome;

export function stampComputationLaunch(projectRoot: string, runDir: string): ExecutionOriginStamp {
  try {
    const result = stampRunDirectory(projectRoot, runDir, { actor: defaultStampActor() });
    switch (result.kind) {
      case 'rejected':
        return { status: 'skipped', reason: result.message };
      case 'already_recorded':
        // Unreachable without an eventId option, but map it honestly.
        return {
          status: 'already_stamped',
          binding_quality: 'unknown',
          detail: 'stamp event already recorded on the ledger',
        };
      case 'run_already_stamped': {
        const graded = gradeExistingStamp(projectRoot, result.runId, result.recordedOrigin);
        if (graded.grade === 'same_tree') {
          return {
            status: 'already_stamped',
            binding_quality: graded.bindingQuality,
            detail: 'an origin stamp for this run already binds the same tracked code tree; not re-stamped',
          };
        }
        return {
          status: 'stale_stamp',
          detail: 'this run already carries an origin stamp bound to a DIFFERENT tracked code tree; '
            + 'this launch will overwrite results the recorded stamp no longer describes. '
            + 'Use a fresh run id for the changed code (round-suffix convention) so each result keeps an exact origin.',
        };
      }
      case 'stamped': {
        const origin = result.origin as unknown as Record<string, unknown>;
        return {
          status: 'stamped',
          event_id: result.eventId,
          binding_quality: String(origin.binding_quality ?? 'unknown'),
          baseline_commit: typeof origin.baseline_commit === 'string' ? origin.baseline_commit : null,
        };
      }
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
