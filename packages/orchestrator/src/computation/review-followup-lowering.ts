import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseReviewJudgeDecisionV1 } from '@autoresearch/shared';
import { assertComputationResultValid } from './result-schema.js';
import { readStagedContentArtifactFromRunDir } from './staged-content.js';
import {
  appendRegisteredAssignment,
  buildTeamDelegateAssignment,
  findMatchingAssignment,
} from '../team-execution-assignment-builder.js';
import {
  createResearchTaskExecutionRefRegistry,
  type ResearchTaskExecutionRefRegistry,
  upsertResearchTaskExecutionRef,
} from '../research-task-execution-ref.js';
import { buildResearchTaskExecutionRef } from '../research-loop/task-execution-ref.js';
import type { TeamExecutionState } from '../team-execution-types.js';
import { writeJsonAtomic } from './io.js';

type MatchedStagedArtifact = {
  artifactName: string;
  stagedAtMs: number;
};

export type ReviewFollowupLoweringResult = {
  disposition: 'accept' | 'request_evidence_search';
  reason: string;
  judge_decision_artifact_name: string;
  lowering_artifact_name: string;
  spawned_assignment_id?: string;
  spawned_task_kind?: 'evidence_search';
  taskRefRegistry: ResearchTaskExecutionRefRegistry;
};

function isLaterArtifact(current: MatchedStagedArtifact, candidate: MatchedStagedArtifact): boolean {
  if (candidate.stagedAtMs !== current.stagedAtMs) {
    return candidate.stagedAtMs > current.stagedAtMs;
  }
  return candidate.artifactName.localeCompare(current.artifactName) > 0;
}

function reviewLoweringArtifactName(reviewTaskId: string): string {
  return `review_followup_lowering_${reviewTaskId.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`;
}

function latestTaskScopedJudgeDecisionArtifact(runDir: string, reviewTaskId: string): string | null {
  const artifactsDir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    return null;
  }
  let current: MatchedStagedArtifact | null = null;
  for (const artifactName of fs.readdirSync(artifactsDir).sort()) {
    if (!artifactName.startsWith('staged_') || !artifactName.endsWith('.json')) continue;
    try {
      const artifact = readStagedContentArtifactFromRunDir({ runDir, artifactName });
      if (
        artifact.content_type !== 'judge_decision'
        || artifact.task_ref?.task_id !== reviewTaskId
        || artifact.task_ref.task_kind !== 'review'
      ) {
        continue;
      }
      const stagedAt = Date.parse(artifact.staged_at);
      const candidate = {
        artifactName,
        stagedAtMs: Number.isFinite(stagedAt) ? stagedAt : Number.NEGATIVE_INFINITY,
      };
      current = !current || isLaterArtifact(current, candidate) ? candidate : current;
    } catch {
      continue;
    }
  }
  return current?.artifactName ?? null;
}

function loadWorkspace(runDir: string) {
  const computationResultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  if (!fs.existsSync(computationResultPath)) {
    throw new Error('computation_result_v1.json is required for review follow-up lowering');
  }
  const computationResult = assertComputationResultValid(
    JSON.parse(fs.readFileSync(computationResultPath, 'utf-8')) as unknown,
  );
  const workspace = computationResult.workspace_feedback?.workspace;
  if (!workspace) {
    throw new Error('workspace_feedback.workspace is required for review follow-up lowering');
  }
  return workspace;
}

export function lowerCompletedReviewFollowup(params: {
  runId: string;
  runDir: string;
  reviewTaskId: string;
  reviewAssignmentId: string;
  state: TeamExecutionState;
  taskRefRegistry: ResearchTaskExecutionRefRegistry | null;
}): ReviewFollowupLoweringResult {
  const reviewAssignment = params.state.delegate_assignments.find(
    assignment => assignment.assignment_id === params.reviewAssignmentId,
  );
  if (!reviewAssignment) {
    throw new Error(`unknown review assignment: ${params.reviewAssignmentId}`);
  }

  const judgeDecisionArtifactName = latestTaskScopedJudgeDecisionArtifact(params.runDir, params.reviewTaskId);
  if (!judgeDecisionArtifactName) {
    throw new Error(`missing task-scoped judge_decision for review task ${params.reviewTaskId}`);
  }

  const judgeDecisionArtifact = readStagedContentArtifactFromRunDir({
    runDir: params.runDir,
    artifactName: judgeDecisionArtifactName,
  });
  let decision;
  try {
    decision = parseReviewJudgeDecisionV1(JSON.parse(judgeDecisionArtifact.content) as unknown);
  } catch (error) {
    throw new Error(`invalid review judge_decision content: ${error instanceof Error ? error.message : String(error)}`);
  }

  const workspace = loadWorkspace(params.runDir);
  if (workspace.workspace_id !== params.state.workspace_id) {
    throw new Error(`workspace mismatch for review follow-up lowering: ${workspace.workspace_id} !== ${params.state.workspace_id}`);
  }

  let spawnedAssignmentId: string | undefined;
  let spawnedTaskKind: 'evidence_search' | undefined;
  const taskRefRegistry = params.taskRefRegistry
    ? structuredClone(params.taskRefRegistry)
    : createResearchTaskExecutionRefRegistry(params.runId);

  if (decision.disposition === 'request_evidence_search') {
    const targetNode = workspace.nodes.find(node => node.node_id === decision.target_evidence_node_id);
    if (!targetNode || targetNode.kind !== 'evidence_set') {
      throw new Error('judge_decision target_evidence_node_id must reference an evidence_set node in the current workspace');
    }

    const handoffId = `handoff-review-followup-${params.reviewTaskId}`;
    const assignmentInput = {
      stage: reviewAssignment.stage + 1,
      owner_role: reviewAssignment.owner_role,
      delegate_role: reviewAssignment.delegate_role,
      delegate_id: reviewAssignment.delegate_id,
      task_id: `evidence-search-after-${params.reviewTaskId}`,
      task_kind: 'evidence_search' as const,
      handoff_id: handoffId,
      handoff_kind: 'literature' as const,
      handoff_payload: {
        query: decision.query,
        reason: 'review_followup',
      },
      checkpoint_id: null,
      forked_from_assignment_id: reviewAssignment.assignment_id,
      forked_from_session_id: reviewAssignment.session_id,
      mcp_tool_inheritance: {
        mode: 'inherit_from_assignment' as const,
        inherit_from_assignment_id: reviewAssignment.assignment_id,
      },
    };
    const existing = findMatchingAssignment(params.state.delegate_assignments, assignmentInput);
    const spawned = existing ?? appendRegisteredAssignment(
      params.state,
      buildTeamDelegateAssignment(
        params.state,
        assignmentInput,
        reviewAssignment.delegation_protocol.REQUIRED_TOOLS.tool_names,
      ),
    );
    spawnedAssignmentId = spawned.assignment_id;
    spawnedTaskKind = 'evidence_search';
    upsertResearchTaskExecutionRef(taskRefRegistry, buildResearchTaskExecutionRef({
      workspace_id: params.state.workspace_id,
      task_id: assignmentInput.task_id,
      task_kind: assignmentInput.task_kind,
      target_node_id: decision.target_evidence_node_id,
      parent_task_id: params.reviewTaskId,
      handoff_id: handoffId,
      handoff_kind: 'literature',
      source_task_id: params.reviewTaskId,
    }), {
      assignment_id: spawned.assignment_id,
      checkpoint_id: spawned.checkpoint_id,
      session_id: spawned.session_id,
    });
  }

  const loweringArtifactName = reviewLoweringArtifactName(params.reviewTaskId);
  writeJsonAtomic(path.join(params.runDir, 'artifacts', loweringArtifactName), {
    schema_version: 1,
    run_id: params.runId,
    review_task_id: params.reviewTaskId,
    judge_decision_artifact_name: judgeDecisionArtifactName,
    disposition: decision.disposition,
    reason: decision.reason,
    ...(spawnedAssignmentId ? { spawned_assignment_id: spawnedAssignmentId } : {}),
    ...(spawnedTaskKind ? { spawned_task_kind: spawnedTaskKind } : {}),
  });

  return {
    disposition: decision.disposition,
    reason: decision.reason,
    judge_decision_artifact_name: judgeDecisionArtifactName,
    lowering_artifact_name: loweringArtifactName,
    ...(spawnedAssignmentId ? { spawned_assignment_id: spawnedAssignmentId } : {}),
    ...(spawnedTaskKind ? { spawned_task_kind: spawnedTaskKind } : {}),
    taskRefRegistry,
  };
}
