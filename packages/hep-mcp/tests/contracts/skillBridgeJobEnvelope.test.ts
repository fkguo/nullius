import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';

type ToolResult = Awaited<ReturnType<typeof handleToolCall>>;

type JobEnvelope = {
  version: number;
  job_id: string;
  status: string;
  manifest_path: string;
  polling: {
    strategy: string;
    manifest_path: string;
    terminal_statuses: string[];
  };
};

function parsePayload<T>(result: ToolResult): T {
  return JSON.parse(result.content[0]?.text ?? '{}') as T;
}

describe('Contract: Skill↔MCP bridge job envelope', () => {
  let tempDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adds job envelope to run-scoped tool results with manifest file polling info', async () => {
    const projectRes = await handleToolCall('hep_project_create', {
      name: 'bridge-project',
      description: 'contract test',
    });
    const project = parsePayload<{ project_id: string; job?: unknown }>(projectRes);
    expect(project.job).toBeUndefined();

    const runRes = await handleToolCall('hep_run_create', {
      project_id: project.project_id,
    });
    expect(runRes.isError).not.toBe(true);

    const run = parsePayload<{ run_id: string; manifest_uri: string; job: JobEnvelope }>(runRes);
    expect(run.job.version).toBe(1);
    expect(run.job.job_id).toBe(run.run_id);
    expect(Object.keys(run.job).sort()).toEqual(['job_id', 'manifest_path', 'polling', 'status', 'version']);
    expect(run.job.manifest_path).toBe(path.join(tempDir, 'runs', run.run_id, 'manifest.json'));
    expect(run.job.polling.strategy).toBe('manifest_file');
    expect(Object.keys(run.job.polling).sort()).toEqual(['manifest_path', 'strategy', 'terminal_statuses']);
    expect(run.job.polling.manifest_path).toBe(run.job.manifest_path);
    expect(run.job.polling.terminal_statuses).toContain('done');
    expect(['pending', 'running', 'done', 'failed', 'unknown']).toContain(run.job.status);
  });

  it('does not attach job envelope to error payloads', async () => {
    const res = await handleToolCall('hep_run_stage_content', {
      content_type: 'reviewer_report',
      content: '{"summary":"draft"}',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parsePayload<{ error?: { code?: string }; job?: unknown }>(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.job).toBeUndefined();
  });

  it('keeps job envelope on later hep_run_* execution responses', async () => {
    const projectRes = await handleToolCall('hep_project_create', {
      name: 'bridge-project-2',
      description: 'contract test',
    });
    const project = parsePayload<{ project_id: string }>(projectRes);

    const runRes = await handleToolCall('hep_run_create', {
      project_id: project.project_id,
    });
    const run = parsePayload<{ run_id: string }>(runRes);

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'section_output',
      content: '{"hello":"world"}',
    });
    expect(stageRes.isError).not.toBe(true);

    const staged = parsePayload<{ run_id: string; job: JobEnvelope }>(stageRes);
    expect(staged.run_id).toBe(run.run_id);
    expect(staged.job.job_id).toBe(run.run_id);
    expect(Object.keys(staged.job).sort()).toEqual(['job_id', 'manifest_path', 'polling', 'status', 'version']);
    expect(staged.job.manifest_path).toBe(path.join(tempDir, 'runs', run.run_id, 'manifest.json'));
    expect(staged.job.polling.strategy).toBe('manifest_file');
    expect(Object.keys(staged.job.polling).sort()).toEqual(['manifest_path', 'strategy', 'terminal_statuses']);
    expect(staged.job.polling.manifest_path).toBe(staged.job.manifest_path);
  });
});
