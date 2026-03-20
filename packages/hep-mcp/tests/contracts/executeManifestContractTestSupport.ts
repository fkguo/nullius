import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

export function writeCompletedExecutionFixture(
  runDir: string,
  artifactPath: string,
  workspaceFeedback: Record<string, unknown>,
  runId: string,
): void {
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({
      run_id: runId,
      project_id: 'proj-1',
      status: 'running',
      created_at: '2026-03-12T00:00:00Z',
      updated_at: '2026-03-12T00:00:00Z',
      steps: [],
    }),
  );
  fs.writeFileSync(path.join(runDir, 'computation', 'manifest.json'), '{}\n');
  fs.writeFileSync(artifactPath, JSON.stringify({ workspace_feedback: workspaceFeedback }, null, 2));
}

export function makeCompletedExecutionResult(runId: string, runDir: string, artifactPath: string, manifestFill: string, outcomeFill: string) {
  return {
    status: 'completed',
    ok: true,
    run_id: runId,
    manifest_path: 'computation/manifest.json',
    manifest_sha256: manifestFill.repeat(64),
    artifact_paths: {
      execution_status: path.join(runDir, 'artifacts', 'execution_status.json'),
      logs_dir: path.join(runDir, 'artifacts', 'logs'),
      computation_result: artifactPath,
    },
    outcome_ref: { uri: `hep://runs/${runId}/artifact/computation_result_v1.json`, sha256: outcomeFill.repeat(64) },
    next_actions: [],
    followup_bridge_refs: [],
    summary: 'completed',
    produced_outputs: [],
  };
}
