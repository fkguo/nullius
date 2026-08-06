import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ValidityEventV1 } from '@nullius/shared';
import { mintUlid } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from './validity-ledger.js';
import { captureRunOrigin } from './run-origin.js';
import { buildTraceabilityView, renderTraceabilityProse } from './traceability-view.js';

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
  action: 'stamp' | 'supersede' | 'void' | 'reinstate';
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
    case 'stamp': {
      const runDir = path.isAbsolute(parsed.target)
        ? parsed.target
        : path.resolve(projectRoot, parsed.target);
      if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
        io.stderr(`trace stamp: run directory not found: ${runDir}\n`);
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
      if (parsed.eventId) {
        const existing = readValidityLedger(projectRoot)
          .events.find(event => event.event_id === parsed.eventId);
        if (existing) {
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
  const view = buildTraceabilityView(projectRoot);
  if (json) {
    io.stdout(`${JSON.stringify(view, null, 2)}\n`);
  } else {
    io.stdout(renderTraceabilityProse(view));
  }
  return 0;
}
