import { readFileSync } from 'node:fs';
import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, NodeStyle, EdgeStyle, Adapter } from '../graph-viz/types.js';

// --- MemoryGraph types (from generated schemas) -------------------------

interface MgNode {
  id: string;
  node_type: string;
  track?: string;
  weight?: number;
  payload?: Record<string, unknown>;
}

interface MgEdge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  weight?: number;
  payload?: Record<string, unknown>;
}

// --- StyleSheet ---------------------------------------------------------

const NODE_STYLES: Record<string, NodeStyle> = {
  signal:            { shape: 'hexagon',       fillColor: '#fff3e0' },
  gene:              { shape: 'box',            fillColor: '#e8f5e9' },
  capsule:           { shape: 'ellipse',        fillColor: '#e3f2fd' },
  outcome_success:   { shape: 'diamond',        fillColor: '#c8e6c9' },
  outcome_fail:      { shape: 'diamond',        fillColor: '#ffcdd2' },
  skill:             { shape: 'doubleoctagon',  fillColor: '#f3e5f5' },
  module:            { shape: 'folder',         fillColor: '#eceff1' },
  test:              { shape: 'triangle',       fillColor: '#e8eaf6' },
  approval_pattern:  { shape: 'house',          fillColor: '#fce4ec' },
  _default:          { shape: 'box',            fillColor: '#f5f5f5' },
};

const EDGE_STYLES: Record<string, EdgeStyle> = {
  triggered_by: { color: '#9e9e9e', style: 'solid' },
  confidence:   { color: '#1565c0', style: 'solid' },
  resolved_by:  { color: '#2e7d32', style: 'solid' },
  produced:     { color: '#555555', style: 'solid' },
  supersedes:   { color: '#546e7a', style: 'solid' },
  generalizes:  { color: '#7b1fa2', style: 'dashed' },
  spawned_skill:{ color: '#f3e5f5', style: 'dotted' },
  co_change:    { color: '#ff8f00', style: 'dashed' },
  failure_in:   { color: '#c62828', style: 'dashed' },
  _default:     { color: '#9e9e9e', style: 'solid' },
};

function weightToStatus(weight: number | undefined): string {
  if (weight === undefined) return 'active';
  if (weight > 0.5)  return 'active';
  if (weight >= 0.1) return 'decaying';
  return 'archived';
}

function nodeShape(nodeType: string, weight: number | undefined): NodeStyle {
  if (nodeType === 'outcome') {
    return weight !== undefined && weight > 0.5 ? NODE_STYLES['outcome_success'] : NODE_STYLES['outcome_fail'];
  }
  return NODE_STYLES[nodeType] ?? NODE_STYLES['_default'];
}

const memoryGraphStyleSheet: StyleSheet = {
  nodeStyle(node: UniversalNode): NodeStyle {
    return nodeShape(node.type, node.weight);
  },
  edgeStyle(edge: UniversalEdge): EdgeStyle {
    const base = EDGE_STYLES[edge.type] ?? EDGE_STYLES['_default'];
    if (edge.type === 'confidence' && edge.weight !== undefined) {
      return { ...base, penWidth: Math.max(0.5, edge.weight * 3) };
    }
    return base;
  },
};

// --- Helpers ------------------------------------------------------------

function labelOf(node: MgNode): string {
  const p = node.payload ?? {};
  const name = p['name'] ?? p['gene_id'];
  if (typeof name === 'string' && name) return name;
  return node.node_type + ':' + node.id;
}

function parseJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8');
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as T);
}

// --- Graph builder ------------------------------------------------------

function buildMemoryGraph(mgNodes: MgNode[], mgEdges: MgEdge[]): UniversalGraph {
  const nodeIds = new Set(mgNodes.map(n => n.id));

  const nodes: UniversalNode[] = mgNodes.map(n => ({
    id: n.id,
    type: n.node_type,
    label: labelOf(n),
    group: n.track,
    status: weightToStatus(n.weight),
    weight: n.weight,
    metadata: n.payload,
  }));

  // Closed subgraph: only include edges where both endpoints exist
  const edges: UniversalEdge[] = mgEdges
    .filter(e => nodeIds.has(e.source_id) && nodeIds.has(e.target_id))
    .map(e => ({
      id: e.id,
      source: e.source_id,
      target: e.target_id,
      type: e.edge_type,
      label: e.edge_type,
      weight: e.weight,
      metadata: e.payload,
    }));

  return { nodes, edges };
}

// --- Adapter ------------------------------------------------------------

export const memoryGraphAdapter: Adapter = {
  name: 'memory-graph',
  async adapt(args) {
    const nodesPath = args['nodes'];
    const edgesPath = args['edges'];
    if (!nodesPath || !edgesPath) {
      throw new Error('memory-graph adapter requires --nodes <jsonl> --edges <jsonl>');
    }
    const mgNodes = parseJsonl<MgNode>(nodesPath);
    const mgEdges = parseJsonl<MgEdge>(edgesPath);
    return { graph: buildMemoryGraph(mgNodes, mgEdges), style: memoryGraphStyleSheet };
  },
};
