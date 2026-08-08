import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readTerminalResultWitness,
  defaultStampActor,
  findComputationWorkspaces,
  gradeExistingStamp,
  openRetryAttempt,
  stampRunDirectory,
} from '../run-stamp.js';
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

export function stampComputationLaunch(projectRoot: string, runDir: string, reentry = false): ExecutionOriginStamp {
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
        // A RELAUNCH of an already-stamped run is fail-closed END TO END:
        // any throw inside this case (the grading probe's `git stash
        // create` under a held index.lock, a recorded snapshot commit
        // missing after a re-clone, the ledger lock, a pin conflict) means
        // the machine cannot say what this launch would overwrite — and
        // executing without that answer is exactly the overwrite the fork
        // exists to prevent. The general never-blocks doctrine applies
        // only to the FIRST stamp of a run, where there is nothing
        // recorded to overwrite. The inner try's refusals return through
        // here untouched; only genuine exceptions convert.
        try {
          const graded = gradeExistingStamp(projectRoot, result.runId, result.recordedOrigin);
          if (graded.grade === 'same_tree') {
            return {
              status: 'already_stamped',
              binding_quality: graded.bindingQuality,
              detail: 'an origin stamp for this run already binds the same tracked code tree; not re-stamped',
            };
          }
          // The tree changed since the recorded binding. Consult the attempt
          // boundary BEFORE warning: a COMPLETED execution is content
          // territory (refuse — the one deliberate never-blocks exception);
          // a machine-evidenced crash auto-opens the next attempt with a
          // fresh capture at zero operator cost; anything the machine cannot
          // certify falls back to today's non-blocking stale warning, now
          // naming the retry fork.
          // The terminal result artifact is an INDEPENDENT completion
          // witness, consulted before the status fork: a status file that
          // was removed or edited must not route a completed run's changed-
          // tree relaunch past the refusal (the retry entrance checks this
          // witness too, but only the `failed` fork ever reaches it). An
          // UNREADABLE witness refuses just the same — a truncated
          // artifact must never read as "nothing completed here".
          const terminalWitness = readTerminalResultWitness(runDir);
          if (terminalWitness === 'completed') {
            return {
              status: 'refused_relaunch',
              detail: 'this run\'s terminal result artifact records a COMPLETED execution and the tree has changed '
                + 'since its stamp; running would overwrite a completed result\'s provenance (an absent or edited '
                + 'status file cannot relabel it). "Completed but wrong" is content territory: supersede or void it '
                + '(full ceremony) and use a fresh run id.',
            };
          }
          if (terminalWitness === 'unreadable') {
            return {
              status: 'refused_relaunch',
              detail: 'this run\'s terminal result artifact (artifacts/computation_result_v1.json) is unreadable '
                + 'and the tree has changed since its stamp — the boundary cannot certify the prior execution did '
                + 'not complete; repair or remove the artifact (recording why) before relaunching.',
            };
          }
          // The status file lives wherever the manifest put the workspace —
          // the same discovery the retry entrance uses, so this fork can
          // never disagree with the boundary about what the machine saw.
          // Any COMPLETED status wins conservatively; ambiguity (multiple
          // status files) is the retry entrance's refusal to make.
          const statuses: string[] = [];
          const discovery = { truncated: false };
          for (const workspace of findComputationWorkspaces(runDir, discovery)) {
            if (!workspace.statusPath) continue;
            try {
              const parsed = JSON.parse(fs.readFileSync(workspace.statusPath, 'utf-8')) as { status?: string };
              if (typeof parsed.status === 'string') statuses.push(parsed.status);
            } catch {
              // unreadable status decides nothing here
            }
          }
          if (discovery.truncated) {
            return {
              status: 'refused_relaunch',
              detail: 'this run\'s directory is too large to enumerate (workspace discovery truncated at its '
                + 'safety bound) — the relaunch boundary cannot certify what it would overwrite; archive or '
                + 'remove bulk subdirectories, or use a fresh run id.',
            };
          }
          const executionStatus = statuses.includes('completed')
            ? 'completed'
            : statuses.includes('failed') ? 'failed' : statuses[0] ?? null;
          if (executionStatus === 'completed') {
            return {
              status: 'refused_relaunch',
              detail: 'this run recorded a COMPLETED execution and the tree has changed since its stamp; '
                + 'running would overwrite a completed result\'s provenance. "Completed but wrong" is content '
                + 'territory: supersede or void it (full ceremony) and use a fresh run id.',
            };
          }
          if (executionStatus === 'failed') {
            // The boundary consult is FAIL-CLOSED on exception: a throw here
            // (lock contention, pin conflict, ledger I/O) means the machine
            // could not rule — and executing without a ruling would overwrite
            // exactly what the boundary protects. This narrows the general
            // never-blocks doctrine only where a recorded stamp already
            // binds a different tree over a failed execution.
            let retry: ReturnType<typeof openRetryAttempt>;
            try {
              retry = openRetryAttempt(projectRoot, runDir, {
                actor: defaultStampActor(),
                reason: 'front-door relaunch under a changed tree after a failed execution (auto-recorded)',
              });
            } catch (error) {
              return {
                status: 'refused_relaunch',
                detail: `the attempt boundary could not rule (${error instanceof Error ? error.message : String(error)}) `
                  + '— executing without a ruling would overwrite what the boundary protects; retry shortly or run '
                  + '`nullius trace retry` by hand.',
              };
            }
            if (retry.kind === 'retried' && retry.origin) {
              const origin = retry.origin as unknown as Record<string, unknown>;
              return {
                status: 'retried',
                event_id: retry.eventId,
                closed_ordinal: retry.closedOrdinal,
                opened_ordinal: retry.openedOrdinal ?? retry.closedOrdinal + 1,
                previous_outcome: retry.previousOutcome,
                binding_quality: String(origin.binding_quality ?? 'unknown'),
              };
            }
            // A LOST RACE is transient, not a boundary verdict: a concurrent
            // retry advanced the chain first, and the honest response is to
            // re-enter the whole decision once against the new state (the
            // winner may have bound exactly our tree, making this launch a
            // benign already-stamped re-entry). One bounded re-entry — a
            // second conflict in the same window is refused like any other
            // unresolved ambiguity.
            if (retry.kind === 'attempt_conflict' && !reentry) {
              return stampComputationLaunch(projectRoot, runDir, true);
            }
            // Machine boundary said no (registry-named, decided, chain
            // defect, cap exhausted …). Executing anyway would overwrite
            // exactly what the refusal protects — so the launch is REFUSED,
            // carrying the entrance's own sentence.
            const detail = retry.kind === 'rejected' ? retry.message
              : retry.kind === 'attempt_conflict' ? retry.message
                : 'retry entrance did not open a new attempt';
            return {
              status: 'refused_relaunch',
              detail: `${detail} — executing would overwrite what this refusal protects.`,
            };
          }
          if (executionStatus === 'running') {
            // The archetypal resultless-crash shape: a SIGKILL/OOM/reboot
            // leaves `running` on disk forever. Executing would let the
            // runner overwrite that status and bind new outputs to the OLD
            // attempt's origin — and the machine cannot auto-declare a stall
            // (the process may genuinely be alive). Refuse; the operator
            // declares the stall or waits for the live sibling.
            return {
              status: 'refused_relaunch',
              detail: 'this run\'s execution status still says RUNNING while the tree has changed since its stamp. '
                + 'If the process is dead, declare the stall with `nullius trace retry <run_dir> --reason "..."` '
                + '(recorded as a declaration) and relaunch; if it may still be alive, wait for it.',
            };
          }
          if (graded.grade === 'untracked_delta') {
            return {
              status: 'stale_stamp',
              detail: `the recorded stamp claims ${graded.bindingQuality}, but ${graded.signalUntracked} `
                + 'new untracked path(s) bearing on this run have appeared since (its own directory or outside '
                + 'the run roots); the recorded exactness no longer describes what this relaunch executes. '
                + 'Commit the new files or use a fresh run id.',
            };
          }
          return {
            status: 'stale_stamp',
            detail: 'this run already carries an origin stamp bound to a DIFFERENT tracked code tree; '
              + 'this launch will overwrite results the recorded stamp no longer describes. '
              + 'Use a fresh run id for the changed code (round-suffix convention) — or, if the prior '
              + 'execution crashed with no retained result, `nullius trace retry` chains the next attempt '
              + 'under this same id.',
          };
        } catch (error) {
          return {
            status: 'refused_relaunch',
            detail: `the relaunch boundary could not grade this already-stamped run `
              + `(${error instanceof Error ? error.message : String(error)}) — executing without knowing what `
              + 'this launch would overwrite is refused; repair the git/ledger state or use a fresh run id.',
          };
        }
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
    // The ledger read that DECIDES whether this run is already stamped can
    // itself throw (unreadable file, replaced by a directory) — before the
    // fail-closed case is ever entered. The run's own LOCAL witnesses of a
    // prior stamped execution — the mirror, a terminal result artifact,
    // an attempt archive — say this launch is a RELAUNCH that cannot be
    // graded, and executing blind would overwrite whatever the unreadable
    // ledger protects. (The mirror alone is not enough: a stamp recorded
    // with run_dir_unwritable has no mirror, but a completed execution
    // always leaves its terminal artifact.) No witness → first launch →
    // the never-blocks doctrine stands (a missing stamp is visible; a
    // killed run is lost science).
    // Witness reading follows the terminal witness's own rule: only
    // provable absence (ENOENT/ENOTDIR on the ENTRY) is absence — a
    // dangling symlink or an unreadable entry is evidence, not nothing.
    // The attempts/ directory counts only when NON-EMPTY (an empty
    // migrated skeleton proves no prior execution; an unreadable one
    // cannot prove emptiness and stays conservative).
    const entryPresent = (candidate: string): boolean => {
      try {
        fs.lstatSync(candidate);
        return true;
      } catch (lstatError) {
        const code = (lstatError as NodeJS.ErrnoException).code;
        return !(code === 'ENOENT' || code === 'ENOTDIR');
      }
    };
    const attemptsDir = path.join(runDir, 'attempts');
    const attemptsWitness = entryPresent(attemptsDir)
      && (() => {
        try {
          return fs.readdirSync(attemptsDir).length > 0;
        } catch {
          return true;
        }
      })();
    const priorExecutionWitness = entryPresent(path.join(runDir, 'run_origin.json'))
      || readTerminalResultWitness(runDir) !== 'absent'
      || attemptsWitness;
    if (priorExecutionWitness) {
      return {
        status: 'refused_relaunch',
        detail: `the launch boundary could not read the ledger while this run carries local evidence of a prior `
          + `stamped execution (${error instanceof Error ? error.message : String(error)}) — executing without `
          + 'grading the relaunch is refused; repair the ledger state first.',
      };
    }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
