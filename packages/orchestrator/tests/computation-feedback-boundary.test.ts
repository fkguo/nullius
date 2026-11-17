import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputationResultV1 } from '@nullius/shared';
import { readFeedbackDeclaration } from '../src/computation/result-signal.js';
import { deriveFeedbackLowering } from '../src/computation/feedback-lowering.js';
import { deriveNextIdeaLoopState } from '../src/computation/feedback-state.js';
import { planComputationFollowupBridges } from '../src/computation/followup-bridges.js';
import { feedbackAuthorityError } from '../src/computation/feedback-authority.js';
import { createRunArtifactRef } from '../src/computation/artifact-refs.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
import { progressRunFollowups } from '../src/computation/progress-followups.js';
import { stageContentInRunDir } from '../src/computation/staged-content.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(values: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-feedback-boundary-'));
  roots.push(root);
  const files = Object.entries(values).map(([name, value]) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  });
  return { root, files };
}

function input(execution_status: 'completed' | 'failed') {
  return {
    schema_version: 1 as const, run_id: 'boundary-test', objective_title: 'Check the requested quantity', execution_status,
    manifest_ref: { uri: 'rep://runs/boundary-test/artifact/computation%2Fmanifest.json', sha256: 'a'.repeat(64) },
    produced_artifact_refs: [], summary: `Execution ${execution_status}`,
    started_at: '2026-11-17T00:00:00Z', finished_at: '2026-11-17T00:00:01Z',
    feedback_lowering: null,
    executor_provenance: { orchestrator_component: '@nullius/orchestrator', execution_surface: 'computation_manifest_executor', approval_gate: 'A3' as const, step_ids: ['calculate'], step_tools: ['python' as const] },
  };
}

function declaredResult(root: string, signal: 'success' | 'weak_signal' | 'failure'): ComputationResultV1 {
  const file = path.join(root, 'research_feedback.json');
  fs.writeFileSync(file, JSON.stringify({ feedback_signal: signal }));
  const ref = createRunArtifactRef('boundary-test', root, file, 'research_feedback');
  const base = { ...input('completed'), produced_artifact_refs: [ref], feedback_lowering: deriveFeedbackLowering({ runId: 'boundary-test', executionStatus: 'completed', signal, declarationRef: ref }) };
  const state = deriveNextIdeaLoopState(base);
  return assertComputationResultValid({ ...base, followup_bridge_refs: [], workspace_feedback: state.workspaceFeedback, next_actions: state.nextActions });
}

describe('execution is not a scientific verdict', () => {
  it.each(['completed', 'failed'] as const)('keeps an unassessed %s run without scientific follow-ups', status => {
    const { root, files } = fixture({ 'raw.json': { feedback_signal: 'success' }, 'value.json': { value: 42 } });
    expect(readFeedbackDeclaration({ executionStatus: status, producedOutputs: files })).toBeNull();
    const base = input(status);
    const result = deriveNextIdeaLoopState(base);
    expect(result.nextActions).toEqual([]);
    expect(result.workspaceFeedback.workspace.nodes.map(node => node.kind)).toEqual(['question', 'compute_attempt']);
    expect(result.workspaceFeedback.workspace.edges.every(edge => edge.kind !== 'supports')).toBe(true);
    expect(result.workspaceFeedback.tasks[0].status).toBe(status === 'completed' ? 'completed' : 'blocked');
    expect(planComputationFollowupBridges(root, { ...base, verification_refs: {} })).toEqual({ bridgePlans: [] });
  });

  it('requires exactly one designated declared output, even when declarations agree', () => {
    const { files } = fixture({ 'one/research_feedback.json': { feedback_signal: 'success' }, 'two/research_feedback.json': { feedback_signal: 'success' } });
    expect(readFeedbackDeclaration({ executionStatus: 'completed', producedOutputs: files })).toBeNull();
    expect(readFeedbackDeclaration({ executionStatus: 'completed', producedOutputs: [...files].reverse() })).toBeNull();
  });

  it.each([null, 'unknown', '{"feedback_signal":"failure",'])('rejects invalid designated feedback %j without scanning a favorable raw output', invalid => {
    const payload = typeof invalid === 'string' && invalid.startsWith('{') ? invalid : { feedback_signal: invalid };
    const { files } = fixture({ 'research_feedback.json': payload, 'raw.json': { feedback_signal: 'success' } });
    expect(readFeedbackDeclaration({ executionStatus: 'completed', producedOutputs: files })).toBeNull();
  });

  it('keeps malformed non-feedback bytes raw and a completed negative declaration separate from execution failure', () => {
    const { files } = fixture({ 'research_feedback.json': { feedback_signal: 'failure' }, 'raw.json': '{bad' });
    expect(readFeedbackDeclaration({ executionStatus: 'completed', producedOutputs: files })?.signal).toBe('failure');
    expect(readFeedbackDeclaration({ executionStatus: 'failed', producedOutputs: files })).toBeNull();
  });

  it('binds declared authority to current bytes and retains a pending evidence target without support assertions', () => {
    const { root } = fixture({});
    const result = declaredResult(root, 'success');
    expect(feedbackAuthorityError(result, root)).toBeNull();
    stageContentInRunDir({ runId: result.run_id, runDir: root, contentType: 'section_output', artifactSuffix: 'draft', content: 'Draft content' });
    const bridges = planComputationFollowupBridges(root, result);
    const state = deriveNextIdeaLoopState(result, bridges.writingSeed);
    expect(state.workspaceFeedback.workspace.nodes.find(node => node.kind === 'evidence_set')?.metadata).toEqual({ role: 'requested_work', accepted_evidence: false });
    expect(state.workspaceFeedback.workspace.edges.some(edge => edge.kind === 'supports' && edge.from_node_id === `evidence:${result.run_id}`)).toBe(false);
    fs.writeFileSync(path.join(root, 'research_feedback.json'), JSON.stringify({ feedback_signal: 'failure' }));
    expect(feedbackAuthorityError(result, root)).toMatch(/bytes changed/);
  });

  it('preserves schema-readable inferred feedback but refuses its execution without writing team state', async () => {
    const { root } = fixture({});
    const result = declaredResult(root, 'failure');
    delete result.feedback_lowering!.basis;
    delete result.feedback_lowering!.declaration_ref;
    result.execution_status = 'failed';
    result.produced_artifact_refs = [];
    const bytes = JSON.stringify(result);
    expect(assertComputationResultValid(JSON.parse(bytes))).toEqual(result);
    const launch = vi.fn();
    const outcome = await progressRunFollowups({ computationResult: result, projectRoot: root, runId: result.run_id, runDir: root, launchFeedbackTask: launch, launchWritingReviewTask: launch });
    expect(outcome.status).toBe('skipped_invalid_team_execution');
    expect(outcome.error).toMatch(/historical inferred feedback is read-only/);
    expect(launch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.nullius'))).toBe(false);
    expect(JSON.stringify(result)).toBe(bytes);
  });
});
