import { readFileSync } from 'node:fs';
import { UniversalGraph, UniversalNode, UniversalEdge, StyleSheet, NodeStyle, EdgeStyle, Adapter } from '../types.js';

// --- StyleSheet ---------------------------------------------------------

const STATUS_STYLES: Record<string, NodeStyle> = {
  seminal:     { shape: 'doubleoctagon', fillColor: '#fff9c4' },
  influential: { shape: 'box',           fillColor: '#e8f5e9' },
  notable:     { shape: 'box',           fillColor: '#e3f2fd' },
  standard:    { shape: 'ellipse',       fillColor: '#f5f5f5' },
  _default:    { shape: 'ellipse',       fillColor: '#f5f5f5' },
};

const EDGE_STYLES: Record<string, EdgeStyle> = {
  cites:       { color: '#555555', style: 'solid' },
  extends:     { color: '#2e7d32', style: 'solid' },
  contradicts: { color: '#c62828', style: 'dashed' },
  reviews:     { color: '#1565c0', style: 'dotted' },
  _default:    { color: '#9e9e9e', style: 'solid' },
};

const literatureStyleSheet: StyleSheet = {
  nodeStyle(node: UniversalNode): NodeStyle {
    return STATUS_STYLES[node.status ?? '_default'] ?? STATUS_STYLES['_default'];
  },
  edgeStyle(edge: UniversalEdge): EdgeStyle {
    return EDGE_STYLES[edge.type] ?? EDGE_STYLES['_default'];
  },
};

// --- Data types ---------------------------------------------------------

interface InspireRecord {
  recid?: string | number;
  metadata?: {
    citation_count?: number;
    authors?: Array<{ full_name?: string }>;
    earliest_date?: string;
    arxiv_eprints?: Array<{ categories?: string[] }>;
    journal_title?: string;
  };
}

interface LiteratureEdgeRecord {
  citing_recid: string | number;
  cited_recid: string | number;
  relation_type?: string;
}

interface LiteratureInput {
  records?: InspireRecord[];
  edges?: LiteratureEdgeRecord[];
}

// --- Helpers ------------------------------------------------------------

function citationStatus(count: number): string {
  if (count > 500) return 'seminal';
  if (count > 100) return 'influential';
  if (count > 20)  return 'notable';
  return 'standard';
}

function citationWeight(count: number): number {
  return Math.min(Math.log10(Math.max(count, 1)) / 4, 1);
}

function firstAuthor(record: InspireRecord): string {
  const authors = record.metadata?.authors ?? [];
  const name = authors[0]?.full_name ?? 'Unknown';
  const year = (record.metadata?.earliest_date ?? '').slice(0, 4) || '?';
  return `${name} (${year})`;
}

function paperGroup(record: InspireRecord): string | undefined {
  const cats = record.metadata?.arxiv_eprints?.[0]?.categories;
  if (cats && cats.length > 0) return cats[0];
  return record.metadata?.journal_title;
}

// --- Graph builder ------------------------------------------------------

function buildLiteratureGraph(input: LiteratureInput): UniversalGraph {
  const records = input.records ?? [];
  const inputEdges = input.edges ?? [];

  const nodes: UniversalNode[] = records.map(r => {
    const id = String(r.recid ?? '');
    const count = r.metadata?.citation_count ?? 0;
    return {
      id,
      type: 'paper',
      label: firstAuthor(r),
      group: paperGroup(r),
      status: citationStatus(count),
      weight: citationWeight(count),
      metadata: r as unknown as Record<string, unknown>,
    };
  });

  const edges: UniversalEdge[] = inputEdges.map(e => {
    const src = String(e.citing_recid);
    const tgt = String(e.cited_recid);
    const relType = e.relation_type ?? 'cites';
    return {
      id: `${src}→${tgt}:${relType}`,
      source: src,
      target: tgt,
      type: relType,
      label: relType,
    };
  });

  return { nodes, edges };
}

// --- Adapter ------------------------------------------------------------

export const literatureAdapter: Adapter = {
  name: 'literature',
  async adapt(args) {
    const inputPath = args['input'];
    if (!inputPath) throw new Error('literature adapter requires --input');
    const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as LiteratureInput;
    return { graph: buildLiteratureGraph(raw), style: literatureStyleSheet };
  },
};
