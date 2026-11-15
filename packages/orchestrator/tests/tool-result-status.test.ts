import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compactMessagesForOverflow } from '../src/agent-runner-history-compaction.js';
import { resolveIncompleteToolUses } from '../src/agent-runner-ops.js';
import type { MessageParam } from '../src/backends/chat-backend.js';
import { OrchRunExecuteAgentSchema } from '../src/orch-tools/schemas.js';
import { createToolAttemptIdentity, RunManifestManager } from '../src/run-manifest.js';
import { buildDirectRuntimePermissionProfile } from '../src/runtime-permission-profile.js';
import { buildRuntimeToolPermissionView } from '../src/tool-execution-policy.js';

describe('tool-result status across transcript and recovery boundaries', () => {
  it('records removed failures even when whole exchanges fall outside the summary preview', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'Keep unavailable evidence visible.' }];
    for (let index = 0; index < 5; index++) {
      messages.push({ role: 'assistant', content: [{
        type: 'tool_use', id: `read-${index}`, name: 'project_text_read', input: { path: 'source.tex' },
      }] }, { role: 'user', content: [{
        type: 'tool_result', tool_use_id: `read-${index}`, content: 'Source content was unavailable.',
        ...([0, 2].includes(index) ? { is_error: true } : {}),
      }] });
    }
    const compacted = compactMessagesForOverflow(messages);
    expect(compacted?.stats.removedMessages).toBe(6);
    const marker = compacted!.messages.find(message => typeof message.content === 'string'
      && message.content.includes('Context compaction applied'));
    expect(marker?.content).toContain('removed_tool_result_errors=2 (this compaction pass only)');
    expect(marker?.content).toContain('tool_result:read-0 status=error');
    expect(marker?.content).not.toContain('tool_result:read-2');
    expect(marker?.content).toContain('not complete evidence');
  });

  it('retains a failure through the public transcript schema and real history compaction without changing success shape', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Preserve source failures while continuing the investigation.' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'failed', name: 'project_text_read', input: { path: 'missing.tex' } },
        { type: 'tool_use', id: 'success', name: 'project_text_read', input: { path: 'source.tex' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'failed', content: 'Read refused. '.repeat(100), is_error: true },
        { type: 'tool_result', tool_use_id: 'success', content: 'Source content. '.repeat(100) },
      ] },
      { role: 'assistant', content: 'Continue with the available source.' },
    ];
    const parsed = OrchRunExecuteAgentSchema.safeParse({
      _confirm: true, project_root: '/project', run_id: 'source-status', model: 'fixture', messages,
      tools: [{ name: 'project_text_read', input_schema: {} }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    const resultBlocks = (transcript: MessageParam[]) => transcript.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result') : []);
    expect(resultBlocks(parsed.data.messages)[0]).toHaveProperty('is_error', true);
    expect(resultBlocks(parsed.data.messages)[1]).not.toHaveProperty('is_error');

    const compacted = compactMessagesForOverflow(parsed.data.messages);
    expect(compacted).not.toBeNull();
    const blocks = resultBlocks(compacted!.messages);
    expect(blocks.map(block => block.tool_use_id)).toEqual(['failed', 'success']);
    expect(blocks.every(block => block.content.includes('incomplete_excerpt='))).toBe(true);
    expect(blocks[0]).toHaveProperty('is_error', true);
    expect(blocks[1]).not.toHaveProperty('is_error');
  });

  it.each([true, false])('replays committed isError=%s without dispatching again or inferring status from text', async isError => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-result-status-'));
    try {
      const manager = new RunManifestManager(path.join(root, 'runs'));
      const runId = 'replay-status';
      const toolName = 'project_text_read';
      const input = { path: 'source.tex' };
      const identity = createToolAttemptIdentity({ stepId: 'read', toolName, input });
      const rawText = isError ? 'Unavailable' : '{"error":"this word appears in successful source data"}';
      manager.observeToolIntents(runId, [identity]);
      manager.markToolIntentsDispatched(runId, [identity]);
      manager.commitToolAttempt(runId, identity, { ok: !isError, isError, rawText, json: null, errorCode: null });
      const mcpClient = { callTool: vi.fn(async () => { throw new Error('A committed source read must not be dispatched again.'); }) };
      const messages: MessageParam[] = [
        { role: 'user', content: 'Resume the recorded investigation.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: toolName, input }] },
      ];
      const result = await resolveIncompleteToolUses({
        messages, mcpClient, runId, approvalRunId: runId, approvalProjectRoot: root, manifestManager: manager,
        permissionView: buildRuntimeToolPermissionView(buildDirectRuntimePermissionProfile({
          tools: [{ name: toolName, input_schema: {} }],
        })),
      });
      expect(result?.done).toBe(false);
      expect(mcpClient.callTool).not.toHaveBeenCalled();
      expect(result?.messages.at(-1)).toEqual({ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'read', content: rawText,
        ...(isError ? { is_error: true } : {}),
      }] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
