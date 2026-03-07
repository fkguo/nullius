export type ResearchNodeKind =
  | 'question'
  | 'idea'
  | 'evidence_set'
  | 'compute_attempt'
  | 'finding'
  | 'draft_section'
  | 'review_issue'
  | 'decision';

export type ResearchEdgeKind =
  | 'depends_on'
  | 'supports'
  | 'produces'
  | 'revises'
  | 'addresses'
  | 'branches_to'
  | 'backtracks_to';

export interface ResearchNode {
  node_id: string;
  kind: ResearchNodeKind;
  title: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchEdge {
  edge_id: string;
  kind: ResearchEdgeKind;
  from_node_id: string;
  to_node_id: string;
  rationale?: string | null;
}

export interface ResearchWorkspaceInput {
  workspace_id: string;
  primary_question_id: string;
  nodes: ResearchNode[];
  edges: ResearchEdge[];
  created_at?: string;
  updated_at?: string;
}

export interface ResearchWorkspace {
  schema_version: 1;
  workspace_id: string;
  primary_question_id: string;
  nodes: ResearchNode[];
  edges: ResearchEdge[];
  created_at: string;
  updated_at: string;
}
