import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_CREATE,
  ORCH_RUN_EXECUTE_MANIFEST,
  ORCH_RUN_LIST,
  ORCH_RUN_STATUS,
} from '@nullius/shared';
import {
  AgentRunner,
  _resetLaneQueue,
  type AgentEvent,
  type AgentRunnerOptions,
  type MessageParam,
  type Tool,
} from '../src/agent-runner.js';
import type { McpClient, McpToolResult } from '../src/mcp-client.js';
import { buildDirectRuntimePermissionProfile } from '../src/runtime-permission-profile.js';
import { createToolAttemptIdentity, RunManifestManager } from '../src/run-manifest.js';

// ─── Minimal mocks ────────────────────────────────────────────────────────────

function makeMockMcpClient(
  toolResults: Record<string, McpToolResult | (() => McpToolResult)> = {},
): McpClient {
  return {
    callTool: vi.fn(async (name: string) => {
      const val = toolResults[name];
      if (val === undefined) {
        return { ok: true, isError: false, rawText: `result:${name}`, json: null, errorCode: null };
      }
      return typeof val === 'function' ? val() : val;
    }),
  } as unknown as McpClient;
}

function textResponse(
  text: string,
  stopReason: 'end_turn' | 'stop_sequence' | 'max_tokens' | 'tool_use' | 'weird_reason' = 'end_turn',
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number },
) {
  return { content: [{ type: 'text' as const, text }], stop_reason: stopReason, usage: usage ?? null };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use' as const, id, name, input }],
    stop_reason: 'tool_use',
  };
}

function multiToolUseResponse(blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>) {
  return {
    content: blocks.map(block => ({
      type: 'tool_use' as const,
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    })),
    stop_reason: 'tool_use',
  };
}

const TOOLS: Tool[] = [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }];

const DEFAULT_PERMISSION_TOOL_NAMES = [
  'do_thing',
  'side_effect_tool',
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_CREATE,
  ORCH_RUN_EXECUTE_MANIFEST,
  ORCH_RUN_LIST,
  ORCH_RUN_STATUS,
];

function toolDefinition(name: string): Tool {
  return { name, input_schema: { type: 'object', properties: {} } };
}

function approvalEnvelope(params: {
  runId: string;
  approvalId: string;
  packetPath: string;
  gateId?: string;
  digestCharacter?: string;
}): Record<string, unknown> {
  return {
    status: 'requires_approval',
    requires_approval: true,
    gate_id: params.gateId ?? 'A3',
    run_id: params.runId,
    approval_id: params.approvalId,
    packet_path: params.packetPath,
    approval_packet_sha256: (params.digestCharacter ?? 'a').repeat(64),
  };
}

function resultWithJson(json: Record<string, unknown>): McpToolResult {
  return {
    ok: true,
    isError: false,
    rawText: JSON.stringify(json),
    json,
    errorCode: null,
  };
}

type TestRunnerOptions = Omit<AgentRunnerOptions, 'manifestManager' | 'permissionProfile' | 'approvalRunId' | 'approvalProjectRoot'> & {
  allowedToolNames?: string[];
  manifestManager?: RunManifestManager;
  approvalRunId?: string;
  approvalProjectRoot?: string;
};

let testRunsDir = '';

function makeRunner(options: TestRunnerOptions): AgentRunner {
  const {
    allowedToolNames = DEFAULT_PERMISSION_TOOL_NAMES,
    manifestManager = new RunManifestManager(testRunsDir),
    approvalRunId,
    approvalProjectRoot = '/project',
    ...runnerOptions
  } = options;
  return new AgentRunner({
    ...runnerOptions,
    approvalRunId: approvalRunId ?? runnerOptions.runId,
    approvalProjectRoot,
    permissionProfile: buildDirectRuntimePermissionProfile({
      tools: allowedToolNames.map(name => ({ name })),
    }),
    manifestManager,
  });
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRunner', () => {
  beforeEach(() => {
    _resetLaneQueue();
    testRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-test-'));
  });

  afterEach(() => {
    _resetLaneQueue();
    vi.restoreAllMocks();
    fs.rmSync(testRunsDir, { recursive: true, force: true });
    testRunsDir = '';
  });

  it('single-turn text response emits text + done events', async () => {
    const createFn = vi.fn().mockResolvedValue(textResponse('Hello world'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-1',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'Hi' }];
    const events = await collectEvents(runner.run(messages, TOOLS));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(events[1]).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 1 });
    expect(runner.runtimeProjection).toEqual({
      version: 1,
      turn_count: 1,
      recovery_turn_count: 0,
      dialogue_turn_count: 1,
      projected_turns: [{
        phase: 'dialogue',
        turn_count: 1,
        text_count: 1,
        tool_call_count: 0,
        runtime_marker_kinds: [],
        approval_requested: false,
        terminal_outcome: {
          type: 'done',
          phase: 'dialogue',
          turn_count: 1,
          stop_reason: 'end_turn',
        },
      }],
      runtime_marker_kinds: [],
      approval_requested: false,
      terminal_outcome: {
        type: 'done',
        phase: 'dialogue',
        turn_count: 1,
        stop_reason: 'end_turn',
      },
    });
  });

  it('multi-turn: tool call followed by final text response', async () => {
    const mcpClient = makeMockMcpClient({
      do_thing: { ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null },
    });
    const createFn = vi.fn()
      .mockResolvedValueOnce(toolUseResponse('tu_1', 'do_thing'))
      .mockResolvedValueOnce(textResponse('All done'));

    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-2',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Start' }], TOOLS));

    const toolCallEvt = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvt).toMatchObject({ type: 'tool_call', name: 'do_thing' });

    const textEvt = events.find((e) => e.type === 'text');
    expect(textEvt).toMatchObject({ type: 'text', text: 'All done' });

    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 2 });
    expect(runner.runtimeProjection?.projected_turns).toMatchObject([
      {
        phase: 'dialogue',
        turn_count: 1,
        text_count: 0,
        tool_call_count: 1,
        runtime_marker_kinds: [],
        approval_requested: false,
        terminal_outcome: null,
      },
      {
        phase: 'dialogue',
        turn_count: 2,
        text_count: 1,
        tool_call_count: 0,
        runtime_marker_kinds: [],
        approval_requested: false,
        terminal_outcome: {
          type: 'done',
          phase: 'dialogue',
          turn_count: 2,
          stop_reason: 'end_turn',
        },
      },
    ]);

    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('runs contiguous batch-safe read-only tool groups in parallel while keeping tool-call event order stable', async () => {
    let resolveStatus!: (value: McpToolResult) => void;
    let resolveList!: (value: McpToolResult) => void;
    const statusResult = new Promise<McpToolResult>(resolve => { resolveStatus = resolve; });
    const listResult = new Promise<McpToolResult>(resolve => { resolveList = resolve; });
    const started: string[] = [];
    const mcpClient = {
      callTool: vi.fn((name: string) => {
        started.push(name);
        if (name === ORCH_RUN_STATUS) return statusResult;
        if (name === ORCH_RUN_LIST) return listResult;
        return Promise.resolve({ ok: true, isError: false, rawText: `result:${name}`, json: null, errorCode: null });
      }),
    } as unknown as McpClient;
    const createFn = vi.fn()
      .mockResolvedValueOnce(multiToolUseResponse([
        { id: 'tu_status', name: ORCH_RUN_STATUS },
        { id: 'tu_list', name: ORCH_RUN_LIST },
      ]))
      .mockResolvedValueOnce(textResponse('Parallel tools complete'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-batch-safe-group',
      mcpClient,
      _messagesCreate: createFn,
    });
    const runtimePromise = collectEvents(runner.run([{ role: 'user', content: 'Inspect the runs' }], [
      { name: ORCH_RUN_STATUS, input_schema: { type: 'object', properties: {} } },
      { name: ORCH_RUN_LIST, input_schema: { type: 'object', properties: {} } },
    ]));

    for (let attempt = 0; attempt < 20 && started.length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(started).toEqual([ORCH_RUN_STATUS, ORCH_RUN_LIST]);

    resolveList({ ok: true, isError: false, rawText: 'list-result', json: null, errorCode: null });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(createFn).toHaveBeenCalledTimes(1);

    resolveStatus({ ok: true, isError: false, rawText: 'status-result', json: null, errorCode: null });
    const events = await runtimePromise;

    expect(events.filter(event => event.type === 'tool_call')).toMatchObject([
      { type: 'tool_call', name: ORCH_RUN_STATUS, result: 'status-result' },
      { type: 'tool_call', name: ORCH_RUN_LIST, result: 'list-result' },
    ]);
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('keeps mixed mutation and batch-safe tool groups serial-only', async () => {
    let resolveStatus!: (value: McpToolResult) => void;
    const statusResult = new Promise<McpToolResult>(resolve => { resolveStatus = resolve; });
    const started: string[] = [];
    const mcpClient = {
      callTool: vi.fn((name: string) => {
        started.push(name);
        if (name === ORCH_RUN_STATUS) {
          return statusResult;
        }
        return Promise.resolve({ ok: true, isError: false, rawText: `result:${name}`, json: null, errorCode: null });
      }),
    } as unknown as McpClient;
    const createFn = vi.fn()
      .mockResolvedValueOnce(multiToolUseResponse([
        { id: 'tu_status', name: ORCH_RUN_STATUS },
        { id: 'tu_create', name: ORCH_RUN_CREATE },
        { id: 'tu_list', name: ORCH_RUN_LIST },
      ]))
      .mockResolvedValueOnce(textResponse('Mixed tools complete'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-mixed-grouping',
      mcpClient,
      _messagesCreate: createFn,
    });
    const runtimePromise = collectEvents(runner.run([{ role: 'user', content: 'Do the mixed work' }], [
      { name: ORCH_RUN_STATUS, input_schema: { type: 'object', properties: {} } },
      { name: ORCH_RUN_CREATE, input_schema: { type: 'object', properties: {} } },
      { name: ORCH_RUN_LIST, input_schema: { type: 'object', properties: {} } },
    ]));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual([ORCH_RUN_STATUS]);

    resolveStatus({ ok: true, isError: false, rawText: 'status-result', json: null, errorCode: null });
    await runtimePromise;

    expect(started).toEqual([ORCH_RUN_STATUS, ORCH_RUN_CREATE, ORCH_RUN_LIST]);
  });

  it('routing config: direct route key resolves to backend model', async () => {
    const createFn = vi.fn().mockResolvedValue(textResponse('routed'));
    const runner = makeRunner({
      model: 'fast',
      runId: 'run-route-direct',
      mcpClient: makeMockMcpClient(),
      routingConfig: {
        version: 1,
        default_route: 'fast',
        routes: {
          fast: { backend: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 2048 },
        },
        use_cases: {},
      },
      _messagesCreate: createFn,
    });

    await collectEvents(runner.run([{ role: 'user', content: 'route me' }], TOOLS));

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
    });
  });



  it('default routing config uses the shared default max token budget', async () => {
    const createFn = vi.fn().mockResolvedValue(textResponse('default-route'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-route-default-budget',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    await collectEvents(runner.run([{ role: 'user', content: 'default budget' }], TOOLS));

    expect(createFn.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
    });
  });

  it('routing config: use-case alias resolves via JSON loader', async () => {
    const createFn = vi.fn().mockResolvedValue(textResponse('aliased'));
    const runner = makeRunner({
      model: 'analysis',
      runId: 'run-route-alias',
      mcpClient: makeMockMcpClient(),
      routingConfig: JSON.stringify({
        version: 1,
        default_route: 'balanced',
        routes: {
          balanced: { backend: 'anthropic', model: 'claude-opus-4-6', max_tokens: 4096 },
        },
        use_cases: { analysis: 'balanced' },
      }),
      _messagesCreate: createFn,
    });

    await collectEvents(runner.run([{ role: 'user', content: 'alias me' }], TOOLS));

    expect(createFn.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
    });
  });

  it('routing config: unknown route key fails closed', async () => {
    expect(() => makeRunner({
      model: 'missing',
      runId: 'run-route-missing',
      mcpClient: makeMockMcpClient(),
      routingConfig: {
        version: 1,
        default_route: 'default',
        routes: {
          default: { backend: 'anthropic', model: 'claude-sonnet-4-6' },
        },
        use_cases: {},
      },
      _messagesCreate: vi.fn(),
    })).toThrow(/Unknown route key/);
  });

  it('routing config: invalid JSON and unknown backend fail closed', async () => {
    expect(() => makeRunner({
      model: 'default',
      runId: 'run-route-json',
      mcpClient: makeMockMcpClient(),
      routingConfig: '{bad json',
      _messagesCreate: vi.fn(),
    })).toThrow(/Invalid routing config JSON/);

    expect(() => makeRunner({
      model: 'default',
      runId: 'run-route-backend',
      mcpClient: makeMockMcpClient(),
      routingConfig: {
        version: 1,
        default_route: 'default',
        routes: {
          default: { backend: 'unknown', model: 'x' },
        },
        use_cases: {},
      },
      _messagesCreate: vi.fn(),
    })).toThrow();
  });

  it('maxTurns enforcement: emits done with max_turns stopReason', async () => {
    // Always return a tool_use so the loop never terminates on its own
    let responseCount = 0;
    const createFn = vi.fn().mockImplementation(() => {
      responseCount += 1;
      return Promise.resolve(toolUseResponse(`tu_${responseCount}`, 'do_thing'));
    });
    let callCount = 0;
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      maxTurns: 3,
      runId: 'run-maxturn',
      mcpClient: makeMockMcpClient({
        do_thing: () => {
          callCount += 1;
          return { ok: true, isError: false, rawText: `result-${callCount}`, json: null, errorCode: null };
        },
      }),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Go' }], TOOLS));

    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'max_turns', turnCount: 3 });
    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it('stops after repeated low-gain tool turns and keeps the guard auditable', async () => {
    const mcpClient = makeMockMcpClient({
      do_thing: { ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null },
    });
    const createFn = vi.fn()
      .mockResolvedValueOnce(toolUseResponse('tu_1', 'do_thing'))
      .mockResolvedValueOnce(toolUseResponse('tu_2', 'do_thing'))
      .mockResolvedValueOnce(toolUseResponse('tu_3', 'do_thing'))
      .mockResolvedValueOnce(textResponse('unexpected completion'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      maxTurns: 10,
      runId: 'run-diminishing-returns',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'loop until stopped' }], TOOLS));

    expect(createFn).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'diminishing_returns', turnCount: 3 });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'low_gain_turn',
      turnCount: 1,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'low_gain_turn',
      turnCount: 2,
      detail: expect.objectContaining({ low_gain_streak: 1 }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'diminishing_returns_stop',
      turnCount: 3,
    }));
  });

  it('stops after consecutive all-error tool turns and keeps the guard auditable', async () => {
    const mcpClient = makeMockMcpClient({
      do_thing: { ok: false, isError: true, rawText: 'tool-error', json: null, errorCode: null },
    });
    const createFn = vi.fn()
      .mockResolvedValueOnce(toolUseResponse('tu_1', 'do_thing'))
      .mockResolvedValueOnce(toolUseResponse('tu_2', 'do_thing'))
      .mockResolvedValueOnce(textResponse('unexpected completion'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      maxTurns: 10,
      runId: 'run-diminishing-returns-all-errors',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'keep failing' }], TOOLS));

    expect(createFn).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'diminishing_returns', turnCount: 2 });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'low_gain_turn',
      turnCount: 1,
      detail: expect.objectContaining({ reason: 'all_tools_errored', low_gain_streak: 1 }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'diminishing_returns_stop',
      turnCount: 2,
    }));
  });

  it('resets the low-gain streak after a non-low-gain tool turn', async () => {
    let toolCalls = 0;
    const mcpClient = makeMockMcpClient({
      do_thing: () => {
        toolCalls += 1;
        if (toolCalls === 1) {
          return { ok: false, isError: true, rawText: 'tool-error', json: null, errorCode: null };
        }
        return { ok: true, isError: false, rawText: 'tool-ok', json: null, errorCode: null };
      },
    });
    const createFn = vi.fn()
      .mockResolvedValueOnce(toolUseResponse('tu_1', 'do_thing'))
      .mockResolvedValueOnce(toolUseResponse('tu_2', 'do_thing'))
      .mockResolvedValueOnce(textResponse('recovered and completed'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      maxTurns: 10,
      runId: 'run-diminishing-returns-reset',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'recover from error loop' }], TOOLS));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'low_gain_turn',
      turnCount: 1,
      detail: expect.objectContaining({ reason: 'all_tools_errored', low_gain_streak: 1 }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'low_gain_turn',
      turnCount: 2,
    }));
    expect(events.some(event => event.type === 'done' && event.stopReason === 'diminishing_returns')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 3 });
  });

  it('approval gate accepts only a complete envelope from a registered approval producer', async () => {
    const envelope = approvalEnvelope({
      runId: 'run-approval',
      approvalId: 'apr_abc',
      packetPath: 'artifacts/runs/run-approval/packet.json',
    });
    const mcpClient = makeMockMcpClient({
      [ORCH_RUN_EXECUTE_MANIFEST]: resultWithJson(envelope),
    });
    const createFn = vi.fn().mockResolvedValue(
      toolUseResponse('tu_apr', ORCH_RUN_EXECUTE_MANIFEST, {
        run_id: 'run-approval',
        project_root: '/project',
      }),
    );

    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-approval',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run(
      [{ role: 'user', content: 'Execute' }],
      [toolDefinition(ORCH_RUN_EXECUTE_MANIFEST)],
    ));

    const aprEvt = events.find((e) => e.type === 'approval_required');
    expect(aprEvt).toMatchObject({
      type: 'approval_required',
      authority: 'run_gate',
      gateId: 'A3',
      runId: 'run-approval',
      approvalId: 'apr_abc',
      packetPath: 'artifacts/runs/run-approval/packet.json',
      approvalPacketSha256: 'a'.repeat(64),
    });

    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'approval_required' });
    // LLM was called only once (no continuation after approval)
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('approval gate stops before a later side-effect tool in the same turn', async () => {
    const transportCalls: string[] = [];
    const envelope = approvalEnvelope({
      runId: 'run-failfast',
      approvalId: 'apr_1',
      packetPath: 'artifacts/runs/run-failfast/packet.json',
    });
    const mcpClient = {
      callTool: vi.fn(async (name: string) => {
        transportCalls.push(name);
        if (name === ORCH_RUN_EXECUTE_MANIFEST) return resultWithJson(envelope);
        return { ok: true, isError: false, rawText: 'result', json: null, errorCode: null };
      }),
    } as unknown as McpClient;

    const createFn = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_1',
          name: ORCH_RUN_EXECUTE_MANIFEST,
          input: { run_id: 'run-failfast', project_root: '/project' },
        },
        { type: 'tool_use' as const, id: 'tu_2', name: 'side_effect_tool', input: {} },
      ],
      stop_reason: 'tool_use',
    });

    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-failfast',
      mcpClient,
      _messagesCreate: createFn,
    });

    await collectEvents(runner.run(
      [{ role: 'user', content: 'go' }],
      [toolDefinition(ORCH_RUN_EXECUTE_MANIFEST), toolDefinition('side_effect_tool')],
    ));

    expect(transportCalls).toEqual([ORCH_RUN_EXECUTE_MANIFEST]);
  });

  it('treats orch_policy_query requires_approval as advisory data, not a run gate', async () => {
    const started: string[] = [];
    const mcpClient = {
      callTool: vi.fn(async (name: string) => {
        started.push(name);
        if (name === ORCH_POLICY_QUERY) {
          return resultWithJson({ operation: 'compute_runs', requires_approval: true });
        }
        return {
          ok: true,
          isError: false,
          rawText: 'list-result',
          json: null,
          errorCode: null,
        };
      }),
    } as unknown as McpClient;
    const createFn = vi.fn()
      .mockResolvedValueOnce(multiToolUseResponse([
        { id: 'tu_policy', name: ORCH_POLICY_QUERY },
        { id: 'tu_list', name: ORCH_RUN_LIST },
      ]))
      .mockResolvedValueOnce(textResponse('Advisory policy read complete'));

    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-policy-advisory',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Inspect the runtime state' }], [
      toolDefinition(ORCH_POLICY_QUERY),
      toolDefinition(ORCH_RUN_LIST),
    ]));

    expect(started).toEqual([ORCH_POLICY_QUERY, ORCH_RUN_LIST]);
    expect(events.some(event => event.type === 'approval_required')).toBe(false);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(createFn).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a non-producer returns a complete approval envelope', async () => {
    const envelope = approvalEnvelope({
      runId: 'run-nonproducer-envelope',
      approvalId: 'apr_invalid',
      packetPath: 'artifacts/runs/run-nonproducer-envelope/invalid.json',
    });
    const mcpClient = makeMockMcpClient({ do_thing: resultWithJson(envelope) });
    const createFn = vi.fn().mockResolvedValue(toolUseResponse('tu_invalid_envelope', 'do_thing'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-nonproducer-envelope',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Execute' }], TOOLS));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('not registered as an approval producer') },
    });
    expect(events.some(event => event.type === 'approval_required')).toBe(false);
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a proxied backend tool block without reading traps or dispatching transport', async () => {
    let propertyReads = 0;
    const proxiedToolUse = new Proxy(
      { type: 'tool_use' as const, id: 'tu_proxy', name: 'do_thing', input: {} },
      {
        get(target, key, receiver) {
          propertyReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const mcpClient = makeMockMcpClient();
    const createFn = vi.fn().mockResolvedValue({
      content: [proxiedToolUse],
      stop_reason: 'tool_use',
    });
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-proxy-block',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Execute' }], TOOLS));

    expect(propertyReads).toBe(0);
    expect(mcpClient.callTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('Proxy values are not allowed') },
    });
  });

  it('fails closed before transport when a producer input targets another root run', async () => {
    const manifestManager = new RunManifestManager(testRunsDir);
    const envelope = approvalEnvelope({
      runId: 'other-root-run',
      approvalId: 'apr_cross_run',
      packetPath: 'artifacts/runs/other-root-run/approval.json',
    });
    const mcpClient = makeMockMcpClient({
      [ORCH_RUN_EXECUTE_MANIFEST]: resultWithJson(envelope),
    });
    const createFn = vi.fn().mockResolvedValue(
      toolUseResponse('tu_cross_run', ORCH_RUN_EXECUTE_MANIFEST, {
        run_id: 'other-root-run',
        project_root: '/project',
      }),
    );
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'runtime-run',
      approvalRunId: 'expected-root-run',
      mcpClient,
      manifestManager,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run(
      [{ role: 'user', content: 'Execute' }],
      [toolDefinition(ORCH_RUN_EXECUTE_MANIFEST)],
    ));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('must target root run expected-root-run') },
    });
    expect(events.some(event => event.type === 'approval_required')).toBe(false);
    expect(mcpClient.callTool).not.toHaveBeenCalled();
    expect(manifestManager.loadManifest('runtime-run')).toMatchObject({
      pending_tool_intents: [],
      checkpoints: [],
    });
  });

  it('fails closed before transport when a producer input targets another project root', async () => {
    const envelope = approvalEnvelope({
      runId: 'expected-root-run',
      approvalId: 'apr_cross_project',
      packetPath: 'artifacts/runs/expected-root-run/approval.json',
    });
    const mcpClient = makeMockMcpClient({
      [ORCH_RUN_EXECUTE_MANIFEST]: resultWithJson(envelope),
    });
    const createFn = vi.fn().mockResolvedValue(
      toolUseResponse('tu_cross_project', ORCH_RUN_EXECUTE_MANIFEST, {
        run_id: 'expected-root-run',
        project_root: '/other-project',
      }),
    );
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'runtime-project-run',
      approvalRunId: 'expected-root-run',
      approvalProjectRoot: '/project',
      mcpClient,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run(
      [{ role: 'user', content: 'Execute' }],
      [toolDefinition(ORCH_RUN_EXECUTE_MANIFEST)],
    ));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('must target the delegated runtime project root') },
    });
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it('crash recovery can resume a durable not_started approval-producing intent', async () => {
    const runId = 'run-recovery-apr';
    const toolUse = {
      type: 'tool_use' as const,
      id: 'tu_rec',
      name: ORCH_RUN_EXECUTE_MANIFEST,
      input: { run_id: runId, project_root: '/project' },
    };
    const envelope = approvalEnvelope({
      runId,
      approvalId: 'apr_rec',
      packetPath: 'artifacts/runs/run-recovery-apr/packet.json',
      digestCharacter: 'b',
    });
    const mcpClient = makeMockMcpClient({
      [ORCH_RUN_EXECUTE_MANIFEST]: resultWithJson(envelope),
    });
    const createFn = vi.fn();
    const manifestManager = new RunManifestManager(testRunsDir);
    manifestManager.ensureManifest(runId);
    manifestManager.observeToolIntents(runId, [createToolAttemptIdentity({
      stepId: toolUse.id,
      toolName: toolUse.name,
      input: toolUse.input,
    })]);

    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId,
      mcpClient,
      manifestManager,
      _messagesCreate: createFn,
    });

    const messages: MessageParam[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [toolUse] },
    ];

    const events = await collectEvents(runner.run(
      messages,
      [toolDefinition(ORCH_RUN_EXECUTE_MANIFEST)],
    ));

    const aprEvt = events.find((e) => e.type === 'approval_required');
    expect(aprEvt).toMatchObject({
      type: 'approval_required',
      authority: 'run_gate',
      gateId: 'A3',
      runId,
      approvalId: 'apr_rec',
      packetPath: 'artifacts/runs/run-recovery-apr/packet.json',
      approvalPacketSha256: 'b'.repeat(64),
    });
    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'approval_required' });
    expect(runner.runtimeProjection).toMatchObject({
      recovery_turn_count: 1,
      dialogue_turn_count: 0,
      approval_requested: true,
      terminal_outcome: {
        type: 'done',
        phase: 'recovery',
        turn_count: 0,
        stop_reason: 'approval_required',
      },
      projected_turns: [
        {
          phase: 'recovery',
          turn_count: 0,
          tool_call_count: 1,
          text_count: 0,
          approval_requested: true,
          terminal_outcome: {
            type: 'done',
            phase: 'recovery',
            turn_count: 0,
            stop_reason: 'approval_required',
          },
        },
      ],
    });
    expect(createFn).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'denied tool',
      laterTool: 'blocked_tool',
      allowedToolNames: [ORCH_RUN_STATUS],
      message: 'is not visible',
    },
    {
      label: 'approval resolver',
      laterTool: ORCH_RUN_APPROVE,
      allowedToolNames: [ORCH_RUN_STATUS, ORCH_RUN_APPROVE],
      message: 'reserved for the host/operator boundary',
    },
  ])('preflights a later $label before dispatching any tool in the turn', async ({
    laterTool,
    allowedToolNames,
    message,
  }) => {
    const mcpClient = { callTool: vi.fn() } as unknown as McpClient;
    const createFn = vi.fn().mockResolvedValue(multiToolUseResponse([
      { id: 'tu_allowed_first', name: ORCH_RUN_STATUS },
      { id: 'tu_denied_later', name: laterTool },
    ]));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: `run-preflight-${laterTool}`,
      mcpClient,
      allowedToolNames,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run(
      [{ role: 'user', content: 'Execute both' }],
      [toolDefinition(ORCH_RUN_STATUS), toolDefinition(laterTool)],
    ));

    expect(mcpClient.callTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining(message) },
    });
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('stops with tool_outcome_unknown when the transport rejects after durable dispatch', async () => {
    const runId = 'run-transport-reject';
    const manifestManager = new RunManifestManager(testRunsDir);
    const mcpClient = {
      callTool: vi.fn().mockRejectedValue(new Error('transport connection lost')),
    } as unknown as McpClient;
    const createFn = vi.fn().mockResolvedValue(toolUseResponse('tu_transport_reject', 'do_thing'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId,
      mcpClient,
      manifestManager,
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Execute' }], TOOLS));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_outcome_unknown',
      stepId: 'tu_transport_reject',
      name: 'do_thing',
      phase: 'dialogue',
      reason: 'dispatch_interrupted',
      message: expect.stringContaining('outcome is not durably known'),
    }));
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stopReason: 'tool_outcome_unknown',
      turnCount: 1,
    });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(manifestManager.loadManifest(runId)?.pending_tool_intents).toMatchObject([
      { step_id: 'tu_transport_reject', state: 'outcome_unknown' },
    ]);
  });

  it('lane queue: same runId calls are serialized', async () => {
    const execOrder: string[] = [];

    // First call: takes a "while" (resolves after a short delay)
    let resolveFirst!: (v: unknown) => void;
    const firstPending = new Promise((r) => { resolveFirst = r; });

    const createFn = vi.fn()
      .mockImplementationOnce(async () => {
        execOrder.push('run1-llm-start');
        await firstPending;
        execOrder.push('run1-llm-end');
        return textResponse('R1');
      })
      .mockImplementationOnce(async () => {
        execOrder.push('run2-llm-start');
        return textResponse('R2');
      });

    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-lane',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const msgs: MessageParam[] = [{ role: 'user', content: 'go' }];

    // Start both generators — execution begins when we consume them
    const p1 = collectEvents(runner.run(msgs, TOOLS));
    const p2 = collectEvents(runner.run(msgs, TOOLS));

    // Let run1 start its lane wait (resolves immediately, no prior) and enter LLM call
    // run2 queues behind run1's lane promise
    await new Promise((r) => setTimeout(r, 0)); // one microtask tick

    // Now resolve run1's LLM call
    resolveFirst(undefined);

    const [r1Events, r2Events] = await Promise.all([p1, p2]);

    // run1 must fully complete before run2 even starts its LLM call
    expect(execOrder).toEqual([
      'run1-llm-start',
      'run1-llm-end',
      'run2-llm-start',
    ]);

    expect(r1Events.some((e) => e.type === 'text' && (e as { type: 'text'; text: string }).text === 'R1')).toBe(true);
    expect(r2Events.some((e) => e.type === 'text' && (e as { type: 'text'; text: string }).text === 'R2')).toBe(true);
  });

  it('different runIds run concurrently (lane queue does not block)', async () => {
    const execOrder: string[] = [];
    let resolveA!: (v: unknown) => void;
    const pendingA = new Promise((r) => { resolveA = r; });

    const createA = vi.fn().mockImplementationOnce(async () => {
      execOrder.push('A-start');
      await pendingA;
      execOrder.push('A-end');
      return textResponse('A');
    });
    const createB = vi.fn().mockImplementationOnce(async () => {
      execOrder.push('B-start');
      return textResponse('B');
    });

    const runnerA = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-A',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createA,
    });
    const runnerB = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-B',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createB,
    });

    const msgs: MessageParam[] = [{ role: 'user', content: 'go' }];
    const pA = collectEvents(runnerA.run(msgs, TOOLS));
    const pB = collectEvents(runnerB.run(msgs, TOOLS));

    await new Promise((r) => setTimeout(r, 0));

    // B should have started even while A is still pending
    expect(execOrder).toContain('B-start');

    resolveA(undefined);
    await Promise.all([pA, pB]);

    expect(execOrder).toContain('A-end');
  });

  it('error from LLM is emitted as error event', async () => {
    const createFn = vi.fn().mockRejectedValue(new Error('API error'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-err',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'go' }], TOOLS));
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { type: 'error'; error: { message: string } }).error.message).toContain('API error');
  });

  it('retries once after max_tokens truncation and keeps the recovery marker auditable', async () => {
    const createFn = vi.fn()
      .mockResolvedValueOnce(textResponse('partial answer', 'max_tokens', { input_tokens: 120, output_tokens: 80, total_tokens: 200 }))
      .mockResolvedValueOnce(textResponse('completed answer'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-truncation-retry',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'finish the draft' }], TOOLS));

    expect(events).toContainEqual({ type: 'text', text: 'partial answer' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'runtime_marker',
      kind: 'truncation_retry',
      turnCount: 1,
      detail: expect.objectContaining({ attempt: 1 }),
    }));
    expect(events).toContainEqual({ type: 'text', text: 'completed answer' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 2 });
    expect(createFn.mock.calls[1]?.[0]?.messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
    });
    expect(createFn.mock.calls[1]?.[0]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('[runtime marker] Previous assistant response was truncated by max_tokens.'),
    });
  });

  it('fails closed when max_tokens truncation exceeds the bounded retry budget', async () => {
    const createFn = vi.fn()
      .mockResolvedValueOnce(textResponse('partial answer', 'max_tokens'))
      .mockResolvedValueOnce(textResponse('still partial', 'max_tokens'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-truncation-exhausted',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'finish the draft' }], TOOLS));

    expect(events.filter(event => event.type === 'runtime_marker')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('bounded recovery budget was exhausted') },
    });
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('retries once after prompt-too-long overflow by compacting prior history with an auditable marker', async () => {
    const createFn = vi.fn()
      .mockRejectedValueOnce(new Error('prompt is too long for the model context window'))
      .mockResolvedValueOnce(textResponse('overflow recovered'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-overflow-retry',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const messages: MessageParam[] = [
      { role: 'user', content: 'Open the project and inspect every artifact carefully.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Initial assessment.' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_big', content: 'x'.repeat(1200) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Tool result received.' }] },
      { role: 'user', content: 'Continue with the full synthesis.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Preparing the synthesis.' }] },
    ];
    const events = await collectEvents(runner.run(messages, TOOLS));

    expect(events[0]).toMatchObject({
      type: 'runtime_marker',
      kind: 'context_overflow_retry',
      detail: expect.objectContaining({ attempt: 1 }),
    });
    expect(events).toContainEqual({ type: 'text', text: 'overflow recovered' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    expect(createFn.mock.calls[1]?.[0]?.messages.some((message: MessageParam) =>
      typeof message.content === 'string' && message.content.includes('[runtime marker] Context compaction applied'),
    )).toBe(true);
  });

  it('fails closed when the backend returns an unknown stop_reason', async () => {
    const createFn = vi.fn().mockResolvedValue(textResponse('mystery response', 'weird_reason'));
    const runner = makeRunner({
      model: 'claude-opus-4-6',
      runId: 'run-unknown-stop-reason',
      mcpClient: makeMockMcpClient(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'go' }], TOOLS));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('Unknown assistant stop_reason') },
    });
    expect(events.some(event => event.type === 'done')).toBe(false);
  });
});
