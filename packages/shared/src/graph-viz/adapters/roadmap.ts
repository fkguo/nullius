import { readFileSync } from 'node:fs';
import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, NodeStyle, EdgeStyle, Adapter } from '../types.js';

// Roadmap dependency-map: the PLANNING view (milestones/lanes + dependency kinds).
// Distinct from the Claim DAG (claimDagAdapter), which is the epistemic view; the two
// use disjoint status vocabularies and share no input. Node fill encodes planning
// status, edge line encodes dependency kind (solid "unlocks" / dashed "feeds into"),
// the critical path is marked, and the goal node gets a distinct shape.

const CRITICAL_COLOR = '#b71c1c';

const STATUS_STYLES: Record<string, NodeStyle> = {
  done: { fillColor: '#e8f5e9', borderColor: '#2e7d32', peripheries: 2 },
  in_progress: { fillColor: '#e3f2fd', borderColor: '#1565c0', borderWidth: 1.7 },
  todo: { fillColor: '#f5f5f5', borderColor: '#9e9e9e' },
  deferred: { fillColor: '#fff8e1', borderColor: '#ff8f00', borderStyle: 'dotted', fontColor: '#555555' },
  candidate: { fillColor: '#ede7f6', borderColor: '#5e35b1', borderStyle: 'dashed', fontColor: '#555555' },
  _default: { fillColor: '#ffffff', borderColor: '#444444' },
};

const STATUS_ALIASES: Record<string, string> = {
  complete: 'done', completed: 'done', finished: 'done',
  'in-progress': 'in_progress', inprogress: 'in_progress', active: 'in_progress', wip: 'in_progress',
  planned: 'todo', pending: 'todo', not_started: 'todo', backlog: 'todo',
  paused: 'deferred', on_hold: 'deferred', blocked: 'deferred',
  proposed: 'candidate', optional: 'candidate', maybe: 'candidate',
};

const EDGE_ALIASES: Record<string, string> = {
  unlock: 'unlocks', requires: 'unlocks', depends_on: 'unlocks', hard: 'unlocks', blocks: 'unlocks', enables: 'unlocks',
  'feeds-into': 'feeds_into', feeds: 'feeds_into', soft: 'feeds_into', informs: 'feeds_into', optional: 'feeds_into', enhances: 'feeds_into',
};

function normalizeStatus(raw: string): string {
  const s = (raw || '').trim().toLowerCase().replace(/ /g, '_');
  if (s in STATUS_STYLES && s !== '_default') return s;
  return STATUS_ALIASES[s] ?? s;
}

function normalizeKind(raw: string): string {
  const s = (raw || '').trim().toLowerCase().replace(/ /g, '_');
  if (s === 'unlocks' || s === 'feeds_into') return s;
  return EDGE_ALIASES[s] ?? (s || 'unlocks');
}

function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'y', 'on', 'critical'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

// --- Spec types ---------------------------------------------------------

interface RoadmapNodeSpec { id?: string; label?: string; status?: string; effort?: string; cost?: string; critical?: unknown }
interface RoadmapEdgeSpec { from?: string; to?: string; source?: string; target?: string; kind?: string; type?: string; critical?: unknown }
interface RoadmapSpec { title?: string; goal?: string; nodes?: RoadmapNodeSpec[]; edges?: RoadmapEdgeSpec[] }

const roadmapStyleSheet: StyleSheet = {
  nodeStyle(node: UniversalNode): NodeStyle {
    const base: NodeStyle = { shape: 'box', ...(STATUS_STYLES[node.status ?? ''] ?? STATUS_STYLES['_default']) };
    if (node.metadata?.['goal']) base.shape = 'doubleoctagon';
    if (node.metadata?.['critical']) {
      // Keep the status fill, but flag the critical path with a heavy warning border
      // (also distinguishable in grayscale via the heavier pen).
      base.borderColor = CRITICAL_COLOR;
      base.borderWidth = 2.4;
    }
    return base;
  },
  edgeStyle(edge: UniversalEdge): EdgeStyle {
    const critical = Boolean(edge.metadata?.['critical']);
    if (edge.type === 'feeds_into') {
      return { color: critical ? CRITICAL_COLOR : '#8e8e8e', style: 'dashed', penWidth: critical ? 2.2 : undefined };
    }
    // "unlocks" (hard dependency) and any unknown kind render solid.
    return { color: critical ? CRITICAL_COLOR : '#1565c0', style: 'solid', penWidth: critical ? 2.2 : undefined };
  },
  edgeLabel(edge: UniversalEdge): string {
    if (edge.type === 'unlocks') return 'unlocks';
    if (edge.type === 'feeds_into') return 'feeds into';
    return edge.type;
  },
};

function nodeLabel(spec: RoadmapNodeSpec, id: string): string {
  const head = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : id;
  const parts = head === id ? [id] : [id, head];
  if (typeof spec.effort === 'string' && spec.effort.trim()) parts.push(`effort: ${spec.effort.trim()}`);
  if (typeof spec.cost === 'string' && spec.cost.trim()) parts.push(`cost: ${spec.cost.trim()}`);
  return parts.join('\n');
}

function buildRoadmapGraph(spec: RoadmapSpec): UniversalGraph {
  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const rawEdges = Array.isArray(spec.edges) ? spec.edges : [];
  const goalId = String(spec.goal ?? '').trim();

  const declared = new Set<string>();
  for (const n of rawNodes) {
    const id = String(n.id ?? '').trim();
    if (id) declared.add(id);
  }

  // Fail fast on a goal or an edge endpoint that is not a declared node id (a typo
  // would otherwise render a blank, statusless node), mirroring the strict contract.
  const problems: string[] = [];
  if (goalId && !declared.has(goalId)) problems.push(`goal '${goalId}' is not a declared node id`);
  rawEdges.forEach((e, i) => {
    const src = String(e.from ?? e.source ?? '').trim();
    const dst = String(e.to ?? e.target ?? '').trim();
    if (!src || !dst) { problems.push(`edge[${i}] is missing a 'from'/'to' endpoint`); return; }
    if (!declared.has(src)) problems.push(`edge[${i}] 'from' references undeclared node id '${src}'`);
    if (!declared.has(dst)) problems.push(`edge[${i}] 'to' references undeclared node id '${dst}'`);
  });
  if (problems.length > 0) {
    throw new Error('invalid roadmap spec:\n  - ' + problems.join('\n  - '));
  }

  const nodes: UniversalNode[] = [];
  for (const n of rawNodes) {
    const id = String(n.id ?? '').trim();
    if (!id) continue;
    nodes.push({
      id,
      type: 'milestone',
      label: nodeLabel(n, id),
      status: normalizeStatus(String(n.status ?? '')),
      metadata: { critical: asBool(n.critical), goal: Boolean(goalId) && id === goalId },
    });
  }

  const edges: UniversalEdge[] = [];
  rawEdges.forEach((e, i) => {
    const src = String(e.from ?? e.source ?? '').trim();
    const dst = String(e.to ?? e.target ?? '').trim();
    if (!src || !dst) return;
    const kind = normalizeKind(String(e.kind ?? e.type ?? 'unlocks'));
    edges.push({
      id: `${src}->${dst}:${kind}:${i}`,
      source: src,
      target: dst,
      type: kind,
      label: kind,
      metadata: { critical: asBool(e.critical) },
    });
  });

  const graph: UniversalGraph = { nodes, edges };
  if (typeof spec.title === 'string' && spec.title.trim()) graph.title = spec.title.trim();
  return graph;
}

export const roadmapAdapter: Adapter = {
  name: 'roadmap',
  async adapt(args) {
    const specPath = args['spec'];
    if (!specPath) throw new Error('roadmap adapter requires --spec <path>');
    const raw = JSON.parse(readFileSync(specPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) throw new Error('roadmap spec must be a JSON object');
    return { graph: buildRoadmapGraph(raw as RoadmapSpec), style: roadmapStyleSheet };
  },
};
