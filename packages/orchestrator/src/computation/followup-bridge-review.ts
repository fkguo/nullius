import type { ComputationResultV1, WritingReviewBridgeV1 } from '@autoresearch/shared';
import type { ReviewHandoff, ResearchEdge, ResearchNode, ResearchTaskInput } from '../research-loop/index.js';
import type { DraftContext } from './followup-bridge-context.js';

type ReviewHandoffSeed = {
  handoff_kind: 'review';
  target_node_id: string;
  payload: ReviewHandoff['payload'];
};

export type ReviewFollowupBuildResult = {
  node: ResearchNode;
  edge: ResearchEdge;
  task: ResearchTaskInput;
  handoff: ReviewHandoffSeed;
  plan: {
    artifactName: string;
    uri: string;
    payload: WritingReviewBridgeV1;
  };
};

export function buildReviewFollowup(params: {
  context: DraftContext & { mode: 'existing_draft'; draftSourceArtifactName: string; draftSourceContentType: 'section_output' | 'reviewer_report' | 'revision_plan' };
  runId: string;
  objectiveTitle: string;
  summary: string;
  feedbackLowering: ComputationResultV1['feedback_lowering'];
  resultUri: string;
  reviewBridgeUri: string;
  reviewNodeId: string;
  draftNodeId: string;
  producedArtifactRefs: ComputationResultV1['produced_artifact_refs'];
  producedUris: string[];
  manifestUri: string;
  manifestRef: ComputationResultV1['manifest_ref'];
  verificationRefs: ComputationResultV1['verification_refs'];
}): ReviewFollowupBuildResult {
  const reviewTaskTitle = `Review draft after computation finding: ${params.objectiveTitle}`;
  const handoff: ReviewHandoffSeed = {
    handoff_kind: 'review',
    target_node_id: params.reviewNodeId,
    payload: {
      issue_node_id: params.reviewNodeId,
      target_draft_node_id: params.draftNodeId,
    },
  };
  return {
    node: {
      node_id: params.reviewNodeId,
      kind: 'review_issue',
      title: `Review issue for ${params.objectiveTitle}`,
      metadata: {
        computation_result_uri: params.resultUri,
        source_artifact_name: params.context.reviewSourceArtifactName ?? params.context.draftSourceArtifactName,
        source_content_type: params.context.reviewSourceContentType ?? params.context.draftSourceContentType,
        review_bridge_uri: params.reviewBridgeUri,
      },
    },
    edge: {
      edge_id: `edge:${params.runId}:review-revises-draft`,
      kind: 'revises',
      from_node_id: params.reviewNodeId,
      to_node_id: params.draftNodeId,
    },
    task: {
      kind: 'review',
      title: reviewTaskTitle,
      target_node_id: params.reviewNodeId,
      source: 'system',
      actor_id: null,
      metadata: {
        bridge_uri: params.reviewBridgeUri,
        computation_result_uri: params.resultUri,
        target_draft_node_id: params.draftNodeId,
      },
    },
    handoff,
    plan: {
      artifactName: 'review_followup_bridge_v1.json',
      uri: params.reviewBridgeUri,
      payload: {
        schema_version: 1,
        bridge_kind: 'review',
        run_id: params.runId,
        objective_title: params.objectiveTitle,
        feedback_signal: params.feedbackLowering.signal,
        decision_kind: params.feedbackLowering.decision_kind,
        summary: params.summary,
        computation_result_uri: params.resultUri,
        manifest_ref: params.manifestRef,
        produced_artifact_refs: params.producedArtifactRefs,
        ...(params.verificationRefs ? { verification_refs: params.verificationRefs } : {}),
        target: {
          task_kind: 'review',
          title: reviewTaskTitle,
          target_node_id: params.reviewNodeId,
          suggested_content_type: params.context.reviewSourceContentType === 'revision_plan' ? 'revision_plan' : 'reviewer_report',
          seed_payload: {
            computation_result_uri: params.resultUri,
            manifest_uri: params.manifestUri,
            summary: params.summary,
            produced_artifact_uris: params.producedUris,
            issue_node_id: params.reviewNodeId,
            target_draft_node_id: params.draftNodeId,
            source_artifact_name: params.context.reviewSourceArtifactName ?? params.context.draftSourceArtifactName,
            source_content_type: params.context.reviewSourceContentType ?? params.context.draftSourceContentType,
          },
        },
        handoff,
        context: {
          draft_context_mode: params.context.mode,
          draft_source_artifact_name: params.context.draftSourceArtifactName,
          draft_source_content_type: params.context.draftSourceContentType,
          ...(params.context.reviewSourceArtifactName ? { review_source_artifact_name: params.context.reviewSourceArtifactName } : {}),
          ...(params.context.reviewSourceContentType ? { review_source_content_type: params.context.reviewSourceContentType } : {}),
        },
      },
    },
  };
}
