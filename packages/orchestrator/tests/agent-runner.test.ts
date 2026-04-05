import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ORCH_RUN_CREATE, ORCH_RUN_LIST, ORCH_RUN_STATUS } from '@autoresearch/shared';
import { AgentRunner, _resetLaneQueue, type MessageParam, type Tool, type AgentEvent } from '../src/agent-runner.js';
import type { McpClient, McpToolResult } from '../src/mcp-client.js';
import type { ApprovalGate } from '../src/approval-gate.js';

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

function makeMockApprovalGate(): ApprovalGate {
  return {} as ApprovalGate;
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
  });

  afterEach(() => {
    _resetLaneQueue();
    vi.restoreAllMocks();
  });

  it('single-turn text response emits text + done events', async () => {
    const createFn = vi.fn().mockResolvedValue(textResponse('Hello world'));
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-1',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createFn,
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'Hi' }];
    const events = await collectEvents(runner.run(messages, TOOLS));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', text: 'Hello world' });
    expect(events[1]).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 1 });
  });

  it('multi-turn: tool call followed by final text response', async () => {
    const mcpClient = makeMockMcpClient({
      do_thing: { ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null },
    });
    const createFn = vi.fn()
      .mockResolvedValueOnce(toolUseResponse('tu_1', 'do_thing'))
      .mockResolvedValueOnce(textResponse('All done'));

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-2',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Start' }], TOOLS));

    const toolCallEvt = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvt).toMatchObject({ type: 'tool_call', name: 'do_thing' });

    const textEvt = events.find((e) => e.type === 'text');
    expect(textEvt).toMatchObject({ type: 'text', text: 'All done' });

    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'end_turn', turnCount: 2 });

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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-batch-safe-group',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-mixed-grouping',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'fast',
      runId: 'run-route-direct',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-route-default-budget',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'analysis',
      runId: 'run-route-alias',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    expect(() => new AgentRunner({
      model: 'missing',
      runId: 'run-route-missing',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    expect(() => new AgentRunner({
      model: 'default',
      runId: 'run-route-json',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
      routingConfig: '{bad json',
      _messagesCreate: vi.fn(),
    })).toThrow(/Invalid routing config JSON/);

    expect(() => new AgentRunner({
      model: 'default',
      runId: 'run-route-backend',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const createFn = vi.fn().mockResolvedValue(toolUseResponse('tu_x', 'do_thing'));
    let callCount = 0;
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      maxTurns: 3,
      runId: 'run-maxturn',
      mcpClient: makeMockMcpClient({
        do_thing: () => {
          callCount += 1;
          return { ok: true, isError: false, rawText: `result-${callCount}`, json: null, errorCode: null };
        },
      }),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      maxTurns: 10,
      runId: 'run-diminishing-returns',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      maxTurns: 10,
      runId: 'run-diminishing-returns-all-errors',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      maxTurns: 10,
      runId: 'run-diminishing-returns-reset',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
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

  it('approval gate: requires_approval in tool result emits approval_required event', async () => {
    const mcpClient = makeMockMcpClient({
      do_thing: {
        ok: true,
        isError: false,
        rawText: '{"requires_approval":true,"approval_id":"apr_abc","packet_path":"/runs/1/packet.json"}',
        json: { requires_approval: true, approval_id: 'apr_abc', packet_path: '/runs/1/packet.json' },
        errorCode: null,
      },
    });
    const createFn = vi.fn().mockResolvedValue(toolUseResponse('tu_apr', 'do_thing'));

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-approval',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Execute' }], TOOLS));

    const aprEvt = events.find((e) => e.type === 'approval_required');
    expect(aprEvt).toMatchObject({
      type: 'approval_required',
      approvalId: 'apr_abc',
      packetPath: '/runs/1/packet.json',
    });

    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'approval_required' });
    // LLM was called only once (no continuation after approval)
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('approval gate: fails fast — second tool in same turn is NOT called', async () => {
    // Simulate a response with two tool_use blocks; the first requires approval.
    // The second tool must NOT be called (fail-closed safety).
    const secondToolCalls: string[] = [];
    const mcpClient = {
      callTool: vi.fn(async (name: string) => {
        if (name === 'approve_tool') {
          return {
            ok: true, isError: false, errorCode: null,
            rawText: '{"requires_approval":true,"approval_id":"apr_1","packet_path":"/p.json"}',
            json: { requires_approval: true, approval_id: 'apr_1', packet_path: '/p.json' },
          };
        }
        secondToolCalls.push(name);
        return { ok: true, isError: false, rawText: 'result', json: null, errorCode: null };
      }),
    } as unknown as McpClient;

    const createFn = vi.fn().mockResolvedValue({
      content: [
        { type: 'tool_use' as const, id: 'tu_1', name: 'approve_tool', input: {} },
        { type: 'tool_use' as const, id: 'tu_2', name: 'side_effect_tool', input: {} },
      ],
      stop_reason: 'tool_use',
    });

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-failfast',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createFn,
    });

    await collectEvents(runner.run([{ role: 'user', content: 'go' }], TOOLS));

    // side_effect_tool must NOT have been called
    expect(secondToolCalls).toHaveLength(0);
  });

  it('fails closed when a batch-safe parallel tool unexpectedly returns requires_approval', async () => {
    const started: string[] = [];
    const mcpClient = {
      callTool: vi.fn(async (name: string) => {
        started.push(name);
        if (name === ORCH_RUN_STATUS) {
          return {
            ok: true,
            isError: false,
            rawText: '{"requires_approval":true,"approval_id":"apr_parallel","packet_path":"/parallel.json"}',
            json: { requires_approval: true, approval_id: 'apr_parallel', packet_path: '/parallel.json' },
            errorCode: null,
          };
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
    const createFn = vi.fn().mockResolvedValue(multiToolUseResponse([
      { id: 'tu_status', name: ORCH_RUN_STATUS },
      { id: 'tu_list', name: ORCH_RUN_LIST },
    ]));

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-batch-safe-approval-guard',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createFn,
    });

    const events = await collectEvents(runner.run([{ role: 'user', content: 'Inspect the runtime state' }], [
      { name: ORCH_RUN_STATUS, input_schema: { type: 'object', properties: {} } },
      { name: ORCH_RUN_LIST, input_schema: { type: 'object', properties: {} } },
    ]));

    expect(started).toEqual([ORCH_RUN_STATUS, ORCH_RUN_LIST]);
    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          message: expect.stringContaining('unexpectedly requested approval during parallel execution'),
        },
      },
    ]);
    expect(events.some(event => event.type === 'approval_required')).toBe(false);
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('crash recovery: approval_required during recovery emits done and halts', async () => {
    // Simulate a crash where the last message is an assistant turn with a pending tool_use
    // that, when re-executed, returns requires_approval.
    const mcpClient = makeMockMcpClient({
      recover_tool: {
        ok: true, isError: false, errorCode: null,
        rawText: '{"requires_approval":true,"approval_id":"apr_rec","packet_path":"/rec.json"}',
        json: { requires_approval: true, approval_id: 'apr_rec', packet_path: '/rec.json' },
      },
    });
    const createFn = vi.fn(); // should never be called

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-recovery-apr',
      mcpClient,
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createFn,
    });

    // Messages already end with an unanswered assistant tool_use (crash scenario)
    const messages: MessageParam[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_rec', name: 'recover_tool', input: {} }] },
    ];

    const events = await collectEvents(runner.run(messages, TOOLS));

    // Must emit approval_required + done, never reach LLM
    const aprEvt = events.find((e) => e.type === 'approval_required');
    expect(aprEvt).toMatchObject({ type: 'approval_required', approvalId: 'apr_rec', packetPath: '/rec.json' });
    const doneEvt = events.find((e) => e.type === 'done');
    expect(doneEvt).toMatchObject({ type: 'done', stopReason: 'approval_required' });
    expect(createFn).not.toHaveBeenCalled();
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

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-lane',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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

    const runnerA = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-A',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
      _messagesCreate: createA,
    });
    const runnerB = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-B',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-err',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-truncation-retry',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-truncation-exhausted',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-overflow-retry',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-unknown-stop-reason',
      mcpClient: makeMockMcpClient(),
      approvalGate: makeMockApprovalGate(),
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
