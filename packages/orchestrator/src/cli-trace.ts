import { appendValidityEvent, buildValidityEvent } from './validity-ledger.js';
import { defaultStampActor, stampRunDirectory } from './run-stamp.js';
import { buildTraceabilityView, renderTraceabilityProse } from './traceability-view.js';
import { backfillRunOrigins, confirmRoundChains, proposeRoundChains } from './trace-backfill.js';

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
  action: 'stamp' | 'supersede' | 'void' | 'reinstate' | 'backfill' | 'propose-chains' | 'confirm-chains';
  target: string;
  by: string | null;
  reason: string | null;
  scope: string | null;
  actor: string | null;
  eventId: string | null;
  deps: Record<string, string>;
};

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
      const record = result.origin as unknown as { binding_quality?: string; baseline_commit?: string | null };
      io.stdout(
        `${result.appendOutcome === 'appended' ? 'stamped' : 'already stamped'} ${result.runId}: `
        + `${record.binding_quality}${record.baseline_commit ? ` @ ${record.baseline_commit.slice(0, 12)}` : ''}`
        + `${result.mirrorWritten ? '' : ' (run directory unwritable; ledger event is the record)'}\n`
        + `event ${result.eventId}\n`,
      );
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
