import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomicDurable } from '@autoresearch/shared';
import type { RunManifest } from './run-manifest.js';
import type {
  DelegatedRuntimeMarkerKind,
  DelegatedRuntimeProjectionV1,
  DelegatedRuntimeTurnPhase,
} from './research-loop/delegated-runtime-projection.js';
import {
  summarizeRuntimeProjectionForOperator,
  type RuntimeDiagnosticsSummaryV1,
} from './operator-read-model-summary.js';
import { utcNowIso } from './util.js';

export type {
  RuntimeDiagnosticsActionV1,
  RuntimeDiagnosticsCauseV1,
  RuntimeDiagnosticsStatusV1,
  RuntimeDiagnosticsSummaryV1,
} from './operator-read-model-summary.js';

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
    summary: summarizeRuntimeProjectionForOperator(params.runtimeProjection),
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

  // writeJsonAtomicDurable: mkdir + atomic write + file fsync + parent-dir
  // fsync (the bridge artifact gates resume semantics — partial reads here
  // mislead the operator read-model). Explicit `stringify` argument
  // (no trailing newline) preserves byte parity with the prior
  // `fs.writeFileSync(..., JSON.stringify(payload, null, 2), 'utf-8')` —
  // existing on-disk artifacts don't grow by 1 byte under migration.
  writeJsonAtomicDurable(
    path.join(runDir, artifactName),
    payload,
    (p) => JSON.stringify(p, null, 2),
  );
  return { artifactPath, payload };
}
