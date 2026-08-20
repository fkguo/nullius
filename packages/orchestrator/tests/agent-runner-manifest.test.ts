import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, _resetLaneQueue, type AgentEvent, type MessageParam, type Tool } from '../src/agent-runner.js';
import { RunManifestManager } from '../src/run-manifest.js';
import { createToolAttemptIdentity } from '../src/run-manifest.js';
import { buildDirectRuntimePermissionProfile } from '../src/runtime-permission-profile.js';
import type { McpClient, McpToolResult } from '../src/mcp-client.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-manifest-'));
}

function makeMockMcpClient(result: McpToolResult): McpClient {
  return {
    callTool: vi.fn(async () => result),
  } as unknown as McpClient;
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use' as const, id, name, input }],
    stop_reason: 'tool_use',
  };
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
  };
}

const TOOLS: Tool[] = [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }];

describe('AgentRunner durable execution checkpoints', () => {
  beforeEach(() => {
    _resetLaneQueue();
  });

  afterEach(() => {
    _resetLaneQueue();
    vi.restoreAllMocks();
  });

  it('persists a checkpoint after a successful tool call when manifestManager is provided', async () => {
    const tmpDir = makeTmpDir();
    try {
      const manifestManager = new RunManifestManager(path.join(tmpDir, 'runs'));
      const createFn = vi.fn()
        .mockResolvedValueOnce(toolUseResponse('tu_saved', 'do_thing'))
        .mockResolvedValueOnce(textResponse('done'));
      const runner = new AgentRunner({
        model: 'claude-opus-4-6',
        runId: 'run-save',
        approvalRunId: 'run-save',
        approvalProjectRoot: tmpDir,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'tool-result',
          json: null,
          errorCode: null,
        }),
        permissionProfile: buildDirectRuntimePermissionProfile({ tools: TOOLS }),
        manifestManager,
        _messagesCreate: createFn,
      });

      const events = await collectEvents(runner.run([{ role: 'user', content: 'go' }], TOOLS));
      const manifest = manifestManager.loadManifest('run-save');

      expect(events.find(event => event.type === 'tool_call')).toMatchObject({
        type: 'tool_call',
        name: 'do_thing',
        result: 'tool-result',
      });
      expect(manifest).not.toBeNull();
      expect(manifest?.last_completed_step).toBe('tu_saved');
      expect(manifest?.checkpoints).toHaveLength(1);
      expect(manifest?.checkpoints[0]).toMatchObject({
        step_id: 'tu_saved',
        tool_name: 'do_thing',
        outcome: { raw_text: 'tool-result', is_error: false },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists a checkpoint when replaying an incomplete tool_use during recovery', async () => {
    const tmpDir = makeTmpDir();
    try {
      const manifestManager = new RunManifestManager(path.join(tmpDir, 'runs'));
      const attempt = createToolAttemptIdentity({ stepId: 'tu_replay', toolName: 'do_thing', input: {} });
      manifestManager.observeToolIntents('run-recovery', [attempt]);
      const createFn = vi.fn().mockResolvedValueOnce(textResponse('resumed'));
      const runner = new AgentRunner({
        model: 'claude-opus-4-6',
        runId: 'run-recovery',
        approvalRunId: 'run-recovery',
        approvalProjectRoot: tmpDir,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'replayed-result',
          json: null,
          errorCode: null,
        }),
        permissionProfile: buildDirectRuntimePermissionProfile({ tools: TOOLS }),
        manifestManager,
        _messagesCreate: createFn,
      });

      const messages: MessageParam[] = [
        { role: 'user', content: 'resume' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_replay', name: 'do_thing', input: {} }],
        },
      ];

      await collectEvents(runner.run(messages, TOOLS));

      const manifest = manifestManager.loadManifest('run-recovery');
      expect(manifest?.last_completed_step).toBe('tu_replay');
      expect(manifest?.checkpoints[0]).toMatchObject({
        step_id: 'tu_replay',
        tool_name: 'do_thing',
        outcome: { raw_text: 'replayed-result', is_error: false },
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not call the transport or model when recovery finds outcome_unknown', async () => {
    const tmpDir = makeTmpDir();
    try {
      const manifestManager = new RunManifestManager(path.join(tmpDir, 'runs'));
      const attempt = createToolAttemptIdentity({ stepId: 'tu_unknown', toolName: 'do_thing', input: {} });
      manifestManager.observeToolIntents('run-unknown', [attempt]);
      manifestManager.markToolIntentsDispatched('run-unknown', [attempt]);
      const mcpClient = makeMockMcpClient({
        ok: true,
        isError: false,
        rawText: 'must-not-run',
        json: null,
        errorCode: null,
      });
      const createFn = vi.fn();
      const runner = new AgentRunner({
        model: 'claude-opus-4-6',
        runId: 'run-unknown',
        approvalRunId: 'run-unknown',
        approvalProjectRoot: tmpDir,
        mcpClient,
        permissionProfile: buildDirectRuntimePermissionProfile({ tools: TOOLS }),
        manifestManager,
        _messagesCreate: createFn,
      });
      const messages: MessageParam[] = [
        { role: 'user', content: 'resume' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_unknown', name: 'do_thing', input: {} }] },
      ];

      const events = await collectEvents(runner.run(messages, TOOLS));

      expect(mcpClient.callTool).not.toHaveBeenCalled();
      expect(createFn).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_outcome_unknown',
        stepId: 'tu_unknown',
        phase: 'recovery',
      }));
      expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_outcome_unknown' });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
