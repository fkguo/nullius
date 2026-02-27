/** Domain-agnostic graph node. All domain-specific semantics are in metadata. */
export interface UniversalNode {
  /** Unique ID within the graph (must be DOT-safe after escaping). */
  id: string;

  /** Domain-specific type string (e.g. "claim", "gene", "paper"). */
  type: string;

  /** Human-readable display label. */
  label: string;

  /** Optional grouping key for subgraph/cluster rendering. */
  group?: string;

  /** Optional status string driving shape/color styling. */
  status?: string;

  /** Weight in [0, 1]. Maps to visual size or opacity. */
  weight?: number;

  /** Opaque domain-specific data (not used by renderer). */
  metadata?: Record<string, unknown>;
}

/** Domain-agnostic graph edge. Supports multigraphs via optional id. */
export interface UniversalEdge {
  /** Optional unique ID for this edge. Required for multigraph support. */
  id?: string;

  /** Source node ID. */
  source: string;

  /** Target node ID. */
  target: string;

  /** Domain-specific edge type (e.g. "supports", "resolved_by"). */
  type: string;

  /** Optional edge label. Defaults to type if omitted. */
  label?: string;

  /** Weight in [0, 1]. Maps to line width or opacity. */
  weight?: number;

  /** Whether the edge is directed. Default: true. */
  directed?: boolean;

  /** Opaque domain-specific data. */
  metadata?: Record<string, unknown>;
}

/** Container for a universal graph. */
export interface UniversalGraph {
  /** Graph title (used in DOT graph label). */
  title?: string;

  /** Optional graph-level metadata. */
  metadata?: Record<string, unknown>;

  nodes: UniversalNode[];
  edges: UniversalEdge[];
}

export interface NodeStyle {
  shape?: string;
  fillColor?: string;
  borderColor?: string;
  borderStyle?: 'solid' | 'dashed' | 'dotted';
  borderWidth?: number;
  peripheries?: number;
  fontColor?: string;
}

export interface EdgeStyle {
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
  fontColor?: string;
  penWidth?: number;
  arrowHead?: string;
}

export interface StyleSheet {
  nodeStyle(node: UniversalNode): NodeStyle;
  edgeStyle(edge: UniversalEdge): EdgeStyle;
  edgeLabel?(edge: UniversalEdge): string;
  reverseEdge?(edge: UniversalEdge): boolean;
}

export interface RenderOptions {
  outDot?: string;
  outPng?: string;
  outSvg?: string;
  rankDir?: 'LR' | 'TB';
  layoutEngine?: 'dot' | 'neato' | 'fdp' | 'sfdp' | 'circo' | 'twopi';
  maxLabel?: number;
  wrapWidth?: number;
  noColor?: boolean;
  legend?: 'auto' | 'embedded' | 'separate' | 'none';
  legendThreshold?: number;
}

/** Adapter: loads domain data and converts to UniversalGraph + StyleSheet. */
export interface Adapter {
  name: string;
  adapt(args: Record<string, string>): Promise<{ graph: UniversalGraph; style: StyleSheet }>;
}
