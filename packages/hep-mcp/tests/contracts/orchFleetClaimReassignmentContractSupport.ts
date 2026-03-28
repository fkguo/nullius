import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDirs: string[] = [];

export function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-reassign-contract-'));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
}

export function writeProject(projectRoot: string, runId = 'run-1'): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    run_id: runId,
    workflow_id: 'runtime',
    run_status: 'idle',
    current_step: null,
    plan: null,
    plan_md_path: null,
    checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
    pending_approval: null,
    approval_seq: { A1: 0, A2: 0, A3: 0, A4: 0, A5: 0 },
    gate_satisfied: {},
    approval_history: [],
    artifacts: {},
    notes: '',
  }, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(controlDir, 'ledger.jsonl'), `${JSON.stringify({
    ts: '2026-03-28T00:00:00Z',
    event_type: 'initialized',
    run_id: runId,
    workflow_id: 'runtime',
    step_id: null,
    details: {},
  })}\n`, 'utf-8');
}

export function writeJsonControlFile(projectRoot: string, fileName: string, payload: unknown): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, fileName), JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

export function extractPayload(res: unknown): Record<string, any> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, any>;
}
