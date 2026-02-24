import { describe, expect, it } from 'vitest';

import { handleToolCall } from '../../src/tools/index.js';

type ToolResult = Awaited<ReturnType<typeof handleToolCall>>;

type ErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    data?: {
      issues?: Array<{ path?: Array<string | number> }>;
      next_actions?: Array<{ tool?: string; args?: unknown; reason?: string }>;
    };
  };
};

function parseErrorPayload(result: ToolResult): ErrorPayload {
  return JSON.parse(result.content[0]?.text ?? '{}') as ErrorPayload;
}

describe('Contract: dispatcher run_id guidance injection', () => {
  it('hep_run_* missing run_id returns INVALID_PARAMS with two next_actions', async () => {
    const res = await handleToolCall('hep_run_stage_content', {
      content_type: 'reviewer_report',
      content: '{"summary":"draft"}',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.message).toBe('run_id is required. Create one with hep_run_create first.');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['run_id'] })])
    );

    const nextActions = payload.error?.data?.next_actions;
    expect(Array.isArray(nextActions)).toBe(true);
    expect(nextActions).toHaveLength(2);
    expect(nextActions?.map(a => a.tool)).toEqual(['hep_project_create', 'hep_run_create']);
  });

  it('non-hep_run_* missing required params does not inject run_id guidance', async () => {
    const res = await handleToolCall('inspire_literature', {
      mode: 'get_paper',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['recid'] })])
    );
    expect(payload.error?.data?.next_actions).toBeUndefined();
  });

  it('hep_run_* missing non-run_id field does not inject run_id guidance', async () => {
    const res = await handleToolCall('hep_run_stage_content', {
      run_id: 'run_for_parse_only',
      content_type: 'reviewer_report',
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['content'] })])
    );
    expect(payload.error?.data?.next_actions).toBeUndefined();
  });

  it('inspire_parse_latex missing run_id returns INVALID_PARAMS with two next_actions', async () => {
    const res = await handleToolCall('inspire_parse_latex', {
      identifier: '2501.00001',
      components: ['sections'],
    } as any);

    expect(res.isError).toBe(true);
    const payload = parseErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.message).toBe('run_id is required. Create one with hep_run_create first.');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['run_id'] })])
    );

    const nextActions = payload.error?.data?.next_actions;
    expect(Array.isArray(nextActions)).toBe(true);
    expect(nextActions).toHaveLength(2);
    expect(nextActions?.map(a => a.tool)).toEqual(['hep_project_create', 'hep_run_create']);
  });
});
