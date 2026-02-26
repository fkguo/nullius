/**
 * Tests for JSONL stderr logging in dispatcher (trace-jsonl).
 *
 * Exercises the real emitJsonlLog exported from dispatcher.ts to verify
 * it produces valid JSONL with the expected shape on both success and error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emitJsonlLog } from '../../src/tools/dispatcher.js';

describe('emitJsonlLog', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('emits valid JSONL on success', () => {
    emitJsonlLog({
      traceId: 'test-trace-001',
      toolName: 'inspire_search',
      durationMs: 42,
      success: true,
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
    expect(parsed.data.duration_ms).toBe(42);
    expect(parsed.data.success).toBe(true);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits ERROR level on failure', () => {
    emitJsonlLog({
      traceId: 'test-trace-002',
      toolName: 'hep_run_create',
      durationMs: 100,
      success: false,
    });

    const output = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.level).toBe('ERROR');
    expect(parsed.data.success).toBe(false);
  });

  it('does not throw when stderr.write fails', () => {
    stderrSpy.mockImplementation(() => {
      throw new Error('write failed');
    });

    expect(() =>
      emitJsonlLog({
        traceId: 'test',
        toolName: 'test',
        durationMs: 0,
        success: true,
      }),
    ).not.toThrow();
  });
});
