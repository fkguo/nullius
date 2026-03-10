import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderGraph } from '../graph-viz/render.js';
import { parseProgressMd } from '../graph-viz/parse-progress.js';
import { ideaMapAdapter } from '../graph-viz/adapters/idea-map.js';
import type { UniversalGraph, StyleSheet, NodeStyle, EdgeStyle } from '../graph-viz/types.js';

// --- Minimal stylesheet for tests ---------------------------------------

const testStyle: StyleSheet = {
  nodeStyle(): NodeStyle { return { shape: 'box', fillColor: '#ffffff' }; },
  edgeStyle(): EdgeStyle { return { color: '#000000', style: 'solid' }; },
};

// --- renderGraph tests --------------------------------------------------

describe('renderGraph', () => {
  it('renders an empty graph', () => {
    const g: UniversalGraph = { title: 'Empty', nodes: [], edges: [] };
    const dot = renderGraph(g, testStyle);
    expect(dot).toContain('digraph G');
    expect(dot).toContain('Empty');
  });

  it('renders a simple node', () => {
    const g: UniversalGraph = {
      nodes: [{ id: 'n1', type: 'claim', label: 'Hello world', status: 'active' }],
      edges: [],
    };
    const dot = renderGraph(g, testStyle, { legend: 'none' });
    expect(dot).toContain('"n1"');
    expect(dot).toContain('Hello world');
    expect(dot).toContain('shape=box');
  });

  it('renders an edge between two nodes', () => {
    const g: UniversalGraph = {
      nodes: [
        { id: 'a', type: 'claim', label: 'Claim A' },
        { id: 'b', type: 'claim', label: 'Claim B' },
      ],
      edges: [{ source: 'a', target: 'b', type: 'supports', label: 'supports' }],
    };
    const dot = renderGraph(g, testStyle, { legend: 'none' });
    expect(dot).toContain('"a" -> "b"');
    expect(dot).toContain('supports');
  });

  it('throws on duplicate node IDs', () => {
    const g: UniversalGraph = {
      nodes: [
        { id: 'dup', type: 'x', label: 'A' },
        { id: 'dup', type: 'x', label: 'B' },
      ],
      edges: [],
    };
    expect(() => renderGraph(g, testStyle)).toThrow('Duplicate node id');
  });

  it('skips dangling edges with a warning', () => {
    const g: UniversalGraph = {
      nodes: [{ id: 'n1', type: 'x', label: 'N1' }],
      edges: [{ source: 'n1', target: 'missing', type: 'link' }],
    };
    // Should not throw; dangling edge skipped
    const dot = renderGraph(g, testStyle, { legend: 'none' });
    expect(dot).not.toContain('"missing"');
  });

  it('clamps weight outside [0,1] silently', () => {
    const g: UniversalGraph = {
      nodes: [{ id: 'n1', type: 'x', label: 'N', weight: 1.5 }],
      edges: [],
    };
    expect(() => renderGraph(g, testStyle, { legend: 'none' })).not.toThrow();
  });

  it('reverses edges when StyleSheet.reverseEdge returns true', () => {
    const reverseStyle: StyleSheet = {
      ...testStyle,
      reverseEdge: (e) => e.type === 'depends_on',
    };
    const g: UniversalGraph = {
      nodes: [
        { id: 'child', type: 'task', label: 'Child' },
        { id: 'parent', type: 'milestone', label: 'Parent' },
      ],
      edges: [{ source: 'child', target: 'parent', type: 'depends_on' }],
    };
    const dot = renderGraph(g, reverseStyle, { legend: 'none' });
    // Reversed: parent -> child
    expect(dot).toContain('"parent" -> "child"');
  });

  it('groups nodes into subgraphs by group', () => {
    const g: UniversalGraph = {
      nodes: [
        { id: 'n1', type: 'x', label: 'A', group: 'GroupA' },
        { id: 'n2', type: 'x', label: 'B', group: 'GroupA' },
        { id: 'n3', type: 'x', label: 'C' },
      ],
      edges: [],
    };
    const dot = renderGraph(g, testStyle, { legend: 'none' });
    expect(dot).toContain('subgraph cluster_');
    expect(dot).toContain('GroupA');
  });

  it('deterministic output: same graph gives same DOT', () => {
    const g: UniversalGraph = {
      nodes: [{ id: 'x', type: 'y', label: 'Z' }],
      edges: [],
    };
    expect(renderGraph(g, testStyle, { legend: 'none' })).toBe(renderGraph(g, testStyle, { legend: 'none' }));
  });

  it('truncates long labels', () => {
    const label = 'A'.repeat(200);
    const g: UniversalGraph = { nodes: [{ id: 'n', type: 'x', label }], edges: [] };
    const dot = renderGraph(g, testStyle, { maxLabel: 80, legend: 'none' });
    expect(dot).not.toContain(label);
  });
});

// --- parseProgressMd tests ----------------------------------------------

describe('parseProgressMd', () => {
  const sampleMd = `
# Research Plan

## Task Board

### M0 — Setup
- [x] T1: Initialize project
- [ ] T2: Write docs

### M1 — Analysis
- [ ] T3: Run tests

## Progress Log

- 2026-01-01 tag=M0-r1 status=converged task=T1 note=done
`;

  it('parses milestones', () => {
    const items = parseProgressMd(sampleMd);
    const m0 = items.find(i => i.id === 'M0');
    expect(m0).toBeDefined();
    expect(m0?.type).toBe('milestone');
    expect(m0?.title).toBe('Setup');
  });

  it('parses tasks', () => {
    const items = parseProgressMd(sampleMd);
    const t2 = items.find(i => i.id === 'T2');
    expect(t2?.status).toBe('pending');
  });

  it('applies progress log overrides', () => {
    const items = parseProgressMd(sampleMd);
    const t1 = items.find(i => i.id === 'T1');
    expect(t1?.status).toBe('converged');
  });

  it('sets milestone depends_on from tasks', () => {
    const items = parseProgressMd(sampleMd);
    const m0 = items.find(i => i.id === 'M0');
    expect(m0?.depends_on).toEqual(['T1', 'T2']);
  });
});

describe('ideaMapAdapter', () => {
  it('ignores optional candidate_formalisms when building the public graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'idea-map-'));
    try {
      writeFileSync(join(dir, 'nodes.jsonl'), `${JSON.stringify({
        node_id: 'n1',
        idea_card: { thesis_statement: 'Thesis', candidate_formalisms: ['hep/toy'] },
      })}\n`);
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ nodes: [], edges: [] }));

      const { graph } = await ideaMapAdapter.adapt({
        nodes: join(dir, 'nodes.jsonl'),
        evidence: join(dir, 'evidence.json'),
      });

      expect(graph.nodes.every(node => node.type !== 'formalism')).toBe(true);
      expect(graph.edges.every(edge => edge.type !== 'uses_formalism')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
