import { utcNowIso } from '../util.js';
import type { ResearchWorkspace, ResearchWorkspaceInput } from './workspace-types.js';

export function createResearchWorkspace(input: ResearchWorkspaceInput): ResearchWorkspace {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  for (const node of input.nodes) {
    if (nodeIds.has(node.node_id)) {
      throw new Error(`duplicate node_id: ${node.node_id}`);
    }
    nodeIds.add(node.node_id);
  }

  const primaryQuestion = input.nodes.find((node) => node.node_id === input.primary_question_id);
  if (!primaryQuestion || primaryQuestion.kind !== 'question') {
    throw new Error(`primary_question_id must point to an existing question node: ${input.primary_question_id}`);
  }

  for (const edge of input.edges) {
    if (edgeIds.has(edge.edge_id)) {
      throw new Error(`duplicate edge_id: ${edge.edge_id}`);
    }
    edgeIds.add(edge.edge_id);
    if (!nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id)) {
      throw new Error(
        `missing node reference in edge ${edge.edge_id}: ${edge.from_node_id} -> ${edge.to_node_id}`,
      );
    }
  }

  const createdAt = input.created_at ?? utcNowIso();
  return {
    schema_version: 1,
    workspace_id: input.workspace_id,
    primary_question_id: input.primary_question_id,
    nodes: [...input.nodes],
    edges: [...input.edges],
    created_at: createdAt,
    updated_at: input.updated_at ?? createdAt,
  };
}
