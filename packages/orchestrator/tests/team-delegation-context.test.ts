import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { handleOrchRunExecuteAgent } from '../src/orch-tools/agent-runtime.js';
import { OrchRunExecuteAgentSchema } from '../src/orch-tools/schemas.js';
import { TeamExecutionConfigSchema } from '../src/orch-tools/team-schemas.js';
import { buildTeamAssignments } from '../src/team-execution-tool-bridge.js';
import { TeamExecutionStateManager } from '../src/team-execution-storage.js';
import { initRunState } from './executeManifestTestUtils.js';

const PAYLOAD = {
  question: '核对公式中的负号\n并报告适用范围',
  source_refs: [{ path: 'papers/原文.pdf', pages: [3, 7], sha256: 'source-hash' }],
  constraints: { independent: true, tolerance: 0, unknown: null },
  expected_output: { claims: ['units', 'sign'], evidence: { page_required: true } },
};

describe('team delegation context contract', () => {
  it.each(['single', 'assignments'] as const)('passes nested context through the public %s bridge to host sampling', async mode => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-delegation-context-'));
    const runId = 'run-context';
    try {
      initRunState(projectRoot, runId);
      const payloadConfig = mode === 'single'
        ? { task_id: 'source-check', handoff_payload: PAYLOAD }
        : { assignments: [{ task_id: 'source-check', handoff_payload: PAYLOAD }] };
      const params = OrchRunExecuteAgentSchema.parse({
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        model: 'fixture-model',
        messages: [{ role: 'user', content: 'Follow the assigned source-check task.' }],
        tools: [],
        team: { ...payloadConfig, task_kind: 'evidence_search' },
      });
      const sampledContexts: unknown[] = [];
      const createMessage = vi.fn(async params => {
        const protocol = params.messages.flatMap(message => {
          const blocks = Array.isArray(message.content) ? message.content : [message.content];
          return blocks.filter(block => block.type === 'text').map(block => block.text);
        }).find(text => text.includes('## TASK'));
        expect(protocol).toBeDefined();
        expect(protocol).not.toContain('[object Object]');
        const payloadLine = protocol!.split('\n').find(line => line.startsWith('handoff_payload: '));
        sampledContexts.push(JSON.parse(payloadLine!.slice('handoff_payload: '.length)));
        return { model: 'fixture-model', content: { type: 'text' as const, text: 'Fixture delegate completed.' }, stopReason: 'endTurn' };
      });
      await handleOrchRunExecuteAgent(params, { createMessage, callTool: vi.fn() });

      expect(sampledContexts).toEqual([PAYLOAD]);
      const state = new TeamExecutionStateManager(projectRoot).load(runId)!;
      expect(state.delegate_assignments[0].handoff_payload).toEqual(PAYLOAD);
      expect(state.delegate_assignments[0].delegation_protocol.CONTEXT.handoff_payload).toEqual(PAYLOAD);
      expect(state.delegate_assignments[0].status).toBe('completed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('inherits shared context, allows assignment overrides and explicit clearing, and isolates mutable payloads', () => {
    const shared = structuredClone(PAYLOAD);
    const override = { question: 'Check a different source', source_refs: [] };
    const team = TeamExecutionConfigSchema.parse({
      handoff_payload: shared,
      assignments: [
        { task_id: 'inherit-a' },
        { task_id: 'inherit-b' },
        { task_id: 'override', handoff_payload: override },
        { task_id: 'clear', handoff_payload: null },
      ],
    });
    const assignments = buildTeamAssignments(team, 'fallback', 'lead', 'delegate', 'delegate');
    expect(assignments.map(item => item.handoff_payload)).toEqual([shared, shared, override, null]);
    const inherited = assignments[0].handoff_payload as typeof PAYLOAD;
    inherited.source_refs[0].pages.push(99);
    expect(assignments[1].handoff_payload).toEqual(PAYLOAD);
    expect(team.handoff_payload).toEqual(PAYLOAD);
  });

  it('preserves an injected task payload in the public intervention schema', () => {
    const team = TeamExecutionConfigSchema.parse({
      interventions: [{
        kind: 'inject_task', scope: 'task', actor_role: 'lead',
        payload: { task_id: 'injected', task_kind: 'evidence_search', delegate_role: 'delegate', delegate_id: 'reader', handoff_payload: PAYLOAD },
      }],
    });
    expect(team.interventions?.[0].payload?.handoff_payload).toEqual(PAYLOAD);
  });

  it.each(['summary only', ['not', 'an', 'object']])('rejects a non-object handoff payload: %j', handoff_payload => {
    expect(TeamExecutionConfigSchema.safeParse({ handoff_payload }).success).toBe(false);
    expect(TeamExecutionConfigSchema.safeParse({ assignments: [{ task_id: 'task', handoff_payload }] }).success).toBe(false);
  });

  it('exposes the bounded concurrency default and accepts both endpoints', () => {
    expect(TeamExecutionConfigSchema.parse({}).max_parallel).toBe(4);
    expect(TeamExecutionConfigSchema.parse({ max_parallel: 1 }).max_parallel).toBe(1);
    expect(TeamExecutionConfigSchema.parse({ max_parallel: 16 }).max_parallel).toBe(16);
  });

  it.each([0, -1, 17, 1.5])('rejects invalid public max_parallel %s', max_parallel => {
    expect(TeamExecutionConfigSchema.safeParse({ max_parallel }).success).toBe(false);
  });
});
