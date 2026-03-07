import type { ResearchEventSource } from './task-types.js';

interface BaseResearchHandoff<Kind extends string, Payload extends Record<string, unknown>> {
  handoff_id: string;
  handoff_kind: Kind;
  workspace_id: string;
  source_task_id: string;
  target_node_id: string;
  source: ResearchEventSource;
  actor_id: string | null;
  created_at: string;
  payload: Payload;
}

export type ComputeHandoff = BaseResearchHandoff<'compute', {
  hypothesis_node_ids: string[];
  expected_artifacts: string[];
}>;

export type FeedbackHandoff = BaseResearchHandoff<'feedback', {
  disposition: 'refine_idea' | 'branch_idea' | 'downgrade_idea';
  related_finding_node_id?: string;
}>;

export type LiteratureHandoff = BaseResearchHandoff<'literature', {
  query: string;
  reason: 'initial' | 'compute_backtrack' | 'review_followup';
}>;

export type ReviewHandoff = BaseResearchHandoff<'review', {
  issue_node_id: string;
  target_draft_node_id?: string;
}>;

export type WritingHandoff = BaseResearchHandoff<'writing', {
  draft_node_id: string;
  finding_node_ids: string[];
}>;

export type ResearchHandoff = ComputeHandoff | FeedbackHandoff | LiteratureHandoff | ReviewHandoff | WritingHandoff;
