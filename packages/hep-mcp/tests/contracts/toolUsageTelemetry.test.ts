import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { resetToolUsageTelemetryForTests } from '../../src/tools/utils/toolUsageTelemetry.js';

function parsePayload<T>(res: { content: Array<{ text: string }>; isError?: boolean }): T {
  return JSON.parse(res.content[0]?.text ?? '{}') as T;
}

describe('Contract: optional tool usage telemetry', () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  let originalTelemetry: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.HEP_DATA_DIR;
    originalTelemetry = process.env.HEP_ENABLE_TOOL_USAGE_TELEMETRY;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-telemetry-'));
    process.env.HEP_DATA_DIR = tempDir;
    resetToolUsageTelemetryForTests();
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDir;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (originalTelemetry !== undefined) {
      process.env.HEP_ENABLE_TOOL_USAGE_TELEMETRY = originalTelemetry;
    } else {
      delete process.env.HEP_ENABLE_TOOL_USAGE_TELEMETRY;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    resetToolUsageTelemetryForTests();
  });

  it('hep_health exposes aggregated tool usage when telemetry is enabled', async () => {
    process.env.HEP_ENABLE_TOOL_USAGE_TELEMETRY = '1';

    await handleToolCall('hep_project_create', { name: 'telemetry-proj', description: 'telemetry' }, 'standard');
    await handleToolCall('hep_project_list', {}, 'standard');
    await handleToolCall('hep_project_list', {}, 'standard');

    const healthRes = await handleToolCall('hep_health', { check_inspire: false, inspire_timeout_ms: 500 }, 'standard');
    expect(healthRes.isError).not.toBe(true);

    const payload = parsePayload<{
      telemetry?: {
        enabled: boolean;
        total_calls: number;
        unique_tools: number;
        by_tool: Array<{ tool: string; calls: number }>;
      };
    }>(healthRes);

    expect(payload.telemetry?.enabled).toBe(true);
    expect((payload.telemetry?.total_calls ?? 0) >= 3).toBe(true);
    expect((payload.telemetry?.unique_tools ?? 0) >= 2).toBe(true);

    const byTool = new Map((payload.telemetry?.by_tool ?? []).map(row => [row.tool, row.calls]));
    expect(byTool.get('hep_project_create')).toBe(1);
    expect(byTool.get('hep_project_list')).toBe(2);
  });

  it('hep_health reports telemetry disabled when env opt-in is not set', async () => {
    delete process.env.HEP_ENABLE_TOOL_USAGE_TELEMETRY;

    await handleToolCall('hep_project_list', {}, 'standard');
    const healthRes = await handleToolCall('hep_health', { check_inspire: false, inspire_timeout_ms: 500 }, 'standard');
    expect(healthRes.isError).not.toBe(true);

    const payload = parsePayload<{
      telemetry?: {
        enabled: boolean;
        total_calls: number;
        unique_tools: number;
        by_tool: Array<{ tool: string; calls: number }>;
      };
    }>(healthRes);

    expect(payload.telemetry?.enabled).toBe(false);
    expect(payload.telemetry?.total_calls).toBe(0);
    expect(payload.telemetry?.unique_tools).toBe(0);
    expect(payload.telemetry?.by_tool ?? []).toEqual([]);
  });
});
