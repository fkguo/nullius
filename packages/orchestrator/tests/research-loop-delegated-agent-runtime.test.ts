import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeDelegatedAgentRuntime,
  type MessageParam,
  type Tool,
} from '../src/index.js';
import { buildDelegatedRuntimeHandleV1 } from '../src/delegated-runtime-handle.js';
import { buildDelegatedExecutionIdentity } from '../src/execution-identity.js';
import type { McpClient, McpToolResult } from '../src/mcp-client.js';
import { buildDirectRuntimePermissionProfile } from '../src/runtime-permission-profile.js';
import { createToolAttemptIdentity, RunManifestManager } from '../src/run-manifest.js';

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

function directPermissionProfile(tools: Tool[] = TOOLS) {
  return buildDirectRuntimePermissionProfile({ tools });
}

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
        permissionProfile: directPermissionProfile(),
        _messagesCreate: createFn,
      });

      expect(result.events.find(event => event.type === 'tool_call')).toMatchObject({ type: 'tool_call', name: 'do_thing', result: 'tool-result' });
      expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(result.resumed).toBe(false);
      expect(result.skipped_step_ids).toEqual([]);
      expect(result.last_completed_step).toBe('tu_live');
      expect(result.runtime_projection).toMatchObject({
        turn_count: 2,
        projected_turns: [
          {
            phase: 'dialogue',
            turn_count: 1,
            tool_call_count: 1,
            text_count: 0,
          },
          {
            phase: 'dialogue',
            turn_count: 2,
            tool_call_count: 0,
            text_count: 1,
            terminal_outcome: {
              type: 'done',
              turn_count: 2,
              stop_reason: 'end_turn',
            },
          },
        ],
      });
      expect(result.manifest?.checkpoints[0]).toMatchObject({
        step_id: 'tu_live',
        tool_name: 'do_thing',
        outcome: { raw_text: 'tool-result', is_error: false },
      });
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

  it('keeps root, direct-agent, and team-derived journals in disjoint namespaces', async () => {
    const projectRoot = makeTmpDir();
    try {
      const derived = buildDelegatedExecutionIdentity({
        project_run_id: 'root-run',
        assignment_id: 'assignment',
      });
      const rootRuns = new RunManifestManager(path.join(projectRoot, 'artifacts', 'runs'));
      const rootAttempt = createToolAttemptIdentity({
        stepId: 'tu_namespace',
        toolName: 'do_thing',
        input: {},
      });
      rootRuns.observeToolIntents(derived.runtime_run_id, [rootAttempt]);
      rootRuns.markToolIntentsDispatched(derived.runtime_run_id, [rootAttempt]);
      rootRuns.commitToolAttempt(derived.runtime_run_id, rootAttempt, {
        ok: true,
        isError: false,
        rawText: 'root-namespace-result',
        json: null,
        errorCode: null,
      });

      const delegatedClient = makeMockMcpClient({
        ok: true,
        isError: false,
        rawText: 'delegated-result',
        json: null,
        errorCode: null,
      });
      const result = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: derived.runtime_run_id,
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'execute in delegated namespace' }],
        tools: TOOLS,
        mcpClient: delegatedClient.client,
        permissionProfile: directPermissionProfile(),
        _messagesCreate: vi.fn()
          .mockResolvedValueOnce(toolUseResponse('tu_namespace', 'do_thing'))
          .mockResolvedValueOnce(textResponse('done')),
      });

      expect(delegatedClient.callTool).toHaveBeenCalledOnce();
      expect(result.manifest_path).toBe(
        `artifacts/delegated-runs/direct/${derived.runtime_run_id}/manifest.json`,
      );
      expect(result.manifest?.checkpoints[0]?.outcome.raw_text).toBe('delegated-result');
      expect(rootRuns.loadManifest(derived.runtime_run_id)?.checkpoints[0]?.outcome.raw_text)
        .toBe('root-namespace-result');

      const handle = buildDelegatedRuntimeHandleV1({
        project_run_id: 'root-run',
        assignment_id: 'assignment',
        session_id: 'session',
        task_id: 'task',
        checkpoint_id: null,
        parent_session_id: null,
        forked_from_assignment_id: null,
        forked_from_session_id: null,
      });
      expect(handle.identity.runtime_run_id).toBe(derived.runtime_run_id);
      const teamClient = makeMockMcpClient({
        ok: true,
        isError: false,
        rawText: 'team-result',
        json: null,
        errorCode: null,
      });
      const teamResult = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: handle.identity.runtime_run_id,
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'execute in team namespace' }],
        tools: TOOLS,
        mcpClient: teamClient.client,
        permissionProfile: directPermissionProfile(),
        delegated_runtime_handle: handle,
        _messagesCreate: vi.fn()
          .mockResolvedValueOnce(toolUseResponse('tu_namespace', 'do_thing'))
          .mockResolvedValueOnce(textResponse('done')),
      });

      expect(teamClient.callTool).toHaveBeenCalledOnce();
      expect(teamResult.manifest_path).toBe(
        `artifacts/delegated-runs/team/${derived.runtime_run_id}/manifest.json`,
      );
      expect(teamResult.manifest?.checkpoints[0]?.outcome.raw_text).toBe('team-result');
      expect(result.manifest?.checkpoints[0]?.outcome.raw_text).toBe('delegated-result');
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
        permissionProfile: directPermissionProfile(),
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
        permissionProfile: directPermissionProfile(),
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
      expect(resumed.runtime_projection).toMatchObject({
        turn_count: 1,
        recovery_turn_count: 1,
        dialogue_turn_count: 1,
        projected_turns: [
          {
            phase: 'recovery',
            turn_count: 0,
            tool_call_count: 1,
            text_count: 0,
          },
          {
            phase: 'dialogue',
            turn_count: 1,
            text_count: 1,
            terminal_outcome: {
              type: 'done',
              turn_count: 1,
              stop_reason: 'end_turn',
            },
          },
        ],
      });
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

  it('accepts delegated runtime handle refs and keeps runtime artifacts canonical', async () => {
    const projectRoot = makeTmpDir();
    try {
      const handle = buildDelegatedRuntimeHandleV1({
        project_run_id: 'run-handle',
        assignment_id: 'assignment-handle',
        session_id: 'session-handle',
        task_id: 'task-handle',
        checkpoint_id: null,
        parent_session_id: null,
        forked_from_assignment_id: null,
        forked_from_session_id: null,
      });
      const result = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: handle.identity.runtime_run_id,
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'use-handle' }],
        tools: TOOLS,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'tool-result',
          json: null,
          errorCode: null,
        }).client,
        permissionProfile: directPermissionProfile(),
        delegated_runtime_handle: handle,
        _messagesCreate: vi.fn().mockResolvedValueOnce(textResponse('done')),
      });

      expect(result.manifest_path).toBe(handle.artifacts.manifest_path);
      expect(result.spans_path).toBe(handle.artifacts.spans_path);
      expect(result.runtime_diagnostics_bridge_path).toBe(handle.artifacts.runtime_diagnostics_bridge_path);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when delegated runtime handle run id mismatches input run id', async () => {
    const projectRoot = makeTmpDir();
    try {
      const handle = buildDelegatedRuntimeHandleV1({
        project_run_id: 'run-handle',
        assignment_id: 'assignment-handle',
        session_id: 'session-handle',
        task_id: 'task-handle',
        checkpoint_id: null,
        parent_session_id: null,
        forked_from_assignment_id: null,
        forked_from_session_id: null,
      });

      await expect(executeDelegatedAgentRuntime({
        projectRoot,
        runId: 'run-mismatch',
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'use-handle' }],
        tools: TOOLS,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'tool-result',
          json: null,
          errorCode: null,
        }).client,
        permissionProfile: directPermissionProfile(),
        delegated_runtime_handle: handle,
        _messagesCreate: vi.fn().mockResolvedValueOnce(textResponse('done')),
      })).rejects.toThrow('delegated runtime handle run id mismatch');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates delegated runtime handle identity before starting the model or writing runtime state', async () => {
    const projectRoot = makeTmpDir();
    try {
      const handle = buildDelegatedRuntimeHandleV1({
        project_run_id: 'run-handle',
        assignment_id: 'assignment-handle',
        session_id: 'session-handle',
        task_id: 'task-handle',
        checkpoint_id: null,
        parent_session_id: null,
        forked_from_assignment_id: null,
        forked_from_session_id: null,
      });
      const createFn = vi.fn().mockResolvedValueOnce(textResponse('must-not-run'));

      await expect(executeDelegatedAgentRuntime({
        projectRoot,
        runId: handle.identity.runtime_run_id,
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'use-handle' }],
        tools: TOOLS,
        mcpClient: makeMockMcpClient({
          ok: true,
          isError: false,
          rawText: 'must-not-run',
          json: null,
          errorCode: null,
        }).client,
        permissionProfile: directPermissionProfile(),
        delegated_runtime_handle: {
          ...handle,
          identity: { ...handle.identity, assignment_id: 'forged-assignment' },
        },
        _messagesCreate: createFn,
      })).rejects.toThrow('identity.runtime_run_id is not canonical');

      expect(createFn).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(projectRoot, 'artifacts'))).toBe(false);
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
        permissionProfile: directPermissionProfile(),
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
      expect(result.runtime_projection).toMatchObject({
        turn_count: 2,
        runtime_marker_kinds: ['truncation_retry'],
        projected_turns: [
          {
            phase: 'dialogue',
            turn_count: 1,
            text_count: 1,
            runtime_marker_kinds: ['truncation_retry'],
          },
          {
            phase: 'dialogue',
            turn_count: 2,
            text_count: 1,
            terminal_outcome: {
              type: 'done',
              turn_count: 2,
              stop_reason: 'end_turn',
            },
          },
        ],
      });
      expect(result.runtime_diagnostics_summary).toEqual({
        status: 'degraded',
        primary_cause: 'truncation',
        recommended_action: 'compact_or_reduce_context',
      });
      const diagnostics = JSON.parse(
        fs.readFileSync(path.join(projectRoot, result.runtime_diagnostics_bridge_path), 'utf-8'),
      ) as {
        evidence: {
          spans: { path: string; exists: boolean };
          terminal_event: { stop_reason?: string; turn_count?: number; phase?: string } | null;
          runtime_markers: Array<{ phase: string; kind: string; turn_count: number }>;
        };
      };
      expect(diagnostics.evidence.spans.path).toBe(result.spans_path);
      expect(diagnostics.evidence.spans.exists).toBe(false);
      expect(diagnostics.evidence.runtime_markers).toMatchObject([
        { phase: 'dialogue', kind: 'truncation_retry', turn_count: 1 },
      ]);
      expect(diagnostics.evidence.terminal_event?.phase).toBe('dialogue');
      expect(diagnostics.evidence.terminal_event?.turn_count).toBe(2);
      expect(diagnostics.evidence.terminal_event?.stop_reason).toBe('end_turn');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes operator diagnostics and stops when a recovered tool outcome is unknown', async () => {
    const projectRoot = makeTmpDir();
    try {
      const manager = new RunManifestManager(path.join(projectRoot, 'artifacts', 'delegated-runs', 'direct'));
      const attempt = createToolAttemptIdentity({ stepId: 'tu-unknown', toolName: 'do_thing', input: {} });
      manager.observeToolIntents('run-unknown', [attempt]);
      manager.markToolIntentsDispatched('run-unknown', [attempt]);
      const client = makeMockMcpClient({
        ok: true,
        isError: false,
        rawText: 'must-not-run',
        json: null,
        errorCode: null,
      });
      const createFn = vi.fn();

      const result = await executeDelegatedAgentRuntime({
        projectRoot,
        runId: 'run-unknown',
        model: 'claude-opus-4-6',
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-unknown', name: 'do_thing', input: {} }] },
        ],
        tools: TOOLS,
        mcpClient: client.client,
        permissionProfile: directPermissionProfile(),
        _messagesCreate: createFn,
      });

      expect(client.callTool).not.toHaveBeenCalled();
      expect(createFn).not.toHaveBeenCalled();
      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_outcome_unknown' });
      expect(result.runtime_diagnostics_summary).toEqual({
        status: 'needs_recovery',
        primary_cause: 'tool_outcome_unknown',
        recommended_action: 'inspect_external_state_before_resume',
      });
      const diagnostics = JSON.parse(
        fs.readFileSync(path.join(projectRoot, result.runtime_diagnostics_bridge_path), 'utf-8'),
      ) as { evidence: { manifest: { outcome_unknown_count: number; outcome_unknown_step_ids: string[] } } };
      expect(diagnostics.evidence.manifest).toMatchObject({
        outcome_unknown_count: 1,
        outcome_unknown_step_ids: ['tu-unknown'],
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
