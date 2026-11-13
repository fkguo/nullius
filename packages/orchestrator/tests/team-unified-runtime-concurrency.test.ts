import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { executeUnifiedTeamRuntime, type ExecuteUnifiedTeamRuntimeInput } from '../src/team-unified-runtime.js';
import { TeamExecutionStateManager } from '../src/team-execution-storage.js';
import type { TeamExecutionState } from '../src/team-execution-types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function taskIdFromMessages(params: { messages: Array<{ content: unknown }> }): string {
  const protocol = params.messages.map(message => message.content)
    .find((content): content is string => typeof content === 'string' && content.includes('## TASK'));
  const taskId = protocol?.match(/^task_id: (.+)$/m)?.[1];
  if (!taskId) throw new Error('missing task identity');
  return taskId;
}

function textResponse() {
  return { content: [{ type: 'text' as const, text: 'fixture complete' }], stop_reason: 'end_turn' };
}

function runtimeInput(projectRoot: string, count: number): ExecuteUnifiedTeamRuntimeInput {
  return {
    projectRoot,
    runId: 'run-concurrency',
    workspaceId: 'workspace:concurrency',
    coordinationPolicy: 'parallel',
    permissions: {
      delegation: [{ from_role: 'lead', to_role: 'delegate', allowed_task_kinds: ['compute'], allowed_handoff_kinds: ['compute'] }],
      interventions: [],
    },
    assignments: Array.from({ length: count }, (_, index) => ({
      stage: 0, task_id: `task-${index}`, task_kind: 'compute',
      owner_role: 'lead', delegate_role: 'delegate', delegate_id: `delegate-${index}`,
    })),
    messages: [{ role: 'user', content: 'Complete each assigned fixture task.' }],
    model: 'fixture-model',
    tools: [],
    mcpClient: { callTool: vi.fn() },
    _messagesCreate: vi.fn(async () => textResponse()),
  };
}

describe('bounded team execution', () => {
  it.each([
    { policy: 'parallel' as const, maxParallel: undefined, expected: 4 },
    { policy: 'parallel' as const, maxParallel: 1, expected: 1 },
    { policy: 'parallel' as const, maxParallel: 2, expected: 2 },
    { policy: 'stage_gated' as const, maxParallel: 2, expected: 2 },
  ])('limits $policy to $expected slots and persists queued work as pending', async ({ policy, maxParallel, expected }) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-concurrency-'));
    const gates = Array.from({ length: 6 }, deferred);
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    let runtime: ReturnType<typeof executeUnifiedTeamRuntime> | undefined;
    try {
      const input = runtimeInput(projectRoot, 6);
      const manager = new TeamExecutionStateManager(projectRoot);
      runtime = executeUnifiedTeamRuntime({
        ...input, coordinationPolicy: policy, maxParallel,
        _messagesCreate: vi.fn(async params => {
          const taskId = taskIdFromMessages(params);
          started.push(taskId);
          active += 1;
          peak = Math.max(peak, active);
          try {
            await gates[Number(taskId.slice('task-'.length))].promise;
            return textResponse();
          } finally {
            active -= 1;
          }
        }),
      });
      await vi.waitFor(() => expect(started).toHaveLength(expected));
      const queuedState = manager.load(input.runId)!;
      expect(queuedState.delegate_assignments.map(item => item.status)).toEqual([
        ...Array(expected).fill('running'), ...Array(6 - expected).fill('pending'),
      ]);
      expect(queuedState.delegate_assignments.slice(expected).every(item => item.session_id === null)).toBe(true);

      // Finish a later slot first. Completion is persisted before this slot is reused.
      gates[expected - 1].resolve();
      await vi.waitFor(() => expect(started).toHaveLength(expected + 1));
      expect(manager.load(input.runId)!.delegate_assignments[expected - 1].status).toBe('completed');
      expect(manager.load(input.runId)!.delegate_assignments[expected].status).toBe('running');
      gates.forEach(gate => gate.resolve());
      const result = await runtime;
      expect(peak).toBe(expected);
      expect(result.assignment_results.map(item => item.task_id)).toEqual(input.assignments.map(item => item.task_id));
      expect(result.assignment_results.every(item => item.status === 'completed')).toBe(true);
      expect(manager.load(input.runId)!.delegate_assignments.every(item => item.status === 'completed')).toBe(true);
    } finally {
      gates.forEach(gate => gate.resolve());
      await runtime?.catch(() => undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('checks a queued assignment deadline again before starting its session', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-queued-timeout-'));
    const firstGate = deferred();
    let runtime: ReturnType<typeof executeUnifiedTeamRuntime> | undefined;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    try {
      const input = runtimeInput(projectRoot, 3);
      input.assignments[1].timeout_at = '2026-11-13T00:01:00Z';
      const started: string[] = [];
      runtime = executeUnifiedTeamRuntime({
        ...input, maxParallel: 1,
        _messagesCreate: vi.fn(async params => {
          const taskId = taskIdFromMessages(params);
          started.push(taskId);
          if (taskId === 'task-0') await firstGate.promise;
          return textResponse();
        }),
      });
      await vi.waitFor(() => expect(started).toEqual(['task-0']));
      const queued = new TeamExecutionStateManager(projectRoot).load(input.runId)!;
      expect(queued.delegate_assignments[1].status).toBe('pending');
      vi.setSystemTime(new Date('2026-11-13T00:02:00Z'));
      firstGate.resolve();
      const result = await runtime;
      expect(started).toEqual(['task-0', 'task-2']);
      expect(result.assignment_results.map(item => item.status)).toEqual(['completed', 'timed_out', 'completed']);
      expect(result.team_state.delegate_assignments[1].session_id).toBeNull();
      expect(result.replay.filter(event => event.kind === 'assignment_timed_out')).toHaveLength(1);
    } finally {
      firstGate.resolve();
      await runtime?.catch(() => undefined);
      vi.useRealTimers();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps delegate failure explicit while the remaining parallel assignments complete', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-parallel-failure-'));
    try {
      const result = await executeUnifiedTeamRuntime({
        ...runtimeInput(projectRoot, 3), maxParallel: 2,
        _messagesCreate: vi.fn(async params => {
          if (taskIdFromMessages(params) === 'task-1') throw new Error('fixture delegate unavailable');
          return textResponse();
        }),
      });
      expect(result.assignment_results.map(item => item.status)).toEqual(['completed', 'failed', 'completed']);
      expect(result.assignment_results[1].events.some(event => event.type === 'error')).toBe(true);
      expect(result.blocked_stage).toBeNull();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('stops dequeuing after a persistence error and observes all in-flight workers before rejecting', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-worker-save-failure-'));
    const gates = [deferred(), deferred()];
    const started: string[] = [];
    const save = TeamExecutionStateManager.prototype.save;
    let injectedFailure = false;
    let settled = false;
    let runtime: ReturnType<typeof executeUnifiedTeamRuntime> | undefined;
    const saveSpy = vi.spyOn(TeamExecutionStateManager.prototype, 'save').mockImplementation(function (state: TeamExecutionState) {
      if (!injectedFailure && state.delegate_assignments[0].status === 'completed') {
        injectedFailure = true;
        throw new Error('fixture persistence failure');
      }
      return save.call(this, state);
    });
    try {
      runtime = executeUnifiedTeamRuntime({
        ...runtimeInput(projectRoot, 3), maxParallel: 2,
        _messagesCreate: vi.fn(async params => {
          const taskId = taskIdFromMessages(params);
          started.push(taskId);
          await gates[Number(taskId.slice('task-'.length))]?.promise;
          return textResponse();
        }),
      });
      void runtime.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(started).toEqual(['task-0', 'task-1']));
      gates[0].resolve();
      await vi.waitFor(() => expect(injectedFailure).toBe(true));
      expect(settled).toBe(false);
      expect(started).toEqual(['task-0', 'task-1']);
      gates[1].resolve();
      await expect(runtime).rejects.toThrow('fixture persistence failure');
      expect(started).toEqual(['task-0', 'task-1']);
      expect(new TeamExecutionStateManager(projectRoot).load('run-concurrency')!.delegate_assignments[2].status).toBe('pending');
    } finally {
      gates.forEach(gate => gate.resolve());
      await runtime?.catch(() => undefined);
      saveSpy.mockRestore();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([0, -1, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maxParallel %s before writing runtime state', async maxParallel => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-invalid-concurrency-'));
    try {
      const input = runtimeInput(projectRoot, 1);
      await expect(executeUnifiedTeamRuntime({ ...input, maxParallel })).rejects.toThrow(/maxParallel must be an integer/);
      expect(input._messagesCreate).not.toHaveBeenCalled();
      expect(fs.readdirSync(projectRoot)).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
