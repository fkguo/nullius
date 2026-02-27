import { readFileSync } from 'node:fs';
import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, NodeStyle, EdgeStyle, Adapter } from '../types.js';

// --- ProgressItem schema ------------------------------------------------

export interface ProgressItem {
  id: string;
  type: 'milestone' | 'task';
  title: string;
  workstream?: string;
  status: 'converged' | 'active' | 'pending' | 'blocked';
  depends_on?: string[];
}

// --- StyleSheet ---------------------------------------------------------

const NODE_STYLES: Record<string, NodeStyle> = {
  converged: { shape: 'box',     fillColor: '#e8f5e9', borderColor: '#2e7d32' },
  active:    { shape: 'box',     fillColor: '#e3f2fd', borderColor: '#1565c0' },
  blocked:   { shape: 'octagon', fillColor: '#ffebee', borderColor: '#c62828' },
  pending:   { shape: 'box',     fillColor: '#f5f5f5', borderColor: '#9e9e9e' },
};

const progressStyleSheet: StyleSheet = {
  nodeStyle(node: UniversalNode): NodeStyle {
    const base = NODE_STYLES[node.status ?? 'pending'] ?? NODE_STYLES['pending'];
    if (node.type === 'milestone') return { ...base, shape: 'doubleoctagon' };
    return base;
  },
  edgeStyle(_edge: UniversalEdge): EdgeStyle {
    return { color: '#555555', style: 'solid' };
  },
  edgeLabel(_edge: UniversalEdge): string {
    return 'enables';
  },
  reverseEdge(edge: UniversalEdge): boolean {
    return edge.type === 'depends_on';
  },
};

// --- Graph builder ------------------------------------------------------

function nodeWeight(status: string): number {
  if (status === 'converged') return 1.0;
  if (status === 'active')    return 0.5;
  return 0.0;
}

function buildProgressGraph(items: ProgressItem[]): UniversalGraph {
  const nodes: UniversalNode[] = items.map(item => ({
    id: item.id,
    type: item.type,
    label: item.title,
    group: item.workstream,
    status: item.status,
    weight: nodeWeight(item.status),
  }));

  const edges: UniversalEdge[] = [];
  for (const item of items) {
    for (const dep of (item.depends_on ?? [])) {
      edges.push({
        id: `${item.id}→${dep}:depends_on`,
        source: item.id,
        target: dep,
        type: 'depends_on',
        label: 'enables',
      });
    }
  }

  return { nodes, edges };
}

// --- Adapter ------------------------------------------------------------

export const progressAdapter: Adapter = {
  name: 'progress',
  async adapt(args) {
    const planPath = args['plan'];
    if (!planPath) throw new Error('progress adapter requires --plan');
    let items: ProgressItem[];
    if (planPath.endsWith('.md')) {
      const { parseProgressMd } = await import('../parse-progress.js');
      items = parseProgressMd(readFileSync(planPath, 'utf8'));
    } else {
      items = JSON.parse(readFileSync(planPath, 'utf8')) as ProgressItem[];
    }
    return { graph: buildProgressGraph(items), style: progressStyleSheet };
  },
};
