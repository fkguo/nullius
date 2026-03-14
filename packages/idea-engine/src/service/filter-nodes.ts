export interface NodeRecord extends Record<string, unknown> {
  campaign_id: string;
  node_id: string;
  created_at?: string;
  idea_card?: unknown;
  eval_info?: unknown;
  reduction_report?: unknown;
  grounding_audit?: { status?: string } | null;
}

export interface NodeListFilter {
  idea_id?: string;
  node_id?: string;
  island_id?: string;
  operator_id?: string;
  has_idea_card?: boolean;
  has_eval_info?: boolean;
  has_reduction_report?: boolean;
  grounding_status?: 'pass' | 'fail' | 'partial';
}

export function filterNodes(
  nodes: Record<string, NodeRecord>,
  filter: NodeListFilter | undefined,
): NodeRecord[] {
  if (!filter) {
    return Object.values(nodes);
  }

  return Object.values(nodes).filter(node => {
    if (filter.idea_id !== undefined && node.idea_id !== filter.idea_id) return false;
    if (filter.node_id !== undefined && node.node_id !== filter.node_id) return false;
    if (filter.island_id !== undefined && node.island_id !== filter.island_id) return false;
    if (filter.operator_id !== undefined && node.operator_id !== filter.operator_id) return false;
    if (filter.has_idea_card !== undefined && (node.idea_card !== null && node.idea_card !== undefined) !== filter.has_idea_card) return false;
    if (filter.has_eval_info !== undefined && (node.eval_info !== null && node.eval_info !== undefined) !== filter.has_eval_info) return false;
    if (
      filter.has_reduction_report !== undefined
      && (node.reduction_report !== null && node.reduction_report !== undefined) !== filter.has_reduction_report
    ) {
      return false;
    }
    if (filter.grounding_status !== undefined) {
      const actual = node.grounding_audit && typeof node.grounding_audit === 'object'
        ? node.grounding_audit.status
        : undefined;
      if (actual !== filter.grounding_status) return false;
    }
    return true;
  });
}
