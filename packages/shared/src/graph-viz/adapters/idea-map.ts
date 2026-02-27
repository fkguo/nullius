import { readFileSync } from 'node:fs';
import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, NodeStyle, EdgeStyle, Adapter } from '../types.js';

// --- Node types ---------------------------------------------------------

type IdeaStatus = 'seed' | 'refined' | 'formalized' | 'evaluated';

const IDEA_STATUS_FILL: Record<IdeaStatus, string> = {
  seed:      '#fff3e0',
  refined:   '#e8f5e9',
  formalized:'#e3f2fd',
  evaluated: '#f3e5f5',
};

// --- StyleSheet ---------------------------------------------------------

const ideaStyleSheet: StyleSheet = {
  nodeStyle(node: UniversalNode): NodeStyle {
    if (node.type === 'idea_node') {
      const fill = IDEA_STATUS_FILL[(node.status ?? 'seed') as IdeaStatus] ?? '#fff3e0';
      return { shape: 'box', fillColor: fill };
    }
    if (node.type === 'claim')     return { shape: 'ellipse',   fillColor: '#e8eaf6' };
    if (node.type === 'evidence')  return { shape: 'note',      fillColor: '#fce4ec' };
    if (node.type === 'formalism') return { shape: 'component', fillColor: '#e0f2f1' };
    return { shape: 'box', fillColor: '#f5f5f5' };
  },
  edgeStyle(edge: UniversalEdge): EdgeStyle {
    const styles: Record<string, EdgeStyle> = {
      parent_of:      { color: '#555555', style: 'solid' },
      supports:       { color: '#2e7d32', style: 'solid' },
      refutes:        { color: '#c62828', style: 'dashed' },
      mentions:       { color: '#9e9e9e', style: 'dotted' },
      derived_from:   { color: '#1565c0', style: 'solid' },
      uses_formalism: { color: '#00695c', style: 'dotted' },
    };
    return styles[edge.type] ?? { color: '#9e9e9e', style: 'solid' };
  },
};

// --- Data types ---------------------------------------------------------

interface IdeaCard { thesis_statement?: string; candidate_formalisms?: string[] }
interface EvalInfo { scores?: Record<string, number> }
interface IdeaNode {
  node_id: string;
  operator_family?: string;
  parent_node_ids?: string[];
  idea_card?: IdeaCard;
  eval_info?: EvalInfo;
}

interface EvNode { id: string; kind: 'claim' | 'evidence' | 'idea_node'; label?: string }
interface EvEdge { from: string; to: string; relation: string; confidence?: number }
interface EvidenceGraph { nodes?: EvNode[]; edges?: EvEdge[] }

// --- Helpers ------------------------------------------------------------

function avgScore(scores: Record<string, number> | undefined): number {
  if (!scores) return 0;
  const vals = Object.values(scores);
  if (vals.length === 0) return 0;
  const sum = vals.reduce((a, b) => a + b, 0);
  const avg = sum / vals.length;
  return isNaN(avg) ? 0 : avg;
}

function pipelineStatus(node: IdeaNode): IdeaStatus {
  if (node.eval_info?.scores) return 'evaluated';
  if (node.idea_card?.candidate_formalisms?.length) return 'formalized';
  if (node.idea_card?.thesis_statement) return 'refined';
  return 'seed';
}

function parseJsonl<T>(text: string): T[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as T);
}

// --- Graph builder ------------------------------------------------------

function buildIdeaGraph(ideaNodes: IdeaNode[], evidenceGraph: EvidenceGraph): UniversalGraph {
  const nodes: UniversalNode[] = [];
  const edges: UniversalEdge[] = [];
  const ideaIds = new Set(ideaNodes.map(n => 'idea:' + n.node_id));

  // IdeaNodes
  const formalismSet = new Set<string>();
  for (const n of ideaNodes) {
    const status = pipelineStatus(n);
    nodes.push({
      id: 'idea:' + n.node_id,
      type: 'idea_node',
      label: n.idea_card?.thesis_statement?.slice(0, 80) ?? n.node_id,
      group: n.operator_family,
      status,
      weight: avgScore(n.eval_info?.scores),
    });
    for (const pid of (n.parent_node_ids ?? [])) {
      edges.push({ source: 'idea:' + pid, target: 'idea:' + n.node_id, type: 'parent_of' });
    }
    for (const f of (n.idea_card?.candidate_formalisms ?? [])) {
      formalismSet.add(f);
      edges.push({ source: 'idea:' + n.node_id, target: 'form:' + f, type: 'uses_formalism' });
    }
  }

  // Formalism nodes
  for (const f of formalismSet) {
    nodes.push({ id: 'form:' + f, type: 'formalism', label: f });
  }

  // Evidence graph nodes (skip idea_node kind - already covered)
  for (const en of (evidenceGraph.nodes ?? [])) {
    if (en.kind === 'idea_node') continue;
    nodes.push({ id: 'ev:' + en.id, type: en.kind, label: en.label ?? en.id });
  }

  // Evidence graph edges
  for (const ee of (evidenceGraph.edges ?? [])) {
    const srcId = ideaIds.has('idea:' + ee.from) ? 'idea:' + ee.from : 'ev:' + ee.from;
    const tgtId = ideaIds.has('idea:' + ee.to)   ? 'idea:' + ee.to   : 'ev:' + ee.to;
    edges.push({
      source: srcId,
      target: tgtId,
      type: ee.relation,
      label: ee.relation,
      weight: ee.confidence,
    });
  }

  return { nodes, edges };
}

// --- Adapter ------------------------------------------------------------

export const ideaMapAdapter: Adapter = {
  name: 'idea-map',
  async adapt(args) {
    const nodesPath  = args['nodes'];
    const evidencePath = args['evidence'];
    if (!nodesPath || !evidencePath) {
      throw new Error('idea-map adapter requires --nodes and --evidence');
    }
    const ideaNodesRaw = readFileSync(nodesPath, 'utf8');
    const ideaNodes: IdeaNode[] = ideaNodesRaw.trim().startsWith('[')
      ? JSON.parse(ideaNodesRaw) as IdeaNode[]
      : parseJsonl<IdeaNode>(ideaNodesRaw);
    const evidenceGraph = JSON.parse(readFileSync(evidencePath, 'utf8')) as EvidenceGraph;
    return { graph: buildIdeaGraph(ideaNodes, evidenceGraph), style: ideaStyleSheet };
  },
};
