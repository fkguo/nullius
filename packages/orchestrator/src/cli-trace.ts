import { appendValidityEvent, buildValidityEvent } from './validity-ledger.js';
import { defaultStampActor, gradeExistingStamp, openRetryAttempt, stampRunDirectory } from './run-stamp.js';
import { buildTraceabilityView, renderTraceabilityProse } from './traceability-view.js';
import { backfillRunOrigins, confirmRoundChains, proposeRoundChains } from './trace-backfill.js';
import { refreshNotebookCurrentState } from './notebook-current-state.js';

/** `nullius trace <stamp|supersede|void|reinstate>` — the write surface of
 *  the validity ledger and origin stamps — and `nullius current`, the human
 *  rendering of the shared traceability read model.
 *
 *  Verbs are one-liners on purpose: the measured majority of runs are
 *  created by hand-mkdir from skill instructions, so the write path has to
 *  cost one command. The consumer loop that keeps these alive is the
 *  traceability block inside `nullius status --json` (the mandated reconnect
 *  command) — not agent memory of another convention.
 */

type CliIo = {
  cwd: string;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

export type TraceParsed = {
  action: 'stamp' | 'retry' | 'supersede' | 'void' | 'reinstate' | 'backfill' | 'propose-chains' | 'confirm-chains';
  target: string;
  by: string | null;
  reason: string | null;
  scope: string | null;
  actor: string | null;
  eventId: string | null;
  recordOnly: boolean;
  deps: Record<string, string>;
};

/** Best-effort current-state refresh after a ledger-writing verb: one call
 *  per COMMAND (not per event), silent unless the block actually changed,
 *  and a failure never fails the verb — the next status/current read names
 *  the block out-of-sync. */
function refreshCurrentStateAfterWrite(projectRoot: string, io: CliIo): void {
  try {
    const outcome = refreshNotebookCurrentState(projectRoot, { insertIfMissing: false });
    if (outcome.action === 'rewritten') {
      io.stdout('notebook current-state block refreshed.\n');
    }
  } catch (error) {
    io.stderr(`note: notebook current-state refresh failed (${error instanceof Error ? error.message : String(error)}); `
      + 'the next `nullius current` read will name the block out-of-sync.\n');
  }
}

export function runTraceCommand(projectRoot: string, parsed: TraceParsed, io: CliIo): number {
  const actor = parsed.actor ?? defaultStampActor();
  switch (parsed.action) {
    case 'backfill': {
      const result = backfillRunOrigins(projectRoot);
      for (const outcome of result.outcomes) {
        if (outcome.action === 'already_stamped') continue;
        io.stdout(`${outcome.action === 'stamped_aligned' ? 'aligned' : outcome.action === 'stamped_unbound' ? 'unbound' : 'mirror-unwritable'} ${outcome.run_id}: ${outcome.detail}\n`);
      }
      io.stdout(
        `backfill: ${result.aligned} aligned (heuristic — never exact), ${result.unbound} unbound, `
        + `${result.skipped} already stamped. Validity was NOT backfilled; run \`nullius trace propose-chains\` next.\n`,
      );
      refreshCurrentStateAfterWrite(projectRoot, io);
      return 0;
    }
    case 'propose-chains': {
      const { proposals, path: proposalPath } = proposeRoundChains(projectRoot);
      const pairs = proposals.reduce((sum, proposal) => sum + proposal.supersede.length, 0);
      io.stdout(
        `proposed ${pairs} round-chain supersession(s) across ${proposals.length} slug(s) → ${proposalPath}\n`
        + 'PROPOSAL ONLY: review the file (delete pairs you reject), then `nullius trace confirm-chains`.\n',
      );
      return 0;
    }
    case 'confirm-chains': {
      const { appended, already, skippedDecided } = confirmRoundChains(projectRoot, actor);
      io.stdout(
        `confirmed: ${appended} supersede event(s) appended, ${already} already recorded`
        + `${skippedDecided > 0 ? `, ${skippedDecided} skipped (decided since the proposal — not relitigated)` : ''}.\n`,
      );
      // The batch writer bypasses stampRunDirectory — without this hook a
      // confirmed chain touching a registered run would leave the block
      // silently behind (judge-verified miss).
      if (appended > 0) refreshCurrentStateAfterWrite(projectRoot, io);
      return 0;
    }
    case 'stamp': {
      // Full flow (containment, event-id idempotency, mirror rollback) lives
      // in stampRunDirectory, shared with the computation front door's
      // automatic launch stamp; this case only renders the outcome.
      const result = stampRunDirectory(projectRoot, parsed.target, {
        actor,
        eventId: parsed.eventId,
        deps: parsed.deps,
      });
      if (result.kind === 'rejected') {
        io.stderr(`${result.message}\n`);
        return 1;
      }
      if (result.kind === 'already_recorded') {
        io.stdout(`already stamped ${result.runId} (event ${result.eventId} recorded)\n`);
        return 0;
      }
      if (result.kind === 'run_already_stamped') {
        // One run id, one stamp. Same research tree → benign no-op (an
        // agent following "stamp at launch" after the front door already
        // stamped must not manufacture a conflicting-stamps defect);
        // different tree → refuse and name the honest fix.
        const graded = gradeExistingStamp(projectRoot, result.runId, result.recordedOrigin);
        if (graded.grade === 'same_tree') {
          io.stdout(
            `already stamped ${result.runId}: ${graded.bindingQuality} (existing stamp binds the same tracked code tree)\n`,
          );
          return 0;
        }
        if (graded.grade === 'untracked_delta') {
          io.stderr(
            `trace stamp: ${result.runId} carries a ${graded.bindingQuality} stamp, but ${graded.signalUntracked} `
            + 'new untracked path(s) bearing on this run have appeared since; the recorded exactness no longer '
            + 'describes the tree. Commit the new files, use a fresh run id for content follow-ups, or — after a '
            + 'resultless crash — `nullius trace retry` chains the next attempt under this id.\n',
          );
          return 1;
        }
        io.stderr(
          `trace stamp: ${result.runId} already carries an origin stamp bound to a DIFFERENT tracked code tree; `
          + 'a run id never silently rebinds. Use a fresh run id for content follow-ups (round-suffix convention), '
          + 'or — after a resultless crash — `nullius trace retry` chains the next attempt under this id.\n',
        );
        return 1;
      }
      const record = result.origin as unknown as { binding_quality?: string; baseline_commit?: string | null };
      io.stdout(
        `${result.appendOutcome === 'appended' ? 'stamped' : 'already stamped'} ${result.runId}: `
        + `${record.binding_quality}${record.baseline_commit ? ` @ ${record.baseline_commit.slice(0, 12)}` : ''}`
        + `${result.mirrorWritten ? '' : ' (run directory unwritable; ledger event is the record)'}\n`
        + `event ${result.eventId}\n`,
      );
      return 0;
    }
    case 'retry': {
      const result = openRetryAttempt(projectRoot, parsed.target, {
        actor,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        recordOnly: parsed.recordOnly,
        ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
        deps: parsed.deps,
      });
      if (result.kind === 'rejected') {
        io.stderr(`${result.message}\n`);
        return 1;
      }
      if (result.kind === 'already_recorded') {
        io.stdout(`already recorded retry of ${result.runId} (event ${result.eventId})\n`);
        return 0;
      }
      if (result.kind === 'attempt_conflict') {
        io.stderr(`${result.message}\n`);
        return 1;
      }
      const originRecord = result.origin as unknown as { binding_quality?: string; baseline_commit?: string | null } | null;
      io.stdout(
        `${result.openedOrdinal === null
          ? `recorded attempt ${result.closedOrdinal} of ${result.runId} as ${result.previousOutcome} (record-only; no new attempt opened)`
          : `retried ${result.runId}: attempt ${result.closedOrdinal} closed as ${result.previousOutcome} `
          + `(${result.evidence.method}), attempt ${result.openedOrdinal} opened`
          + `${originRecord?.binding_quality ? `: ${originRecord.binding_quality}` : ''}`
          + `${originRecord?.baseline_commit ? ` @ ${originRecord.baseline_commit.slice(0, 12)}` : ''}`}`
        + `${result.quarantinedTo ? `\nprior products archived under ${result.quarantinedTo}/ (never deleted)` : ''}`
        + `\nevent ${result.eventId}\n`,
      );
      // A retried run cannot be registry-named (the boundary refuses those),
      // so the notebook block cannot have moved — no refresh needed.
      return 0;
    }
    case 'supersede':
    case 'void':
    case 'reinstate': {
      if (!parsed.reason || parsed.reason.trim().length === 0) {
        io.stderr(`trace ${parsed.action}: --reason is required (why the result ${parsed.action === 'reinstate' ? 'counts again' : 'no longer counts'})\n`);
        return 1;
      }
      if (parsed.action === 'supersede' && (!parsed.by || parsed.by.trim().length === 0)) {
        io.stderr('trace supersede: --by <new_run_id> is required (the run whose result replaces the old one)\n');
        return 1;
      }
      const event = buildValidityEvent({
        event: parsed.action,
        run_id: parsed.target,
        actor,
        reason: parsed.reason,
        ...(parsed.action === 'supersede' ? { by_run_id: parsed.by } : {}),
        ...(parsed.scope ? { scope: parsed.scope } : {}),
        ...(parsed.eventId ? { event_id: parsed.eventId } : {}),
      });
      const outcome = appendValidityEvent(projectRoot, event);
      io.stdout(
        `${outcome === 'appended' ? 'recorded' : 'already recorded'} ${parsed.action} for ${parsed.target}`
        + `${parsed.action === 'supersede' ? ` → ${parsed.by}` : ''}`
        + `${parsed.scope && parsed.scope !== 'full' ? ` [scope: ${parsed.scope}]` : ''}\n`
        + `event ${event.event_id}\n`,
      );
      if (outcome === 'appended') refreshCurrentStateAfterWrite(projectRoot, io);
      return 0;
    }
  }
}

export function runCurrentCommand(projectRoot: string, json: boolean, io: CliIo): number {
  // Same containment as the status embedding: a traceability read failure
  // degrades to an explicit error, never a partial false picture.
  let view;
  try {
    view = buildTraceabilityView(projectRoot);
  } catch (error) {
    io.stderr(`current: traceability view unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (json) {
    io.stdout(`${JSON.stringify(view, null, 2)}\n`);
  } else {
    io.stdout(renderTraceabilityProse(view));
  }
  return 0;
}
