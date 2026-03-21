import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  executeTeamDelegatedRuntime,
  executeUnifiedTeamRuntime,
  type TeamPermissionMatrix,
} from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-'));
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
  };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use' as const, id, name, input }],
    stop_reason: 'tool_use',
  };
}

function extractTaskId(params: {
  messages: Array<{ role: string; content: unknown }>;
}): string {
  const protocol = params.messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
    .find(content => content.includes('## TASK'));
  if (!protocol || typeof protocol !== 'string') {
    throw new Error('missing delegation protocol');
  }
  if (protocol.includes('task-parallel-1')) return 'task-parallel-1';
  if (protocol.includes('task-parallel-2')) return 'task-parallel-2';
  if (protocol.includes('task-recover-1')) return 'task-recover-1';
  if (protocol.includes('task-recover-2')) return 'task-recover-2';
  if (protocol.includes('task-recover-timeout-2')) return 'task-recover-timeout-2';
  if (protocol.includes('task-timeout-3')) return 'task-timeout-3';
  if (protocol.includes('task-complete-1')) return 'task-complete-1';
  if (protocol.includes('task-review-2')) return 'task-review-2';
  return 'task-compute-1';
}

const PERMISSIONS: TeamPermissionMatrix = {
  delegation: [
    {
      from_role: 'lead',
      to_role: 'delegate',
      allowed_task_kinds: ['compute', 'review'],
      allowed_handoff_kinds: ['compute', 'review'],
    },
  ],
  interventions: [
    {
      actor_role: 'lead',
      allowed_scopes: ['task', 'team'],
      allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
    },
    {
      actor_role: 'lead',
      allowed_scopes: ['task'],
      allowed_kinds: ['approve', 'redirect', 'inject_task'],
    },
  ],
};

describe('team unified runtime control paths', () => {
  it('keeps max_turns as non-completed team state', async () => {
    const projectRoot = makeTmpDir();
    try {
      const result = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-max-turns',
        workspaceId: 'ws-max-turns',
        taskId: 'task-max-turns',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        maxTurns: 1,
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(toolUseResponse('tu_loop', 'do_thing')),
      });

      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_turns' });
      expect(result.team_state.delegate_assignments[0]?.status).toBe('running');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('respects pause and cascade_stop interventions through structured team state', async () => {
    const projectRoot = makeTmpDir();
    try {
      const paused = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-pause',
        workspaceId: 'ws-pause',
        taskId: 'task-pause',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        interventions: [{ kind: 'pause', scope: 'task', actor_role: 'lead', actor_id: 'pi', task_id: 'task-pause' }],
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'x', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      });
      expect(paused.events).toEqual([]);
      expect(paused.team_state.delegate_assignments[0]?.status).toBe('paused');

      const cascade = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-cascade',
        workspaceId: 'ws-cascade',
        taskId: 'task-cascade',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        interventions: [{ kind: 'cascade_stop', scope: 'team', actor_role: 'lead', actor_id: 'pi', note: 'stop all delegates' }],
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'x', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      });

      expect(cascade.team_state.interventions.at(-1)?.kind).toBe('cascade_stop');
      expect(cascade.team_state.delegate_assignments[0]?.status).toBe('cascade_stopped');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('persists nested approval metadata and resumes after a task-scoped approve intervention', async () => {
    const projectRoot = makeTmpDir();
    try {
      const approvalClient = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: '{"requires_approval":true,"approval_id":"apr_nested","packet_path":"artifacts/runs/run-approval/approval_packet_v1.json"}',
        json: {
          requires_approval: true,
          approval_id: 'apr_nested',
          packet_path: 'artifacts/runs/run-approval/approval_packet_v1.json',
        },
        errorCode: null,
      }));

      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-approval',
        workspaceId: 'workspace:run-approval',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-approval', task_kind: 'compute' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: approvalClient },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(toolUseResponse('tu_approval', 'do_thing', { task_id: 'task-approval' })),
      });

      expect(first.assignment_results[0]?.status).toBe('awaiting_approval');
      expect(first.team_state.delegate_assignments[0]).toMatchObject({
        status: 'awaiting_approval',
        approval_id: 'apr_nested',
        approval_packet_path: 'artifacts/runs/run-approval/approval_packet_v1.json',
      });

      const resumedCallTool = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      }));
      const resumed = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-approval',
        workspaceId: 'workspace:run-approval',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-approval', task_kind: 'compute' },
        ],
        interventions: [{ kind: 'approve', scope: 'task', actor_role: 'lead', actor_id: 'pi', task_id: 'task-approval' }],
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_approval', name: 'do_thing', input: { task_id: 'task-approval' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedCallTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('approved and resumed')),
      });

      expect(resumed.assignment_results[0]?.status).toBe('completed');
      expect(resumed.assignment_results[0]?.resumed).toBe(true);
      expect(resumed.assignment_results[0]?.skipped_step_ids).toEqual(['tu_approval']);
      expect(resumed.team_state.delegate_assignments[0]).toMatchObject({
        status: 'completed',
        approval_id: null,
        approval_packet_path: null,
        approval_requested_at: null,
      });
      expect(resumedCallTool).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('injects redirect context into the next assignment launch and clears it after launch succeeds', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const redirectMessage = params.messages.find((message: { role: string; content: unknown }) =>
          message.role === 'user'
          && typeof message.content === 'string'
          && message.content.includes('## OPERATOR REDIRECT'),
        );
        expect(redirectMessage).toBeDefined();
        expect((redirectMessage as { content: string }).content).toContain('revise the computation plan');
        return textResponse('redirected run completed');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-redirect',
        workspaceId: 'workspace:run-redirect',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-redirect', task_kind: 'compute' },
        ],
        interventions: [{
          kind: 'redirect',
          scope: 'task',
          actor_role: 'lead',
          actor_id: 'pi',
          task_id: 'task-redirect',
          note: 'revise the computation plan',
          payload: { focus: 'error budget', preserve_evidence: true },
        }],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results[0]?.status).toBe('completed');
      expect(result.team_state.delegate_assignments[0]?.pending_redirect).toBeNull();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs injected follow-on assignments through the same unified runtime bucket planning', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const protocol = params.messages
          .filter((message: { role: string; content: unknown }) => message.role === 'user' && typeof message.content === 'string')
          .map((message: { content: string }) => message.content)
          .find((content: string) => content.includes('## TASK'));
        return textResponse(protocol?.includes('task-review-followup') ? 'review followup done' : 'seed compute done');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-inject',
        workspaceId: 'workspace:run-inject',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-compute-seed', task_kind: 'compute', handoff_kind: 'compute' },
        ],
        interventions: [{
          kind: 'inject_task',
          scope: 'task',
          actor_role: 'lead',
          actor_id: 'pi',
          task_id: 'task-compute-seed',
          payload: {
            stage: 1,
            task_id: 'task-review-followup',
            task_kind: 'review',
            delegate_role: 'delegate',
            delegate_id: 'delegate-2',
            handoff_kind: 'review',
          },
        }],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-compute-seed', 'task-review-followup']);
      expect(result.assignment_results.every(item => item.status === 'completed')).toBe(true);
      expect(result.team_state.delegate_assignments).toHaveLength(2);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs a real stage_gated multi-assignment path through the unified runtime core', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const protocol = params.messages
          .filter((message: { role: string; content: unknown }) => message.role === 'user' && typeof message.content === 'string')
          .map((message: { content: string }) => message.content)
          .find((content: string) => content.includes('## TASK'));
        return textResponse(protocol?.includes('task-review-2') ? 'review stage done' : 'compute stage done');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-stage-gated',
        workspaceId: 'workspace:run-stage-gated',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-compute-1', task_kind: 'compute', handoff_id: 'handoff-compute-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-review-2', task_kind: 'review', handoff_id: 'handoff-review-2', handoff_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results).toHaveLength(2);
      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-compute-1', 'task-review-2']);
      expect(result.assignment_results[0]?.delegation_protocol.TASK.task_id).toBe('task-compute-1');
      expect(result.blocked_stage).toBeNull();
      expect(result.live_status.active_assignments).toEqual([]);
      expect(result.live_status.terminal_assignments).toHaveLength(2);
      expect(result.replay.some(entry => entry.kind === 'stage_started' && entry.payload.stage === 0)).toBe(true);
      expect(result.replay.some(entry => entry.kind === 'stage_completed' && entry.payload.stage === 1)).toBe(true);
      expect(createMessage).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fans out parallel assignments concurrently while keeping result ordering deterministic', async () => {
    const projectRoot = makeTmpDir();
    try {
      let releaseBarrier: (() => void) | null = null;
      const barrier = new Promise<void>(resolve => {
        releaseBarrier = resolve;
      });
      let readyResolve: (() => void) | null = null;
      const ready = new Promise<void>(resolve => {
        readyResolve = resolve;
      });
      const callOrder: string[] = [];

      const createMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        return hasToolResult
          ? textResponse(`${taskId} complete`)
          : toolUseResponse(`tu_${taskId}`, 'do_thing', { task_id: taskId });
      });
      const callTool = vi.fn(async (_name: string, input: { task_id: string }) => {
        callOrder.push(input.task_id);
        if (callOrder.length === 2) readyResolve?.();
        await barrier;
        return { ok: true, isError: false, rawText: `tool:${input.task_id}`, json: null, errorCode: null };
      });

      const runtimePromise = executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-parallel',
        workspaceId: 'workspace:run-parallel',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-parallel-1', task_kind: 'compute', handoff_id: 'handoff-parallel-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-parallel-2', task_kind: 'review', handoff_id: 'handoff-parallel-2', handoff_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      const launched = await Promise.race([
        ready.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);
      expect(launched).toBe(true);
      releaseBarrier?.();
      const result = await runtimePromise;

      expect(callTool).toHaveBeenCalledTimes(2);
      expect(callOrder.slice().sort()).toEqual(['task-parallel-1', 'task-parallel-2']);
      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-parallel-1', 'task-parallel-2']);
      expect(result.assignment_results.every(item => item.status === 'completed')).toBe(true);
      expect(result.live_status.terminal_assignments.map(item => item.task_id)).toEqual(['task-parallel-1', 'task-parallel-2']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps completed work terminal while resuming only recoverable parallel assignments', async () => {
    const projectRoot = makeTmpDir();
    try {
      const firstToolCall = vi.fn(async (_name: string, input: { task_id: string }) => ({
        ok: true,
        isError: false,
        rawText: `tool:${input.task_id}`,
        json: null,
        errorCode: null,
      }));
      const firstCreateMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        if (taskId === 'task-recover-1') return textResponse('task-recover-1 complete');
        if (taskId === 'task-recover-2' && !hasToolResult) {
          return toolUseResponse('tu_recover', 'do_thing', { task_id: taskId });
        }
        if (taskId === 'task-recover-2' && hasToolResult) {
          throw new Error('interrupt after checkpoint');
        }
        return textResponse('expired assignment should not run');
      });

      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-recover-parallel',
        workspaceId: 'workspace:run-recover-parallel',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-recover-1', task_kind: 'compute', handoff_id: 'handoff-recover-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-recover-2', task_kind: 'review', handoff_id: 'handoff-recover-2', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-timeout-3', task_kind: 'compute', handoff_id: 'handoff-timeout-3', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: firstToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: firstCreateMessage,
      });

      expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-recover-1', 'completed'],
        ['task-recover-2', 'needs_recovery'],
        ['task-timeout-3', 'timed_out'],
      ]);
      expect(first.live_status.active_assignments.map(item => item.task_id)).toEqual(['task-recover-2']);
      expect(first.live_status.terminal_assignments.map(item => item.task_id).sort()).toEqual(['task-recover-1', 'task-timeout-3']);
      expect(first.live_status.terminal_assignments.find(item => item.task_id === 'task-timeout-3')?.timeout_at).toBe('2020-01-01T00:00:00Z');
      expect(first.replay.some(entry => entry.kind === 'assignment_timed_out')).toBe(true);
      expect(firstToolCall).toHaveBeenCalledTimes(1);

      const resumedToolCall = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      }));
      const resumedCreateMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        return textResponse(`${taskId} resumed`);
      });

      const resumed = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-recover-parallel',
        workspaceId: 'workspace:run-recover-parallel',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-recover-1', task_kind: 'compute', handoff_id: 'handoff-recover-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-recover-2', task_kind: 'review', handoff_id: 'handoff-recover-2', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-timeout-3', task_kind: 'compute', handoff_id: 'handoff-timeout-3', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
        ],
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_recover', name: 'do_thing', input: { task_id: 'task-recover-2' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: resumedCreateMessage,
      });

      expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-recover-1', 'completed'],
        ['task-recover-2', 'completed'],
        ['task-timeout-3', 'timed_out'],
      ]);
      expect(resumedCreateMessage).toHaveBeenCalledTimes(1);
      expect(resumedToolCall).not.toHaveBeenCalled();
      expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
      expect(resumed.live_status.active_assignments).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks still-active recoverable assignments timed out only after concurrent bucket merges settle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00Z'));
    const projectRoot = makeTmpDir();
    try {
      const toolCall = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'tool-result',
        json: null,
        errorCode: null,
      }));
      const createMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        if (taskId === 'task-complete-1') {
          vi.setSystemTime(new Date('2026-03-21T00:01:00Z'));
          return textResponse('task-complete-1 complete');
        }
        if (!hasToolResult) {
          return toolUseResponse('tu_recover_timeout', 'do_thing', { task_id: taskId });
        }
        throw new Error('interrupt after checkpoint');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-timeout-after-merge',
        workspaceId: 'workspace:run-timeout-after-merge',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-complete-1', task_kind: 'compute', handoff_id: 'handoff-complete-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-recover-timeout-2', task_kind: 'review', handoff_id: 'handoff-recover-timeout-2', handoff_kind: 'review', timeout_at: '2026-03-21T00:00:30Z' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: toolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-complete-1', 'completed'],
        ['task-recover-timeout-2', 'timed_out'],
      ]);
      expect(result.replay.filter(entry => entry.kind === 'assignment_timed_out')).toHaveLength(1);
      expect(result.live_status.terminal_assignments.find(item => item.task_id === 'task-recover-timeout-2')?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not de-duplicate persisted assignments that differ by task kind', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn().mockResolvedValue(textResponse('done'));

      await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-dedup-task-kind',
        workspaceId: 'workspace:run-dedup-task-kind',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-shared', task_kind: 'compute' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      const rerun = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-dedup-task-kind',
        workspaceId: 'workspace:run-dedup-task-kind',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-shared', task_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(rerun.team_state.delegate_assignments).toHaveLength(2);
      expect(rerun.team_state.delegate_assignments.map(item => item.task_kind).sort()).toEqual(['compute', 'review']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
