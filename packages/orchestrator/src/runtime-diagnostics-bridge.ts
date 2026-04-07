import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunManifest } from './run-manifest.js';
import type {
  DelegatedRuntimeMarkerKind,
  DelegatedRuntimeProjectionV1,
  DelegatedRuntimeTurnPhase,
} from './research-loop/delegated-runtime-projection.js';
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
  phase: DelegatedRuntimeTurnPhase;
  kind: DelegatedRuntimeMarkerKind;
  turn_count: number;
  text_count: number;
  tool_call_count: number;
}

interface RuntimeTerminalEvidenceV1 {
  phase: DelegatedRuntimeTurnPhase;
  turn_count: number;
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

function summarizeRuntime(runtimeProjection: DelegatedRuntimeProjectionV1): RuntimeDiagnosticsSummaryV1 {
  if (runtimeProjection.terminal_outcome?.type === 'error') {
    return { status: 'failed', primary_cause: 'runtime_error', recommended_action: 'inspect_runtime_evidence' };
  }
  if (runtimeProjection.approval_requested) {
    return { status: 'awaiting_approval', primary_cause: 'approval_required', recommended_action: 'approve_or_reject_and_resume' };
  }
  if (runtimeProjection.runtime_marker_kinds.includes('diminishing_returns_stop')) {
    return { status: 'needs_recovery', primary_cause: 'diminishing_returns', recommended_action: 'reframe_or_replan_before_resume' };
  }
  if (runtimeProjection.runtime_marker_kinds.includes('context_overflow_retry')) {
    return { status: 'degraded', primary_cause: 'context_overflow', recommended_action: 'compact_or_reduce_context' };
  }
  if (runtimeProjection.runtime_marker_kinds.includes('truncation_retry')) {
    return { status: 'degraded', primary_cause: 'truncation', recommended_action: 'compact_or_reduce_context' };
  }
  if (runtimeProjection.terminal_outcome?.type === 'done' && runtimeProjection.terminal_outcome.stop_reason === 'max_turns') {
    return { status: 'degraded', primary_cause: 'max_turns', recommended_action: 'reframe_or_replan_before_resume' };
  }
  if (runtimeProjection.terminal_outcome?.type === 'done') {
    return { status: 'ok', primary_cause: 'none', recommended_action: 'none' };
  }
  return { status: 'degraded', primary_cause: 'unknown_terminal', recommended_action: 'inspect_runtime_evidence' };
}

export function writeRuntimeDiagnosticsBridgeArtifact(params: {
  projectRoot: string;
  runId: string;
  runtimeProjection: DelegatedRuntimeProjectionV1;
  manifestPath: string;
  spansPath: string;
  savedManifest: RunManifest | null;
}): { artifactPath: string; payload: RuntimeDiagnosticsBridgeArtifactV1 } {
  const runDir = path.join(params.projectRoot, 'artifacts', 'runs', params.runId);
  const artifactName = 'runtime_diagnostics_bridge_v1.json';
  const artifactPath = path.posix.join('artifacts', 'runs', params.runId, artifactName);

  const markers: RuntimeMarkerEvidenceV1[] = params.runtimeProjection.projected_turns.flatMap(turn =>
    turn.runtime_marker_kinds.map(kind => ({
      phase: turn.phase,
      kind,
      turn_count: turn.turn_count,
      text_count: turn.text_count,
      tool_call_count: turn.tool_call_count,
    })));
  const terminalEvent: RuntimeTerminalEvidenceV1 | null = params.runtimeProjection.terminal_outcome
    ? {
        phase: params.runtimeProjection.terminal_outcome.phase,
        turn_count: params.runtimeProjection.terminal_outcome.turn_count,
        type: params.runtimeProjection.terminal_outcome.type,
        stop_reason: params.runtimeProjection.terminal_outcome.stop_reason,
        error_code: params.runtimeProjection.terminal_outcome.error_code,
      }
    : null;

  const payload: RuntimeDiagnosticsBridgeArtifactV1 = {
    version: 1,
    generated_at: utcNowIso(),
    run_id: params.runId,
    summary: summarizeRuntime(params.runtimeProjection),
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
