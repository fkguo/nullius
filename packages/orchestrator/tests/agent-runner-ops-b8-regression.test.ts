import { ORCH_RUN_EXECUTE_MANIFEST } from '@nullius/shared';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveIncompleteToolUses } from '../src/agent-runner-ops.js';
import type { MessageParam, Tool } from '../src/backends/chat-backend.js';
import type { McpToolResult, ToolCaller } from '../src/mcp-client.js';
import { createToolAttemptIdentity, RunManifestManager } from '../src/run-manifest.js';
import { buildDirectRuntimePermissionProfile } from '../src/runtime-permission-profile.js';
import { buildRuntimeToolPermissionView } from '../src/tool-execution-policy.js';

function assistantBatch(blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>): MessageParam {
  return {
    role: 'assistant',
    content: blocks.map(block => ({ type: 'tool_use' as const, ...block, input: block.input ?? {} })),
  };
}

function ok(text: string): McpToolResult {
  return { ok: true, isError: false, rawText: text, json: null, errorCode: null };
}

function approval(): McpToolResult {
  const json = {
    status: 'requires_approval',
    requires_approval: true,
    gate_id: 'A3',
    run_id: 'run-b8',
    approval_id: 'A3-0001',
    packet_path: 'artifacts/runs/run-b8/approval.json',
    approval_packet_sha256: 'a'.repeat(64),
  };
  return { ok: true, isError: false, rawText: JSON.stringify(json), json, errorCode: null };
}

function countToolResults(messages: MessageParam[]): number {
  return messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result').length;
}

describe('durable recovery batch is all-or-nothing', () => {
  let tmpDir: string;
  let manager: RunManifestManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-b8-'));
    manager = new RunManifestManager(path.join(tmpDir, 'runs'));
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function runtime(tools: Tool[]) {
    return {
      runId: 'run-b8',
      approvalRunId: 'run-b8',
      approvalProjectRoot: '/project',
      manifestManager: manager,
      permissionView: buildRuntimeToolPermissionView(buildDirectRuntimePermissionProfile({ tools })),
    };
  }

  function observe(id: string, name: string, input: Record<string, unknown> = {}) {
    const identity = createToolAttemptIdentity({ stepId: id, toolName: name, input });
    manager.observeToolIntents('run-b8', [identity]);
    return identity;
  }

  it('does not inject a cached result when a later call reaches a real run gate', async () => {
    const cached = observe('tu-cached', 'cached_tool');
    manager.markToolIntentsDispatched('run-b8', [cached]);
    manager.commitToolAttempt('run-b8', cached, ok('cached-value'));
    observe('tu-approval', ORCH_RUN_EXECUTE_MANIFEST, { run_id: 'run-b8', project_root: '/project' });
    const messages: MessageParam[] = [
      { role: 'user', content: 'resume' },
      assistantBatch([
        { id: 'tu-cached', name: 'cached_tool' },
        {
          id: 'tu-approval',
          name: ORCH_RUN_EXECUTE_MANIFEST,
          input: { run_id: 'run-b8', project_root: '/project' },
        },
      ]),
    ];
    const mcpClient: ToolCaller = { callTool: vi.fn(async () => approval()) };
    const tools: Tool[] = [
      { name: 'cached_tool', input_schema: { type: 'object', properties: {} } },
      { name: ORCH_RUN_EXECUTE_MANIFEST, input_schema: { type: 'object', properties: {} } },
    ];

    const result = await resolveIncompleteToolUses({ messages, mcpClient, ...runtime(tools) });

    expect(result?.done).toBe(true);
    expect(result?.messages).toEqual(messages);
    expect(countToolResults(result!.messages)).toBe(0);
    expect(result?.events).toContainEqual(expect.objectContaining({
      type: 'approval_required',
      authority: 'run_gate',
      approvalId: 'A3-0001',
    }));
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(manager.classifyToolAttempt('run-b8', createToolAttemptIdentity({
      stepId: 'tu-approval',
      toolName: ORCH_RUN_EXECUTE_MANIFEST,
      input: { run_id: 'run-b8', project_root: '/project' },
    }))).toMatchObject({ state: 'not_started' });
  });

  it('injects committed and newly committed results together when the batch is known', async () => {
    const cached = observe('tu-cached', 'cached_tool');
    manager.markToolIntentsDispatched('run-b8', [cached]);
    manager.commitToolAttempt('run-b8', cached, ok('cached-value'));
    observe('tu-fresh', 'fresh_tool');
    const messages: MessageParam[] = [
      { role: 'user', content: 'resume' },
      assistantBatch([
        { id: 'tu-cached', name: 'cached_tool' },
        { id: 'tu-fresh', name: 'fresh_tool' },
      ]),
    ];
    const mcpClient: ToolCaller = { callTool: vi.fn(async () => ok('fresh-value')) };
    const tools: Tool[] = ['cached_tool', 'fresh_tool'].map(name => ({
      name, input_schema: { type: 'object', properties: {} },
    }));

    const result = await resolveIncompleteToolUses({ messages, mcpClient, ...runtime(tools) });

    expect(result?.done).toBe(false);
    expect(countToolResults(result!.messages)).toBe(2);
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
  });

  it('fails closed before transport when a recovery block lacks durable intent', async () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'resume' },
      assistantBatch([{ id: 'tu-missing', name: 'missing_tool' }]),
    ];
    const mcpClient: ToolCaller = { callTool: vi.fn(async () => ok('must-not-run')) };
    const tools: Tool[] = [{ name: 'missing_tool', input_schema: { type: 'object', properties: {} } }];

    const result = await resolveIncompleteToolUses({ messages, mcpClient, ...runtime(tools) });

    expect(result?.events).toContainEqual(expect.objectContaining({
      type: 'tool_outcome_unknown', reason: 'missing_durable_intent',
    }));
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it('preflights the full batch and calls nothing when any member is outcome_unknown', async () => {
    observe('tu-first', 'first_tool');
    const unknown = observe('tu-unknown', 'unknown_tool');
    manager.markToolIntentsDispatched('run-b8', [unknown]);
    const messages: MessageParam[] = [
      { role: 'user', content: 'resume' },
      assistantBatch([
        { id: 'tu-first', name: 'first_tool' },
        { id: 'tu-unknown', name: 'unknown_tool' },
      ]),
    ];
    const mcpClient: ToolCaller = { callTool: vi.fn(async () => ok('must-not-run')) };
    const tools: Tool[] = ['first_tool', 'unknown_tool'].map(name => ({
      name, input_schema: { type: 'object', properties: {} },
    }));

    const result = await resolveIncompleteToolUses({ messages, mcpClient, ...runtime(tools) });

    expect(result?.events).toContainEqual(expect.objectContaining({
      type: 'tool_outcome_unknown', stepId: 'tu-unknown',
    }));
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });
});
