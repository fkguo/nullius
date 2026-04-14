import { randomUUID } from 'node:crypto';
import type { ComputationResultV1 } from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import { loopNodeIdsFor } from './feedback-lowering.js';

type WorkspaceFeedback = ComputationResultV1['workspace_feedback'];
type WorkspaceNode = WorkspaceFeedback['workspace']['nodes'][number];
type WorkspaceEdge = WorkspaceFeedback['workspace']['edges'][number];
type WorkspaceEvent = WorkspaceFeedback['events'][number];

function cloneWorkspaceFeedback(workspaceFeedback: WorkspaceFeedback): WorkspaceFeedback {
  return {
    ...workspaceFeedback,
    workspace: {
      ...workspaceFeedback.workspace,
      nodes: workspaceFeedback.workspace.nodes.map((node) => ({ ...node, ...(node.metadata ? { metadata: { ...node.metadata } } : {}) })),
      edges: workspaceFeedback.workspace.edges.map((edge) => ({ ...edge })),
    },
    tasks: workspaceFeedback.tasks.map((task) => ({ ...task, ...(task.metadata ? { metadata: { ...task.metadata } } : {}) })),
    events: workspaceFeedback.events.map((event) => ({ ...event, payload: { ...event.payload } })),
    handoffs: workspaceFeedback.handoffs.map((handoff) => ({ ...handoff, payload: { ...handoff.payload } })),
    active_task_ids: [...workspaceFeedback.active_task_ids],
  };
}

function upsertNode(workspaceFeedback: WorkspaceFeedback, node: WorkspaceNode): void {
  const existing = workspaceFeedback.workspace.nodes.find((candidate) => candidate.node_id === node.node_id);
  if (!existing) {
    workspaceFeedback.workspace.nodes.push(node);
    workspaceFeedback.workspace.updated_at = utcNowIso();
    return;
  }
  existing.title = node.title;
  existing.metadata = {
    ...(existing.metadata ?? {}),
    ...(node.metadata ?? {}),
  };
  workspaceFeedback.workspace.updated_at = utcNowIso();
}

function upsertEdge(workspaceFeedback: WorkspaceFeedback, edge: WorkspaceEdge): void {
  const existing = workspaceFeedback.workspace.edges.find((candidate) => candidate.edge_id === edge.edge_id);
  if (existing) {
    return;
  }
  workspaceFeedback.workspace.edges.push(edge);
  workspaceFeedback.workspace.updated_at = utcNowIso();
}

function appendEvent(workspaceFeedback: WorkspaceFeedback, payload: Record<string, unknown>): void {
  const event: WorkspaceEvent = {
    event_id: randomUUID(),
    event_type: 'intervention_recorded',
    created_at: utcNowIso(),
    source: 'system',
    actor_id: null,
    task_id: null,
    checkpoint_id: null,
    handoff_id: null,
    payload,
  };
  workspaceFeedback.events.push(event);
}

function verificationDecisionNodeId(runId: string): string {
  return `decision:verification:${runId}`;
}

function finalConclusionsDecisionNodeId(runId: string): string {
  return `decision:final-conclusions:${runId}`;
}

function ensureVerificationDecisionNode(
  result: ComputationResultV1,
  workspaceFeedback: WorkspaceFeedback,
  params: { status: 'passed' | 'failed' | 'blocked'; summary: string; check_run_uri: string; verdict_uri: string; coverage_uri: string },
): void {
  const verificationNodeId = verificationDecisionNodeId(result.run_id);
  upsertNode(workspaceFeedback, {
    node_id: verificationNodeId,
    kind: 'decision',
    title: `Verification decision for ${result.objective_title}`,
    metadata: {
      boundary: 'verification',
      verification_status: params.status,
      summary: params.summary,
      check_run_uri: params.check_run_uri,
      verdict_uri: params.verdict_uri,
      coverage_uri: params.coverage_uri,
    },
  });
  const computeNodeId = loopNodeIdsFor(result.run_id).compute;
  if (workspaceFeedback.workspace.nodes.some((node) => node.node_id === computeNodeId)) {
    upsertEdge(workspaceFeedback, {
      edge_id: `edge:${result.run_id}:compute-verification-decision`,
      kind: 'produces',
      from_node_id: computeNodeId,
      to_node_id: verificationNodeId,
      rationale: 'Decisive verification records the next typed loop boundary for the canonical compute attempt.',
    });
  }
}

function ensureFinalConclusionsDecisionNode(
  result: ComputationResultV1,
  workspaceFeedback: WorkspaceFeedback,
  metadata: Record<string, unknown>,
): void {
  const finalNodeId = finalConclusionsDecisionNodeId(result.run_id);
  upsertNode(workspaceFeedback, {
    node_id: finalNodeId,
    kind: 'decision',
    title: `Final conclusions boundary for ${result.objective_title}`,
    metadata: {
      boundary: 'final_conclusions',
      ...metadata,
    },
  });
  const verificationNodeId = verificationDecisionNodeId(result.run_id);
  const sourceNodeId = workspaceFeedback.workspace.nodes.some((node) => node.node_id === verificationNodeId)
    ? verificationNodeId
    : loopNodeIdsFor(result.run_id).compute;
  if (workspaceFeedback.workspace.nodes.some((node) => node.node_id === sourceNodeId)) {
    upsertEdge(workspaceFeedback, {
      edge_id: `edge:${result.run_id}:verification-final-conclusions-decision`,
      kind: 'supports',
      from_node_id: sourceNodeId,
      to_node_id: finalNodeId,
      rationale: 'Final conclusions remain downstream of decisive verification and the canonical compute path.',
    });
  }
}

export function attachVerificationBoundaryToWorkspaceFeedback(
  result: ComputationResultV1,
  params: { status: 'passed' | 'failed' | 'blocked'; summary: string; check_run_uri: string; verdict_uri: string; coverage_uri: string },
): ComputationResultV1 {
  if (!result.workspace_feedback) {
    return result;
  }
  const workspaceFeedback = cloneWorkspaceFeedback(result.workspace_feedback);
  ensureVerificationDecisionNode(result, workspaceFeedback, params);
  appendEvent(workspaceFeedback, {
    intervention_kind: 'verify',
    boundary: 'verification',
    verification_status: params.status,
    summary: params.summary,
    check_run_uri: params.check_run_uri,
    verdict_uri: params.verdict_uri,
    coverage_uri: params.coverage_uri,
  });
  return {
    ...result,
    workspace_feedback: workspaceFeedback,
  };
}

export function attachFinalConclusionsRequestToWorkspaceFeedback(
  result: ComputationResultV1,
  params: { approval_id: string; gate_summary: string; packet_json_path: string },
): ComputationResultV1 {
  if (!result.workspace_feedback) {
    return result;
  }
  const workspaceFeedback = cloneWorkspaceFeedback(result.workspace_feedback);
  ensureFinalConclusionsDecisionNode(result, workspaceFeedback, {
    approval_id: params.approval_id,
    status: 'pending_approval',
    gate_id: 'A5',
    gate_summary: params.gate_summary,
    packet_json_path: params.packet_json_path,
  });
  appendEvent(workspaceFeedback, {
    intervention_kind: 'request_final_conclusions',
    boundary: 'final_conclusions_request',
    approval_id: params.approval_id,
    gate_id: 'A5',
    gate_summary: params.gate_summary,
    packet_json_path: params.packet_json_path,
  });
  return {
    ...result,
    workspace_feedback: workspaceFeedback,
  };
}

export function attachFinalConclusionsApprovalToWorkspaceFeedback(
  result: ComputationResultV1,
  params: { approval_id: string; final_conclusions_path: string; final_conclusions_uri: string },
): ComputationResultV1 {
  if (!result.workspace_feedback) {
    return result;
  }
  const workspaceFeedback = cloneWorkspaceFeedback(result.workspace_feedback);
  ensureFinalConclusionsDecisionNode(result, workspaceFeedback, {
    approval_id: params.approval_id,
    status: 'approved',
    gate_id: 'A5',
    final_conclusions_path: params.final_conclusions_path,
    final_conclusions_uri: params.final_conclusions_uri,
  });
  appendEvent(workspaceFeedback, {
    intervention_kind: 'approve',
    boundary: 'final_conclusions_approved',
    approval_id: params.approval_id,
    gate_id: 'A5',
    final_conclusions_path: params.final_conclusions_path,
    final_conclusions_uri: params.final_conclusions_uri,
  });
  return {
    ...result,
    workspace_feedback: workspaceFeedback,
  };
}
