import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, RenderOptions } from './types.js';

const DEFAULT_MAX_LABEL = 80;
const DEFAULT_WRAP_WIDTH = 34;
const DEFAULT_LEGEND_THRESHOLD = 30;

// --- DOT escaping -------------------------------------------------------

function escapeDotId(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function wrapLabel(text: string, wrapWidth: number): string {
  if (wrapWidth <= 0) return text;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current.length === 0) {
      current = w;
    } else if (current.length + 1 + w.length <= wrapWidth) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.join('\\n');
}

function truncate(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function formatLabel(raw: string, maxLabel: number, wrapWidth: number): string {
  let s = raw;
  if (maxLabel > 0) s = truncate(s, maxLabel);
  s = wrapLabel(s, wrapWidth);
  return s;
}

// --- Validation ---------------------------------------------------------

interface Warning { message: string }

function validateGraph(graph: UniversalGraph): { errors: string[]; warnings: Warning[] } {
  const errors: string[] = [];
  const warnings: Warning[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) {
      warnings.push({ message: `Dangling edge: source ${edge.source} not found, skipping` });
    } else if (!ids.has(edge.target)) {
      warnings.push({ message: `Dangling edge: target ${edge.target} not found, skipping` });
    }
  }
  return { errors, warnings };
}

// --- Node/edge attribute builders ---------------------------------------

function nodeAttrs(node: UniversalNode, style: ReturnType<StyleSheet['nodeStyle']>, noColor: boolean, maxLabel: number, wrapWidth: number): string {
  const label = formatLabel(node.label, maxLabel, wrapWidth);
  const shape = style.shape ?? 'box';
  const attrs: string[] = [`label=${escapeDotId(label)}`, `shape=${shape}`];
  if (!noColor && style.fillColor) attrs.push(`style=filled`, `fillcolor=${escapeDotId(style.fillColor)}`);
  if (!noColor && style.borderColor) attrs.push(`color=${escapeDotId(style.borderColor)}`);
  if (style.borderWidth) attrs.push(`penwidth=${style.borderWidth}`);
  if (style.peripheries) attrs.push(`peripheries=${style.peripheries}`);
  if (!noColor && style.fontColor) attrs.push(`fontcolor=${escapeDotId(style.fontColor)}`);
  if (style.borderStyle === 'dashed') attrs.push(`style="dashed,filled"`);
  else if (style.borderStyle === 'dotted') attrs.push(`style="dotted,filled"`);
  return '[' + attrs.join(', ') + ']';
}

function edgeAttrs(edge: UniversalEdge, displayLabel: string, style: ReturnType<StyleSheet['edgeStyle']>, noColor: boolean): string {
  const attrs: string[] = [`label=${escapeDotId(displayLabel)}`];
  if (!noColor && style.color) attrs.push(`color=${escapeDotId(style.color)}`);
  if (style.style === 'dashed') attrs.push(`style=dashed`);
  else if (style.style === 'dotted') attrs.push(`style=dotted`);
  if (style.penWidth) attrs.push(`penwidth=${style.penWidth}`);
  if (!noColor && style.fontColor) attrs.push(`fontcolor=${escapeDotId(style.fontColor)}`);
  if (style.arrowHead) attrs.push(`arrowhead=${escapeDotId(style.arrowHead)}`);
  if (edge.directed === false) attrs.push(`dir=none`);
  return '[' + attrs.join(', ') + ']';
}

// --- Legend generation --------------------------------------------------

function buildLegend(graph: UniversalGraph, stylesheet: StyleSheet, noColor: boolean): string {
  const nodeTypes = new Map<string, string>(); // type+status → example status
  const edgeTypes = new Map<string, string>();  // type → label

  for (const node of graph.nodes) {
    const key = node.type + '|' + (node.status ?? '');
    if (!nodeTypes.has(key)) nodeTypes.set(key, node.status ?? '');
  }
  for (const edge of graph.edges) {
    if (!edgeTypes.has(edge.type)) {
      const label = stylesheet.edgeLabel ? stylesheet.edgeLabel(edge) : (edge.label ?? edge.type);
      edgeTypes.set(edge.type, label);
    }
  }

  const lines: string[] = ['subgraph cluster_legend {', '  label="Legend"; style=dotted; rank=sink;'];

  let i = 0;
  for (const [key, status] of nodeTypes) {
    const [type] = key.split('|');
    const fakeNode: UniversalNode = { id: `_leg_n_${i}`, type, label: `${type}${status ? '/' + status : ''}`, status };
    const s = stylesheet.nodeStyle(fakeNode);
    lines.push(`  ${escapeDotId('_leg_n_' + i)} ${nodeAttrs(fakeNode, s, noColor, 40, 0)};`);
    i++;
  }

  if (edgeTypes.size > 0) {
    lines.push('  _leg_src [label="", shape=point, width=0.1];');
    lines.push('  _leg_dst [label="", shape=point, width=0.1];');
    for (const [type, label] of edgeTypes) {
      const fakeEdge: UniversalEdge = { source: '_leg_src', target: '_leg_dst', type, label };
      const es = stylesheet.edgeStyle(fakeEdge);
      lines.push(`  _leg_src -> _leg_dst ${edgeAttrs(fakeEdge, label, es, noColor)};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

// --- Main render --------------------------------------------------------

/** Render a UniversalGraph to DOT string (+ optional PNG/SVG files via graphviz). */
export function renderGraph(graph: UniversalGraph, style: StyleSheet, options: RenderOptions = {}): string {
  const { errors, warnings } = validateGraph(graph);
  if (errors.length > 0) throw new Error('Graph validation failed:\n' + errors.join('\n'));
  for (const w of warnings) console.warn('[graph-viz]', w.message);

  const rankDir = options.rankDir ?? 'LR';
  const maxLabel = options.maxLabel ?? DEFAULT_MAX_LABEL;
  const wrapWidth = options.wrapWidth ?? DEFAULT_WRAP_WIDTH;
  const noColor = options.noColor ?? false;
  const legendMode = options.legend ?? 'auto';
  const legendThreshold = options.legendThreshold ?? DEFAULT_LEGEND_THRESHOLD;
  const title = graph.title ?? '';

  // Build set of valid node IDs for dangling-edge filtering
  const validIds = new Set(graph.nodes.map(n => n.id));

  const lines: string[] = [];
  lines.push('digraph G {');
  if (title) lines.push(`  label=${escapeDotId(title)};`);
  lines.push(`  rankdir=${rankDir};`);
  lines.push('  node [fontname="Helvetica", fontsize=10];');
  lines.push('  edge [fontname="Helvetica", fontsize=9];');
  lines.push('');

  // Group nodes by cluster
  const groups = new Map<string, UniversalNode[]>();
  const ungrouped: UniversalNode[] = [];
  for (const node of graph.nodes) {
    if (node.group) {
      const grp = groups.get(node.group) ?? [];
      grp.push(node);
      groups.set(node.group, grp);
    } else {
      ungrouped.push(node);
    }
  }

  // Emit ungrouped nodes
  for (const node of ungrouped) {
    const s = style.nodeStyle(node);
    lines.push(`  ${escapeDotId(node.id)} ${nodeAttrs(node, s, noColor, maxLabel, wrapWidth)};`);
  }

  // Emit clustered nodes
  let clusterIdx = 0;
  for (const [groupName, groupNodes] of groups) {
    lines.push(`  subgraph cluster_${clusterIdx} {`);
    lines.push(`    label=${escapeDotId(groupName)};`);
    for (const node of groupNodes) {
      const s = style.nodeStyle(node);
      lines.push(`    ${escapeDotId(node.id)} ${nodeAttrs(node, s, noColor, maxLabel, wrapWidth)};`);
    }
    lines.push('  }');
    clusterIdx++;
  }

  lines.push('');

  // Emit edges (skip dangling)
  for (const edge of graph.edges) {
    if (!validIds.has(edge.source) || !validIds.has(edge.target)) continue;
    const es = style.edgeStyle(edge);
    const displayLabel = style.edgeLabel ? style.edgeLabel(edge) : (edge.label ?? edge.type);
    const reverse = style.reverseEdge ? style.reverseEdge(edge) : false;
    const src = reverse ? edge.target : edge.source;
    const dst = reverse ? edge.source : edge.target;
    lines.push(`  ${escapeDotId(src)} -> ${escapeDotId(dst)} ${edgeAttrs(edge, displayLabel, es, noColor)};`);
  }

  // Legend
  if (graph.nodes.length > 0) {
    const showLegend =
      legendMode === 'embedded' ||
      (legendMode === 'auto' && graph.nodes.length <= legendThreshold);
    if (showLegend) {
      lines.push('');
      lines.push(buildLegend(graph, style, noColor));
    }
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}
