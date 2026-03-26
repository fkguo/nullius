import * as path from 'node:path';
import type { ArtifactRefV1, ComputationResultV1, WritingReviewBridgeV1 } from '@autoresearch/shared';
import type { ReviewHandoff, ResearchEdge, ResearchNode, ResearchTaskInput, WritingHandoff } from '../research-loop/index.js';
import { createRunArtifactRef, makeRunArtifactUri } from './artifact-refs.js';
import { loopNodeIdsFor } from './feedback-lowering.js';
import { detectDraftContext, slugFor } from './followup-bridge-context.js';
import { buildReviewFollowup } from './followup-bridge-review.js';
import { writeJsonAtomic } from './io.js';
type BridgeAuthorityInput = Pick<
  ComputationResultV1,
  'run_id' | 'objective_title' | 'summary' | 'manifest_ref' | 'produced_artifact_refs' | 'feedback_lowering' | 'verification_refs'
>;

type WritingHandoffSeed = {
  handoff_kind: 'writing';
  target_node_id: string;
  payload: WritingHandoff['payload'];
};

type ReviewHandoffSeed = {
  handoff_kind: 'review';
  target_node_id: string;
  payload: ReviewHandoff['payload'];
};

type ReviewTaskSeed = {
  task: ResearchTaskInput;
  handoff: ReviewHandoffSeed;
};

export type WritingFollowupWorkspaceSeed = {
  nodes: ResearchNode[];
  edges: ResearchEdge[];
  task: ResearchTaskInput;
  handoff?: WritingHandoffSeed;
  reviewTask?: ReviewTaskSeed;
};

type PlannedBridgeArtifact = {
  artifactName: string;
  uri: string;
  payload: WritingReviewBridgeV1;
};

export type ComputationFollowupBridges = {
  bridgePlans: PlannedBridgeArtifact[];
  writingSeed?: WritingFollowupWorkspaceSeed;
};

export function planComputationFollowupBridges(runDir: string, input: BridgeAuthorityInput): ComputationFollowupBridges {
  if (input.feedback_lowering.decision_kind !== 'capture_finding') {
    return { bridgePlans: [] };
  }
  const context = detectDraftContext(runDir);
  const ids = loopNodeIdsFor(input.run_id);
  const resultUri = makeRunArtifactUri(input.run_id, 'artifacts/computation_result_v1.json');
  const producedUris = input.produced_artifact_refs.map(ref => ref.uri);
  const draftSlug = context.draftSourceArtifactName ? slugFor(context.draftSourceArtifactName) : 'seed';
  const draftNodeId = context.mode === 'existing_draft' ? `draft:${input.run_id}:${draftSlug}` : `draft-seed:${input.run_id}`;
  const reviewNodeId = `review:${input.run_id}:${draftSlug}`;
  const writingBridgeUri = makeRunArtifactUri(input.run_id, 'artifacts/writing_followup_bridge_v1.json');
  const findingNodeIds = [ids.finding] as [string, ...string[]];
  const writingTaskTitle = context.mode === 'existing_draft'
    ? `Update draft from computation finding: ${input.objective_title}`
    : `Start draft update from computation finding: ${input.objective_title}`;

  const nodes: ResearchNode[] = [{
    node_id: draftNodeId,
    kind: 'draft_section',
    title: context.mode === 'existing_draft' ? `Draft context for ${input.objective_title}` : `Draft seed for ${input.objective_title}`,
    metadata: {
      computation_result_uri: resultUri,
      draft_context_mode: context.mode,
      source_artifact_name: context.draftSourceArtifactName ?? null,
      source_content_type: context.draftSourceContentType ?? null,
      writing_bridge_uri: writingBridgeUri,
    },
  }];
  const edges: ResearchEdge[] = [{
    edge_id: `edge:${input.run_id}:finding-supports-draft`,
    kind: 'supports',
    from_node_id: ids.finding,
    to_node_id: draftNodeId,
  }];
  const writingHandoff = context.mode === 'existing_draft'
    ? {
        handoff_kind: 'writing' as const,
        target_node_id: draftNodeId,
        payload: {
          draft_node_id: draftNodeId,
          finding_node_ids: findingNodeIds,
        },
      }
    : undefined;
  const writingTask: ResearchTaskInput = {
    kind: 'draft_update',
    title: writingTaskTitle,
    target_node_id: draftNodeId,
    source: 'system',
    actor_id: null,
    metadata: {
      bridge_uri: writingBridgeUri,
      computation_result_uri: resultUri,
      produced_artifact_uris: producedUris,
    },
  };
  const bridgePlans: PlannedBridgeArtifact[] = [{
    artifactName: 'writing_followup_bridge_v1.json',
    uri: writingBridgeUri,
    payload: {
      schema_version: 1,
      bridge_kind: 'writing',
      run_id: input.run_id,
      objective_title: input.objective_title,
      feedback_signal: input.feedback_lowering.signal,
      decision_kind: input.feedback_lowering.decision_kind,
      summary: input.summary,
      computation_result_uri: resultUri,
      manifest_ref: input.manifest_ref,
      produced_artifact_refs: input.produced_artifact_refs,
      ...(input.verification_refs ? { verification_refs: input.verification_refs } : {}),
      target: {
        task_kind: 'draft_update',
        title: writingTaskTitle,
        target_node_id: draftNodeId,
        suggested_content_type: 'section_output',
        seed_payload: {
          computation_result_uri: resultUri,
          manifest_uri: input.manifest_ref.uri,
          summary: input.summary,
          produced_artifact_uris: producedUris,
          finding_node_ids: findingNodeIds,
          draft_node_id: draftNodeId,
          ...(context.draftSourceArtifactName ? { source_artifact_name: context.draftSourceArtifactName } : {}),
          ...(context.draftSourceContentType ? { source_content_type: context.draftSourceContentType } : {}),
        },
      },
      ...(writingHandoff ? { handoff: writingHandoff } : {}),
      context: {
        draft_context_mode: context.mode,
        ...(context.draftSourceArtifactName ? { draft_source_artifact_name: context.draftSourceArtifactName } : {}),
        ...(context.draftSourceContentType ? { draft_source_content_type: context.draftSourceContentType } : {}),
      },
    },
  }];

  let reviewTask: ReviewTaskSeed | undefined;
  if (context.mode === 'existing_draft') {
    const reviewBridgeUri = makeRunArtifactUri(input.run_id, 'artifacts/review_followup_bridge_v1.json');
    const reviewFollowup = buildReviewFollowup({
      context: {
        ...context,
        mode: 'existing_draft',
        draftSourceArtifactName: context.draftSourceArtifactName!,
        draftSourceContentType: context.draftSourceContentType!,
      },
      runId: input.run_id,
      objectiveTitle: input.objective_title,
      summary: input.summary,
      feedbackLowering: input.feedback_lowering,
      resultUri,
      reviewBridgeUri,
      reviewNodeId,
      draftNodeId,
      producedArtifactRefs: input.produced_artifact_refs,
      producedUris,
      manifestUri: input.manifest_ref.uri,
      manifestRef: input.manifest_ref,
      verificationRefs: input.verification_refs,
    });
    nodes.push(reviewFollowup.node);
    edges.push(reviewFollowup.edge);
    reviewTask = {
      task: reviewFollowup.task,
      handoff: reviewFollowup.handoff,
    };
    bridgePlans.push(reviewFollowup.plan);
  }

  return { bridgePlans, writingSeed: { nodes, edges, task: writingTask, ...(writingHandoff ? { handoff: writingHandoff } : {}), ...(reviewTask ? { reviewTask } : {}) } };
}

export function writeComputationFollowupBridgeArtifacts(runId: string, runDir: string, plans: PlannedBridgeArtifact[]): ArtifactRefV1[] {
  return plans.map(plan => {
    const artifactPath = path.join(runDir, 'artifacts', plan.artifactName);
    writeJsonAtomic(artifactPath, plan.payload);
    return createRunArtifactRef(runId, runDir, artifactPath, 'writing_review_bridge');
  });
}
