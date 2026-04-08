/**
 * Tests for JSONL stderr logging in dispatcher (trace-jsonl).
 *
 * Exercises the real emitJsonlLog exported from dispatcher.ts to verify
 * it produces valid JSONL with the expected shape on both success and error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emitJsonlLog, handleToolCall } from '../../src/tools/dispatcher.js';

describe('emitJsonlLog', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('emits valid JSONL on success', () => {
    const toolArgs = { query: 'test topic', size: 5 };
    emitJsonlLog({
      traceId: 'test-trace-001',
      toolName: 'inspire_search',
      toolArgs,
      durationMs: 42,
      resultStatus: 'success',
    });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('INFO');
    expect(parsed.component).toBe('mcp_server');
    expect(parsed.trace_id).toBe('test-trace-001');
    expect(parsed.event).toBe('tool_call');
    expect(parsed.data.tool_name).toBe('inspire_search');
    expect(parsed.data.params).toEqual(toolArgs);
    expect(parsed.data.result_status).toBe('success');
    expect(parsed.data.duration_ms).toBe(42);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits ERROR level on failure', () => {
    emitJsonlLog({
      traceId: 'test-trace-002',
      toolName: 'hep_run_create',
      toolArgs: { project_id: 'P1' },
      durationMs: 100,
      resultStatus: 'error',
    });

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('ERROR');
    expect(parsed.data.result_status).toBe('error');
  });

  it('redacts sensitive params before writing JSONL', () => {
    emitJsonlLog({
      traceId: 'test-trace-003',
      toolName: 'hep_run_stage_content',
      toolArgs: {
        api_key: 'sk-abcdefghijklmnopqrstuvwxyz123456',
        path: '/Users/example/private/project.txt',
      },
      durationMs: 7,
      resultStatus: 'success',
    });

    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(output).not.toContain('/Users/example/');

    const parsed = JSON.parse(output.trim());
    expect(parsed.data.params.api_key).toBe('sk-***');
    expect(parsed.data.params.path).toBe('/Users/<redacted>/private/project.txt');
  });

  it('omits internal _confirm from logged params on confirmed destructive calls', async () => {
    const res = await handleToolCall('hep_export_project', { run_id: 'nonexistent-run', _confirm: true }, 'standard');

    expect(res.isError).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();

    const jsonlEntry = stderrSpy.mock.calls
      .map(call => String(call[0]).trim())
      .map(line => JSON.parse(line))
      .find(entry => entry.event === 'tool_call');

    expect(jsonlEntry).toBeDefined();
    expect(jsonlEntry.data.tool_name).toBe('hep_export_project');
    expect(jsonlEntry.data.params.run_id).toBe('nonexistent-run');
    expect(jsonlEntry.data.params).not.toHaveProperty('_confirm');
    expect(jsonlEntry.data.result_status).toBe('error');
  });

  it('does not throw when stderr.write fails', () => {
    stderrSpy.mockImplementation(() => {
      throw new Error('write failed');
    });

    expect(() =>
      emitJsonlLog({
        traceId: 'test',
        toolName: 'test',
        toolArgs: {},
        durationMs: 0,
        resultStatus: 'success',
      }),
    ).not.toThrow();
  });
});
