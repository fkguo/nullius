import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, ledgerLineCount, makeTmpDir } from './orchRunExecuteAgentTestSupport.js';

describe('orch_run_execute_agent base contract', () => {
  it('requires _confirm before executing the destructive shared runtime surface', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall(
      'orch_run_execute_agent',
      {
        project_root: projectRoot,
        run_id: 'run-live',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      },
      'full',
    );

    expect(res.isError).toBe(true);
    const payload = extractPayload(res);
    const error = payload.error as {
      code?: string;
      data?: { tool?: string; next_actions?: Array<{ args?: { _confirm?: boolean } }> };
    };
    expect(error.code).toBe('CONFIRMATION_REQUIRED');
    expect(error.data?.tool).toBe('orch_run_execute_agent');
    expect(error.data?.next_actions?.[0]?.args?._confirm).toBe(true);
  });

  it('persists a manifest and skips completed tool_use blocks on re-entry through the shared tool surface', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-live', workflow_id: 'runtime' },
      'full',
    );
    const ledgerAfterCreate = ledgerLineCount(projectRoot);
    const runtimeArgs = {
      _confirm: true,
      project_root: projectRoot,
      run_id: 'run-live',
      model: 'claude-test',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_pause',
          name: 'orch_run_pause',
          input: { project_root: projectRoot, note: 'pause from runtime test' },
        }],
      }],
      tools: [{
        name: 'orch_run_pause',
        description: 'Pause the current orchestrator run.',
        input_schema: {
          type: 'object',
          properties: {
            project_root: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['project_root'],
        },
      }],
    };

    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        createMessage: async () => {
          throw new Error('interrupt after checkpoint');
        },
      },
    ));
    expect(first.last_completed_step).toBe('tu_pause');
    expect(first.skipped_step_ids).toEqual([]);
    expect((first.events as Array<{ type: string }>).some(event => event.type === 'error')).toBe(true);
    expect(ledgerLineCount(projectRoot)).toBe(ledgerAfterCreate + 1);

    const second = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: 'resume completed' },
          stopReason: 'endTurn',
        }),
      },
    ));
    expect(second.resume_from).toBe('tu_pause');
    expect(second.resumed).toBe(true);
    expect(second.skipped_step_ids).toEqual(['tu_pause']);
    expect(second.last_completed_step).toBe('tu_pause');
    expect((second.events as Array<{ type: string }>).some(event => event.type === 'error')).toBe(false);
    expect((second.events as Array<{ type: string; stopReason?: string }>).some(event => event.type === 'done')).toBe(true);
    expect(second.runtime_diagnostics_summary).toEqual({
      status: 'ok',
      primary_cause: 'none',
      recommended_action: 'none',
    });
    expect(fs.existsSync(path.join(projectRoot, second.runtime_diagnostics_bridge_path as string))).toBe(true);
    expect(ledgerLineCount(projectRoot)).toBe(ledgerAfterCreate + 1);
  });

  it('recovers from a truncated host response through the shared tool surface with an auditable runtime marker', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-truncation-live', workflow_id: 'runtime' },
      'full',
    );

    const payload = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-truncation-live',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'finish the response' }],
        tools: [],
      },
      'full',
      {
        createMessage: vi.fn()
          .mockResolvedValueOnce({
            model: 'claude-test',
            role: 'assistant',
            content: { type: 'text', text: 'partial host answer' },
            stopReason: 'maxTokens',
            usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
          })
          .mockResolvedValueOnce({
            model: 'claude-test',
            role: 'assistant',
            content: { type: 'text', text: 'completed host answer' },
            stopReason: 'endTurn',
          }),
      },
    )) as {
      events: Array<{ type: string; kind?: string; stopReason?: string }>;
      runtime_diagnostics_bridge_path: string;
      runtime_diagnostics_summary: {
        status: string;
        primary_cause: string;
        recommended_action: string;
      };
    };

    expect(payload.events).toContainEqual(expect.objectContaining({ type: 'runtime_marker', kind: 'truncation_retry' }));
    expect(payload.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(payload.runtime_diagnostics_summary).toEqual({
      status: 'degraded',
      primary_cause: 'truncation',
      recommended_action: 'compact_or_reduce_context',
    });
    expect(fs.existsSync(path.join(projectRoot, payload.runtime_diagnostics_bridge_path as string))).toBe(true);
  });
});
