import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleToolCall } from '../src/tooling.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('orch_run_stage_content', () => {
  it('writes a staged content artifact into an existing run directory and returns a rep:// staging uri', async () => {
    const tmpDir = makeTmpDir('orch-run-stage-content-');
    CLEANUP_DIRS.push(tmpDir);
    const runDir = path.join(tmpDir, 'run-1');

    const res = await handleToolCall('orch_run_stage_content', {
      run_id: 'run-1',
      run_dir: runDir,
      content_type: 'section_output',
      content: '{"section_number":"1","title":"Draft","content":"Hello"}',
      artifact_suffix: 'test',
      task_id: 'task-draft-1',
      task_kind: 'draft_update',
    }, 'full');

    const payload = extractPayload(res);
    expect(payload.run_id).toBe('run-1');
    expect(payload.artifact_name).toBe('staged_section_output_test.json');
    expect(payload.staging_uri).toBe('rep://runs/run-1/artifact/artifacts%2Fstaged_section_output_test.json');
    expect(payload.content_bytes).toBeGreaterThan(0);

    const artifact = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'staged_section_output_test.json'), 'utf-8'),
    ) as {
      version: number;
      staged_at: string;
      content_type: string;
      content: string;
    };
    expect(artifact.version).toBe(1);
    expect(artifact.staged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(artifact.content_type).toBe('section_output');
    expect(artifact.content).toContain('"Draft"');
    expect((artifact as Record<string, unknown>).task_ref).toEqual({
      task_id: 'task-draft-1',
      task_kind: 'draft_update',
    });
  });
});
