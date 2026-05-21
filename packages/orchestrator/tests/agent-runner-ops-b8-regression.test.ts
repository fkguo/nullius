/**
 * B-8 regression: Recovery tool_result leak before approval gate.
 *
 * Before this fix, `resolveIncompleteToolUses` committed cached
 * `tool_result` blocks to the message thread eagerly. If a batch contained
 * `[cached_block, approval_block]` the cached result was committed BEFORE
 * the approval gate fired, leaving the message thread inconsistent on
 * resume and leaking partial state to the model if approval was later
 * denied.
 *
 * The fix stages all tool_results locally and discards them all if any
 * fresh tool call in the batch raises `requires_approval`. The whole batch
 * re-runs after approval (cached lookups are idempotent).
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveIncompleteToolUses } from '../src/agent-runner-ops.js';
import type { MessageParam } from '../src/backends/chat-backend.js';
import type { ToolCaller, McpToolResult } from '../src/mcp-client.js';
import type { RunManifest } from '../src/run-manifest.js';

function freshAssistantBatch(blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>): MessageParam {
  return {
    role: 'assistant',
    content: blocks.map(b => ({ type: 'tool_use' as const, id: b.id, name: b.name, input: b.input ?? {} })),
  };
}

function manifestWithCheckpoint(runId: string, stepId: string, resultSummary: string): RunManifest {
  return {
    run_id: runId,
    created_at: new Date().toISOString(),
    resume_from: 'recovery',
    checkpoints: [{ step_id: stepId, completed_at: new Date().toISOString(), result_summary: resultSummary }],
  };
}

function mockClient(responses: Map<string, McpToolResult>): ToolCaller {
  return {
    callTool: vi.fn(async (toolName: string) => {
      const res = responses.get(toolName);
      if (!res) throw new Error(`B-8 test: no mock for ${toolName}`);
      return res;
    }),
  };
}

function approvalRequiredResult(approvalId: string, packetPath: string): McpToolResult {
  return {
    ok: true,
    isError: false,
    rawText: 'requires approval',
    json: { requires_approval: true, approval_id: approvalId, packet_path: packetPath } as Record<string, unknown>,
    errorCode: null,
  };
}

function plainOkResult(text: string): McpToolResult {
  return { ok: true, isError: false, rawText: text, json: null, errorCode: null };
}

function countToolResultsInMessages(messages: MessageParam[]): number {
  let count = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === 'tool_result') count += 1;
      }
    }
  }
  return count;
}

describe('B-8: resolveIncompleteToolUses all-or-nothing batch on approval gate', () => {
  it('does NOT commit cached tool_result when a later fresh call requires approval', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      freshAssistantBatch([
        { id: 'tu_cached', name: 'cached_tool' },
        { id: 'tu_approval', name: 'sensitive_tool' },
      ]),
    ];
    const manifest = manifestWithCheckpoint('run_b8', 'tu_cached', 'cached_value');
    const mcpClient = mockClient(new Map([
      ['sensitive_tool', approvalRequiredResult('app_001', '/tmp/packet_b8.json')],
    ]));

    const result = await resolveIncompleteToolUses({ messages, manifest, mcpClient });

    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    // The approval_required event must be present.
    const approvalEvent = result!.events.find(e => e.type === 'approval_required');
    expect(approvalEvent).toBeDefined();
    // CRITICAL: messages array must be UNCHANGED — no new user message with
    // staged tool_results. The cached `tu_cached` result must NOT leak into
    // the message thread.
    expect(result!.messages).toEqual(messages);
    expect(countToolResultsInMessages(result!.messages)).toBe(0);
    // mcpClient.callTool was invoked exactly once (for the approval block;
    // the cached block was served from the checkpoint without a tool call).
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).toHaveBeenCalledWith('sensitive_tool', {});
  });

  it('commits all tool_results when no block requires approval', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      freshAssistantBatch([
        { id: 'tu_cached', name: 'cached_tool' },
        { id: 'tu_fresh', name: 'fresh_tool' },
      ]),
    ];
    const manifest = manifestWithCheckpoint('run_b8', 'tu_cached', 'cached_value');
    const mcpClient = mockClient(new Map([
      ['fresh_tool', plainOkResult('fresh_value')],
    ]));

    const result = await resolveIncompleteToolUses({ messages, manifest, mcpClient });

    expect(result).not.toBeNull();
    expect(result!.done).toBe(false);
    // Whole batch's tool_results committed to a new user message.
    expect(countToolResultsInMessages(result!.messages)).toBe(2);
    const lastMsg = result!.messages[result!.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const lastContent = lastMsg.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
    expect(lastContent[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_cached', content: 'cached_value' });
    expect(lastContent[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_fresh', content: 'fresh_value' });
  });

  it('does NOT commit anything when an approval-only batch hits the gate', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      freshAssistantBatch([{ id: 'tu_approval', name: 'sensitive_tool' }]),
    ];
    const mcpClient = mockClient(new Map([
      ['sensitive_tool', approvalRequiredResult('app_002', '/tmp/packet_b8b.json')],
    ]));

    const result = await resolveIncompleteToolUses({ messages, manifest: null, mcpClient });

    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(result!.messages).toEqual(messages);
    expect(countToolResultsInMessages(result!.messages)).toBe(0);
  });

  it('stops on first approval and does NOT call subsequent fresh tools', async () => {
    // Three-block batch: fresh-ok, fresh-approval, fresh-ok. The third
    // tool must NOT be invoked once the second returns requires_approval.
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      freshAssistantBatch([
        { id: 'tu_one', name: 'tool_one' },
        { id: 'tu_two', name: 'tool_two' },
        { id: 'tu_three', name: 'tool_three' },
      ]),
    ];
    const mcpClient = mockClient(new Map([
      ['tool_one', plainOkResult('value_one')],
      ['tool_two', approvalRequiredResult('app_003', '/tmp/packet_b8c.json')],
      ['tool_three', plainOkResult('value_three')],
    ]));

    const result = await resolveIncompleteToolUses({ messages, manifest: null, mcpClient });

    expect(result).not.toBeNull();
    expect(result!.done).toBe(true);
    expect(result!.messages).toEqual(messages);
    expect(countToolResultsInMessages(result!.messages)).toBe(0);
    // tool_one and tool_two were called; tool_three was NOT.
    expect(mcpClient.callTool).toHaveBeenCalledTimes(2);
    expect(mcpClient.callTool).toHaveBeenNthCalledWith(1, 'tool_one', {});
    expect(mcpClient.callTool).toHaveBeenNthCalledWith(2, 'tool_two', {});
  });
});
