import { readFileSync } from 'node:fs';
import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, NodeStyle, EdgeStyle, Adapter } from '../types.js';

// --- StyleSheet ---------------------------------------------------------

const NODE_STYLES: Record<string, NodeStyle> = {
  'verified':              { shape: 'box', fillColor: '#e8f5e9', borderColor: '#2e7d32', peripheries: 2 },
  'verified_with_dissent': { shape: 'box', fillColor: '#fff8e1', borderColor: '#ff8f00', peripheries: 2, borderStyle: 'dashed' },
  'active':                { shape: 'box', fillColor: '#e3f2fd', borderColor: '#1565c0', borderWidth: 1.6 },
  'under_review':          { shape: 'box', fillColor: '#eeeeee', borderStyle: 'dotted' },
  'draft':                 { shape: 'box', fillColor: '#f5f5f5', borderStyle: 'dashed' },
  'paused':                { shape: 'box', fillColor: '#f5f5f5', borderStyle: 'dotted', fontColor: '#555555' },
  'stalled':               { shape: 'box', fillColor: '#f5f5f5', borderStyle: 'dotted', fontColor: '#555555' },
  'archived':              { shape: 'box', fillColor: '#f5f5f5', borderStyle: 'dotted', fontColor: '#555555' },
  'superseded':            { shape: 'box', fillColor: '#eceff1', borderColor: '#546e7a', borderStyle: 'dotted', fontColor: '#555555' },
  'refuted':               { shape: 'octagon', fillColor: '#ffebee', borderColor: '#c62828', borderWidth: 2.2 },
  'disputed':              { shape: 'diamond', fillColor: '#fce4ec', borderColor: '#ad1457', borderStyle: 'dashed', borderWidth: 2.0 },
  '_default':              { shape: 'box', fillColor: '#ffffff', borderColor: '#444444' },
};

const EDGE_STYLES: Record<string, EdgeStyle & { displayLabel: string; reverse?: boolean }> = {
  'supports':    { color: '#2e7d32', style: 'solid',  displayLabel: 'supports' },
  'contradicts': { color: '#c62828', style: 'dashed', displayLabel: 'contradicts' },
  'requires':    { color: '#555555', style: 'solid',  displayLabel: 'enables',      reverse: true },
  'competitor':  { color: '#ef6c00', style: 'dashed', displayLabel: 'competitor' },
  'fork':        { color: '#1565c0', style: 'dotted', displayLabel: 'fork' },
  'supersedes':  { color: '#546e7a', style: 'solid',  displayLabel: 'superseded by', reverse: true },
  '_default':    { color: '#555555', style: 'solid',  displayLabel: '' },
};

const claimStyleSheet: StyleSheet = {
  nodeStyle(node: UniversalNode): NodeStyle {
    return NODE_STYLES[node.status ?? ''] ?? NODE_STYLES['_default'];
  },
  edgeStyle(edge: UniversalEdge): EdgeStyle {
    const def = EDGE_STYLES[edge.type] ?? EDGE_STYLES['_default'];
    return { color: def.color, style: def.style, penWidth: def.penWidth };
  },
  edgeLabel(edge: UniversalEdge): string {
    return EDGE_STYLES[edge.type]?.displayLabel ?? edge.type;
  },
  reverseEdge(edge: UniversalEdge): boolean {
    return EDGE_STYLES[edge.type]?.reverse ?? false;
  },
};

// --- Adapter ------------------------------------------------------------

interface ClaimRecord { id: string; statement: string; status?: string; [k: string]: unknown }
interface EdgeRecord  { source: string; target: string; type: string; [k: string]: unknown }

function parseJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as T);
}

function buildClaimGraph(claims: ClaimRecord[], edges: EdgeRecord[]): UniversalGraph {
  const nodes: UniversalNode[] = claims.map(c => ({
    id: c.id,
    type: 'claim',
    label: c.id + '\n' + (c.statement ?? ''),
    status: c.status,
    metadata: c as Record<string, unknown>,
  }));

  const graphEdges: UniversalEdge[] = edges.map(e => ({
    id: `${e.source}→${e.target}:${e.type}`,
    source: e.source,
    target: e.target,
    type: e.type,
    label: e.type,
    metadata: e as Record<string, unknown>,
  }));

  return { nodes, edges: graphEdges };
}

export const claimDagAdapter: Adapter = {
  name: 'claim',
  async adapt(args) {
    const claimsPath = args['claims'];
    const edgesPath = args['edges'];
    if (!claimsPath || !edgesPath) throw new Error('claim adapter requires --claims and --edges');
    const claims = parseJsonl<ClaimRecord>(claimsPath);
    const edges = parseJsonl<EdgeRecord>(edgesPath);
    return { graph: buildClaimGraph(claims, edges), style: claimStyleSheet };
  },
};
