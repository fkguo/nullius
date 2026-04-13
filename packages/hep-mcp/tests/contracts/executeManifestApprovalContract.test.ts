import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StateManager, handleToolCall as handleOrchToolCall } from '@autoresearch/orchestrator';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execute-manifest-approval-'));
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  delete process.env.HEP_DATA_DIR;
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('orch_run_execute_manifest approval contract', () => {
  it('requires A3 approval before executing the manifest', async () => {
    const projectRoot = makeTmpDir();
    CLEANUP_DIRS.push(projectRoot);

    const hepDataDir = makeTmpDir();
    CLEANUP_DIRS.push(hepDataDir);
    process.env.HEP_DATA_DIR = hepDataDir;

    const runId = 'run-approval-1';
    const runDir = path.join(hepDataDir, 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'computation', 'scripts'), { recursive: true });
    writeJson(path.join(runDir, 'manifest.json'), {
      run_id: runId,
      project_id: 'proj-1',
      status: 'running',
      created_at: '2026-03-12T00:00:00Z',
      updated_at: '2026-03-12T00:00:00Z',
      steps: [],
    });
    fs.writeFileSync(
      path.join(runDir, 'computation', 'scripts', 'write_later.py'),
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/result.txt').write_text('approved\\n', encoding='utf-8')\n",
      'utf-8',
    );
    writeJson(path.join(runDir, 'computation', 'manifest.json'), {
      schema_version: 1,
      entry_point: { script: 'scripts/write_later.py', tool: 'python' },
      steps: [
        {
          id: 'write_later',
          tool: 'python',
          script: 'scripts/write_later.py',
          expected_outputs: ['outputs/result.txt'],
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
      computation_budget: { max_runtime_minutes: 5 },
    });

    const manager = new StateManager(projectRoot);
    const state = manager.readState();
    manager.createRun(state, runId, 'computation');

    const result = await handleOrchToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
        manifest_path: 'computation/manifest.json',
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.requires_approval).toBe(true);
    expect(payload.approval_id).toBe('A3-0001');
    expect(String(payload.packet_path ?? '')).toContain('artifacts/runs/run-approval-1/approvals/A3-0001/');

    const updated = manager.readState();
    expect(updated.run_status).toBe('awaiting_approval');
    expect(updated.pending_approval?.category).toBe('A3');
  });

  it('does not execute any step or write execution artifacts before approval', async () => {
    const projectRoot = makeTmpDir();
    CLEANUP_DIRS.push(projectRoot);

    const hepDataDir = makeTmpDir();
    CLEANUP_DIRS.push(hepDataDir);
    process.env.HEP_DATA_DIR = hepDataDir;

    const runId = 'run-approval-2';
    const runDir = path.join(hepDataDir, 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'computation', 'scripts'), { recursive: true });
    writeJson(path.join(runDir, 'manifest.json'), {
      run_id: runId,
      project_id: 'proj-1',
      status: 'running',
      created_at: '2026-03-12T00:00:00Z',
      updated_at: '2026-03-12T00:00:00Z',
      steps: [],
    });
    fs.writeFileSync(
      path.join(runDir, 'computation', 'scripts', 'write_later.py'),
      "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/result.txt').write_text('approved\\n', encoding='utf-8')\n",
      'utf-8',
    );
    writeJson(path.join(runDir, 'computation', 'manifest.json'), {
      schema_version: 1,
      entry_point: { script: 'scripts/write_later.py', tool: 'python' },
      steps: [
        {
          id: 'write_later',
          tool: 'python',
          script: 'scripts/write_later.py',
          expected_outputs: ['outputs/result.txt'],
        },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });

    const manager = new StateManager(projectRoot);
    const state = manager.readState();
    manager.createRun(state, runId, 'computation');

    const result = await handleOrchToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
        manifest_path: 'computation/manifest.json',
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.requires_approval).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'result.txt'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'computation', 'execution_status.json'))).toBe(false);
  });
});
