import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ValidityEventV1 } from '@nullius/shared';
import { mintUlid, ULID_PATTERN } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from './validity-ledger.js';
import { captureRunOrigin } from './run-origin.js';
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

function defaultActor(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function runTraceCommand(projectRoot: string, parsed: TraceParsed, io: CliIo): number {
  const actor = parsed.actor ?? defaultActor();
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
      const { appended, already } = confirmRoundChains(projectRoot, actor);
      io.stdout(`confirmed: ${appended} supersede event(s) appended, ${already} already recorded.\n`);
      return 0;
    }
    case 'stamp': {
      const runDir = path.isAbsolute(parsed.target)
        ? parsed.target
        : path.resolve(projectRoot, parsed.target);
      if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
        io.stderr(`trace stamp: run directory not found: ${runDir}\n`);
        return 1;
      }
      // Only the two run roots are stampable: a stamp elsewhere would land
      // in the ledger but be invisible to every directory scan — a record
      // about a run the read model can never show is a silent hole. The
      // check is SYMLINK-RESOLVED on both sides, and a run directory that is
      // itself a symlink is refused outright: the directory scan skips
      // symlink entries, so stamping one would create the same invisible
      // record through a side door.
      if (fs.lstatSync(runDir).isSymbolicLink()) {
        io.stderr(`trace stamp: ${parsed.target} is a symlink; run directories must be real directories under a run root\n`);
        return 1;
      }
      const resolvedRunDir = fs.realpathSync(runDir);
      const inRunRoot = ['artifacts/runs', 'team/runs'].some((relRoot) => {
        const root = path.resolve(projectRoot, relRoot);
        if (!fs.existsSync(root)) return false;
        return path.dirname(resolvedRunDir) === fs.realpathSync(root);
      });
      if (!inRunRoot) {
        io.stderr(
          'trace stamp: run directories live directly under artifacts/runs/ or team/runs/; '
          + `${parsed.target} is outside both roots and would be invisible to the read model\n`,
        );
        return 1;
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
        io.stderr(
          `trace stamp: ${runId} exists under artifacts/runs (canonical) and team/runs (review mirror); `
          + `stamp the canonical directory: artifacts/runs/${runId}\n`,
        );
        return 1;
      }
      // One logical stamp = one ULID for life: with --event-id the retry
      // entrance is the LEDGER (was this event already recorded?), not a
      // payload comparison — a re-capture would legitimately differ (time
      // moved, the tree may have moved) and must not read as divergence.
      // The short-circuit accepts ONLY a stamp event for THIS run: reusing
      // an id that belongs to any other event must fail loudly, never
      // report a stamp that was not taken. Validation happens BEFORE any
      // mirror write so a rejected id leaves no half-state behind.
      if (parsed.eventId) {
        if (!ULID_PATTERN.test(parsed.eventId)) {
          io.stderr(`trace stamp: --event-id ${JSON.stringify(parsed.eventId)} is not a ULID\n`);
          return 1;
        }
        const ledgerView = readValidityLedger(projectRoot);
        // Divergent ids are excluded from `events` by the reader's dedup —
        // check the defect list too, or a divergent id would sail past this
        // preflight into a mirror write before the append rejects it.
        if (ledgerView.integrity_defects.some(defect => defect.event_id === parsed.eventId)) {
          io.stderr(
            `trace stamp: event ${parsed.eventId} is a ledger-integrity defect (divergent payloads); `
            + 'repair the ledger and mint a fresh event id\n',
          );
          return 1;
        }
        const existing = ledgerView.events.find(event => event.event_id === parsed.eventId);
        if (existing) {
          if (existing.event !== 'stamp' || existing.run_id !== runId) {
            io.stderr(
              `trace stamp: event ${parsed.eventId} is already recorded as a ${existing.event} `
              + `for ${existing.run_id}; it cannot identify a stamp of ${runId}\n`,
            );
            return 1;
          }
          io.stdout(`already stamped ${existing.run_id} (event ${parsed.eventId} recorded)\n`);
          return 0;
        }
      }
      const eventId = parsed.eventId ?? mintUlid();
      const origin = captureRunOrigin(projectRoot, runId, {
        deps: parsed.deps,
        eventId,
      });
      // Mirror attempted before the append so its outcome is recorded in the
      // authoritative event; AUTHORITY stays with the ledger regardless of
      // write order (all consumers read the ledger, D2).
      const mirrorPath = path.join(runDir, 'run_origin.json');
      let mirrorWritten = true;
      try {
        fs.writeFileSync(mirrorPath, `${JSON.stringify(origin, null, 2)}\n`);
      } catch {
        mirrorWritten = false;
      }
      const payload = {
        ...(origin as unknown as Record<string, unknown>),
        ...(mirrorWritten ? {} : { run_dir_unwritable: true }),
      };
      const event = buildValidityEvent({
        event: 'stamp',
        run_id: runId,
        actor,
        reason: null,
        stamp: payload as ValidityEventV1['stamp'],
        event_id: eventId,
        ts_utc: (payload as { captured_at_utc: string }).captured_at_utc,
      });
      const outcome = appendValidityEvent(projectRoot, event);
      const record = payload as { binding_quality?: string; baseline_commit?: string | null };
      io.stdout(
        `${outcome === 'appended' ? 'stamped' : 'already stamped'} ${runId}: `
        + `${record.binding_quality}${record.baseline_commit ? ` @ ${record.baseline_commit.slice(0, 12)}` : ''}`
        + `${mirrorWritten ? '' : ' (run directory unwritable; ledger event is the record)'}\n`
        + `event ${event.event_id}\n`,
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
