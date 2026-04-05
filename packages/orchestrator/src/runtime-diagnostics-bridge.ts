import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunManifest } from './run-manifest.js';
import type { AgentEvent } from './agent-runner-ops.js';
import { utcNowIso } from './util.js';

export type RuntimeDiagnosticsStatusV1 = 'ok' | 'degraded' | 'needs_recovery' | 'awaiting_approval' | 'failed';

export type RuntimeDiagnosticsCauseV1 =
  | 'none'
  | 'diminishing_returns'
  | 'context_overflow'
  | 'truncation'
  | 'approval_required'
  | 'runtime_error'
  | 'max_turns'
  | 'unknown_terminal';

export type RuntimeDiagnosticsActionV1 =
  | 'none'
  | 'inspect_runtime_evidence'
  | 'reframe_or_replan_before_resume'
  | 'approve_or_reject_and_resume'
  | 'compact_or_reduce_context';

export interface RuntimeDiagnosticsSummaryV1 {
  status: RuntimeDiagnosticsStatusV1;
  primary_cause: RuntimeDiagnosticsCauseV1;
  recommended_action: RuntimeDiagnosticsActionV1;
}

interface RuntimeMarkerEvidenceV1 {
  event_index: number;
  kind: Extract<AgentEvent, { type: 'runtime_marker' }>['kind'];
  turn_count: number;
  detail_keys: string[];
}

interface RuntimeTerminalEvidenceV1 {
  event_index: number;
  type: 'done' | 'error';
  stop_reason?: string;
  error_code?: string | null;
}

export interface RuntimeDiagnosticsBridgeArtifactV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  summary: RuntimeDiagnosticsSummaryV1;
  evidence: {
    manifest: {
      path: string;
      exists: boolean;
      last_completed_step: string | null;
      checkpoint_count: number;
    };
    spans: {
      path: string;
      exists: boolean;
    };
    runtime_markers: RuntimeMarkerEvidenceV1[];
    terminal_event: RuntimeTerminalEvidenceV1 | null;
  };
  artifacts: {
    runtime_diagnostics_bridge_path: string;
  };
}

function summarizeRuntime(events: AgentEvent[]): RuntimeDiagnosticsSummaryV1 {
  const lastTerminal = [...events].reverse().find(event => event.type === 'done' || event.type === 'error');
  if (lastTerminal?.type === 'error') {
    return { status: 'failed', primary_cause: 'runtime_error', recommended_action: 'inspect_runtime_evidence' };
  }
  if (events.some(event => event.type === 'approval_required')) {
    return { status: 'awaiting_approval', primary_cause: 'approval_required', recommended_action: 'approve_or_reject_and_resume' };
  }
  if (events.some(event => event.type === 'runtime_marker' && event.kind === 'diminishing_returns_stop')) {
    return { status: 'needs_recovery', primary_cause: 'diminishing_returns', recommended_action: 'reframe_or_replan_before_resume' };
  }
  if (events.some(event => event.type === 'runtime_marker' && event.kind === 'context_overflow_retry')) {
    return { status: 'degraded', primary_cause: 'context_overflow', recommended_action: 'compact_or_reduce_context' };
  }
  if (events.some(event => event.type === 'runtime_marker' && event.kind === 'truncation_retry')) {
    return { status: 'degraded', primary_cause: 'truncation', recommended_action: 'compact_or_reduce_context' };
  }
  if (lastTerminal?.type === 'done' && lastTerminal.stopReason === 'max_turns') {
    return { status: 'degraded', primary_cause: 'max_turns', recommended_action: 'reframe_or_replan_before_resume' };
  }
  if (lastTerminal?.type === 'done') {
    return { status: 'ok', primary_cause: 'none', recommended_action: 'none' };
  }
  return { status: 'degraded', primary_cause: 'unknown_terminal', recommended_action: 'inspect_runtime_evidence' };
}

export function writeRuntimeDiagnosticsBridgeArtifact(params: {
  projectRoot: string;
  runId: string;
  events: AgentEvent[];
  manifestPath: string;
  spansPath: string;
  savedManifest: RunManifest | null;
}): { artifactPath: string; payload: RuntimeDiagnosticsBridgeArtifactV1 } {
  const runDir = path.join(params.projectRoot, 'artifacts', 'runs', params.runId);
  const artifactName = 'runtime_diagnostics_bridge_v1.json';
  const artifactPath = path.posix.join('artifacts', 'runs', params.runId, artifactName);

  const markers: RuntimeMarkerEvidenceV1[] = params.events.flatMap((event, index) => (event.type === 'runtime_marker'
    ? [{
        event_index: index,
        kind: event.kind,
        turn_count: event.turnCount,
        detail_keys: Object.keys(event.detail).sort(),
      }]
    : []));
  const terminalEvent = [...params.events]
    .map((event, index): RuntimeTerminalEvidenceV1 | null => {
      if (event.type === 'done') {
        return { event_index: index, type: 'done', stop_reason: event.stopReason };
      }
      if (event.type === 'error') {
        return { event_index: index, type: 'error', error_code: event.error.code };
      }
      return null;
    })
    .filter((event): event is RuntimeTerminalEvidenceV1 => event !== null)
    .at(-1) ?? null;

  const payload: RuntimeDiagnosticsBridgeArtifactV1 = {
    version: 1,
    generated_at: utcNowIso(),
    run_id: params.runId,
    summary: summarizeRuntime(params.events),
    evidence: {
      manifest: {
        path: params.manifestPath,
        exists: fs.existsSync(path.join(params.projectRoot, params.manifestPath)),
        last_completed_step: params.savedManifest?.last_completed_step ?? null,
        checkpoint_count: params.savedManifest?.checkpoints.length ?? 0,
      },
      spans: {
        path: params.spansPath,
        exists: fs.existsSync(path.join(params.projectRoot, params.spansPath)),
      },
      runtime_markers: markers,
      terminal_event: terminalEvent,
    },
    artifacts: {
      runtime_diagnostics_bridge_path: artifactPath,
    },
  };

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, artifactName), JSON.stringify(payload, null, 2), 'utf-8');
  return { artifactPath, payload };
}
