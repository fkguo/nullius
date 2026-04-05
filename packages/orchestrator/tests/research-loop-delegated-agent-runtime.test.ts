import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovalGate,
  executeDelegatedAgentRuntime,
  type MessageParam,
  type Tool,
} from '../src/index.js';
import type { McpClient, McpToolResult } from '../src/mcp-client.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-loop-agent-runtime-'));
}

function makeMockMcpClient(result: McpToolResult): { client: McpClient; callTool: ReturnType<typeof vi.fn> } {
  const callTool = vi.fn(async () => result);
  return {
    client: { callTool } as unknown as McpClient,
    callTool,
  };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use' as const, id, name, input }],
    stop_reason: 'tool_use',
  };
}

function textResponse(
  text: string,
  stopReason: 'end_turn' | 'max_tokens' = 'end_turn',
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number },
) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: stopReason,
    usage: usage ?? null,
  };
}

const TOOLS: Tool[] = [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }];

describe('executeDelegatedAgentRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a manifest through the shared runtime surface after a successful tool call', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createFn = vi.fn()
        .mockResolvedValueOnce(toolUseResponse('tu_live', 'do_thing'))
        .mockResolvedValueOnce(textResponse('done'));
      const mcpClient = makeMockMcpClient({
        ok: true,
        isError: false,
        rawText: 'tool-result',
        json: null,
        errorCode: null,
      });
      const result = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: 'run-live',
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        mcpClient: mcpClient.client,
        approvalGate: new ApprovalGate({}),
        _messagesCreate: createFn,
      });

      expect(result.events.find(event => event.type === 'tool_call')).toMatchObject({ type: 'tool_call', name: 'do_thing', result: 'tool-result' });
      expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(result.resumed).toBe(false);
      expect(result.skipped_step_ids).toEqual([]);
      expect(result.last_completed_step).toBe('tu_live');
      expect(result.manifest?.checkpoints[0]).toMatchObject({ step_id: 'tu_live', result_summary: 'tool-result' });
      expect(fs.existsSync(path.join(projectRoot, result.manifest_path))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, result.runtime_diagnostics_bridge_path))).toBe(true);
      expect(result.runtime_diagnostics_summary).toEqual({
        status: 'ok',
        primary_cause: 'none',
        recommended_action: 'none',
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('reuses checkpoints through the same shared runtime surface on resume', async () => {
    const projectRoot = makeTmpDir();
    try {
      const firstRun = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: 'run-resume',
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'cached-result',
          json: null,
          errorCode: null,
        }).client,
        approvalGate: new ApprovalGate({}),
        _messagesCreate: vi.fn()
          .mockResolvedValueOnce(toolUseResponse('tu_resume', 'do_thing'))
          .mockResolvedValueOnce(textResponse('done')),
      });
      expect(firstRun.last_completed_step).toBe('tu_resume');

      const resumedMessages: MessageParam[] = [
        { role: 'user', content: 'resume' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_resume', name: 'do_thing', input: {} }] },
      ];
      const resumedClient = makeMockMcpClient({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      });
      const resumed = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: 'run-resume',
        model: 'claude-opus-4-6',
        messages: resumedMessages,
        tools: TOOLS,
        mcpClient: resumedClient.client,
        approvalGate: new ApprovalGate({}),
        _messagesCreate: vi.fn().mockResolvedValueOnce(textResponse('resumed')),
      });

      expect(resumed.resumed).toBe(true);
      expect(resumed.resume_from).toBe('tu_resume');
      expect(resumed.skipped_step_ids).toEqual(['tu_resume']);
      expect(resumed.events.find(event => event.type === 'tool_call')).toMatchObject({
        type: 'tool_call',
        name: 'do_thing',
        result: 'cached-result',
      });
      expect(resumed.events.find(event => event.type === 'text')).toMatchObject({ type: 'text', text: 'resumed' });
      expect(resumedClient.callTool).not.toHaveBeenCalled();
      expect(resumed.last_completed_step).toBe('tu_resume');
      const diagnostics = JSON.parse(
        fs.readFileSync(path.join(projectRoot, resumed.runtime_diagnostics_bridge_path), 'utf-8'),
      ) as {
        evidence: { manifest: { path: string }; runtime_markers: unknown[] };
      };
      expect(diagnostics.evidence.manifest.path).toBe(resumed.manifest_path);
      expect(diagnostics.evidence.runtime_markers).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('surfaces auditable truncation recovery through the shared delegated runtime entrypoint', async () => {
    const projectRoot = makeTmpDir();
    try {
      const result = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: 'run-truncation-live',
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'finish the report' }],
        tools: TOOLS,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'unused',
          json: null,
          errorCode: null,
        }).client,
        approvalGate: new ApprovalGate({}),
        _messagesCreate: vi.fn()
          .mockResolvedValueOnce(textResponse('partial', 'max_tokens', { input_tokens: 90, output_tokens: 60, total_tokens: 150 }))
          .mockResolvedValueOnce(textResponse('complete')),
      });

      expect(result.events).toContainEqual({ type: 'text', text: 'partial' });
      expect(result.events).toContainEqual(expect.objectContaining({
        type: 'runtime_marker',
        kind: 'truncation_retry',
        detail: expect.objectContaining({ attempt: 1 }),
      }));
      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 2 });
      expect(result.runtime_diagnostics_summary).toEqual({
        status: 'degraded',
        primary_cause: 'truncation',
        recommended_action: 'compact_or_reduce_context',
      });
      const diagnostics = JSON.parse(
        fs.readFileSync(path.join(projectRoot, result.runtime_diagnostics_bridge_path), 'utf-8'),
      ) as {
        evidence: { spans: { path: string; exists: boolean }; terminal_event: { stop_reason?: string } | null };
      };
      expect(diagnostics.evidence.spans.path).toBe(result.spans_path);
      expect(diagnostics.evidence.spans.exists).toBe(false);
      expect(diagnostics.evidence.terminal_event?.stop_reason).toBe('end_turn');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
