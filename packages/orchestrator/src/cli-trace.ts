import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ValidityEventV1 } from '@nullius/shared';
import { appendValidityEvent, buildValidityEvent } from './validity-ledger.js';
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
      const origin = captureRunOrigin(projectRoot, runId, {
        deps: parsed.deps,
        ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
      });
      // Mirror first so its outcome is recorded in the authoritative event;
      // authority stays with the ledger (all consumers read the ledger).
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
        ...(parsed.eventId ? { event_id: parsed.eventId } : {}),
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
