import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner, _resetLaneQueue, type AgentEvent, type MessageParam, type Tool } from '../src/agent-runner.js';
import { RunManifestManager } from '../src/run-manifest.js';
import type { ApprovalGate } from '../src/approval-gate.js';
import type { McpClient, McpToolResult } from '../src/mcp-client.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-manifest-'));
}

function makeMockMcpClient(result: McpToolResult): McpClient {
  return {
    callTool: vi.fn(async () => result),
  } as unknown as McpClient;
}

function makeMockApprovalGate(): ApprovalGate {
  return {} as ApprovalGate;
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
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'tool-result',
          json: null,
          errorCode: null,
        }),
        approvalGate: makeMockApprovalGate(),
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
        result_summary: 'tool-result',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists a checkpoint when replaying an incomplete tool_use during recovery', async () => {
    const tmpDir = makeTmpDir();
    try {
      const manifestManager = new RunManifestManager(path.join(tmpDir, 'runs'));
      const createFn = vi.fn().mockResolvedValueOnce(textResponse('resumed'));
      const runner = new AgentRunner({
        model: 'claude-opus-4-6',
        runId: 'run-recovery',
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'replayed-result',
          json: null,
          errorCode: null,
        }),
        approvalGate: makeMockApprovalGate(),
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
        result_summary: 'replayed-result',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
