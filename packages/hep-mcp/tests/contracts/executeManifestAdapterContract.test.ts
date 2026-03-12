import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const executeComputationManifest = vi.fn();

vi.mock('@autoresearch/orchestrator', async importOriginal => {
  const actual = await importOriginal<typeof import('@autoresearch/orchestrator')>();
  return {
    ...actual,
    executeComputationManifest,
  };
});

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execute-manifest-adapter-'));
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  executeComputationManifest.mockReset();
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('hep_run_execute_manifest adapter contract', () => {
  it('delegates to the generic orchestrator core without HEP-specific parameter expansion', async () => {
    const tmpDir = makeTmpDir();
    CLEANUP_DIRS.push(tmpDir);
    process.env.HEP_DATA_DIR = tmpDir;

    const runId = 'run-adapter-1';
    const runDir = path.join(tmpDir, 'runs', runId);
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

    executeComputationManifest.mockResolvedValue({
      status: 'dry_run',
      validated: true,
      dry_run: true,
      manifest_path: 'computation/manifest.json',
      run_id: runId,
    });

    const { handleToolCall } = await import('../../src/tools/index.js');
    const result = await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: '/tmp/project-root',
        run_id: runId,
        manifest_path: 'computation/manifest.json',
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('dry_run');
    expect(executeComputationManifest).toHaveBeenCalledTimes(1);
    expect(executeComputationManifest).toHaveBeenCalledWith({
      dryRun: true,
      manifestPath: path.join(runDir, 'computation', 'manifest.json'),
      projectRoot: '/tmp/project-root',
      runDir,
      runId,
    });
    expect(Object.keys(executeComputationManifest.mock.calls[0]![0] as Record<string, unknown>).sort()).toEqual(
      ['dryRun', 'manifestPath', 'projectRoot', 'runDir', 'runId'],
    );
  });

  it('passes approval packet fields through unchanged when the generic core requires approval', async () => {
    const tmpDir = makeTmpDir();
    CLEANUP_DIRS.push(tmpDir);
    process.env.HEP_DATA_DIR = tmpDir;

    const runId = 'run-adapter-2';
    const runDir = path.join(tmpDir, 'runs', runId);
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

    executeComputationManifest.mockResolvedValue({
      status: 'requires_approval',
      requires_approval: true,
      approval_id: 'A3-0007',
      approval_packet_sha256: 'b'.repeat(64),
      gate_id: 'A3',
      packet_path: 'artifacts/runs/run-adapter-2/approvals/A3-0007/packet_short.md',
      run_id: runId,
    });

    const { handleToolCall } = await import('../../src/tools/index.js');
    const result = await handleToolCall(
      'hep_run_execute_manifest',
      {
        _confirm: true,
        project_root: '/tmp/project-root',
        run_id: runId,
        manifest_path: 'computation/manifest.json',
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.requires_approval).toBe(true);
    expect(payload.approval_id).toBe('A3-0007');
    expect(payload.approval_packet_sha256).toBe('b'.repeat(64));
    expect(payload.packet_path).toBe('artifacts/runs/run-adapter-2/approvals/A3-0007/packet_short.md');
  });
});
