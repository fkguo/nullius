import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  renderGraph,
  runDot,
  claimDagAdapter,
  progressAdapter,
  literatureAdapter,
  type Adapter,
  type RenderOptions,
} from '@autoresearch/shared/graph-viz';

import type { ParsedCliArgs } from './cli-args.js';

type CliIo = {
  cwd: string;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

type GraphArgs = Extract<ParsedCliArgs, { command: 'graph' }>;
type GraphKind = GraphArgs['kind'];

/**
 * The `graph` command is the front-door consumer of the domain-neutral
 * `@autoresearch/shared/graph-viz` engine. Each kind maps to one already-built
 * adapter; the renderer turns the resulting UniversalGraph into Graphviz DOT
 * (the portable source of truth) plus optional PNG/SVG when Graphviz is present.
 */
const ADAPTERS: Record<GraphKind, Adapter> = {
  claims: claimDagAdapter,
  progress: progressAdapter,
  literature: literatureAdapter,
};

/** Required `--<flag>` input(s) per kind (validated before the adapter runs so
 * the error names the missing flag instead of surfacing a deep adapter throw). */
const REQUIRED_INPUTS: Record<GraphKind, string[]> = {
  claims: ['claims', 'edges'],
  progress: ['plan'],
  literature: ['input'],
};

export async function runGraphCommand(parsed: GraphArgs, io: CliIo): Promise<number> {
  const adapter = ADAPTERS[parsed.kind];

  // Resolve + validate the required input paths (relative to cwd) before adapting.
  const resolvedInputs: Record<string, string> = {};
  for (const key of REQUIRED_INPUTS[parsed.kind]) {
    const raw = parsed.inputs[key];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`graph --kind ${parsed.kind} requires --${key} <path>`);
    }
    const resolved = path.resolve(io.cwd, raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`graph --kind ${parsed.kind}: input file not found for --${key}: ${raw}`);
    }
    resolvedInputs[key] = resolved;
  }

  const { graph, style } = await adapter.adapt(resolvedInputs);

  const renderOptions: RenderOptions = {
    rankDir: parsed.rankDir,
    noColor: parsed.noColor,
  };
  const dot = renderGraph(graph, style, renderOptions);

  if (parsed.json) {
    io.stdout(
      JSON.stringify(
        {
          kind: parsed.kind,
          title: graph.title ?? null,
          node_count: graph.nodes.length,
          edge_count: graph.edges.length,
          nodes: graph.nodes.map(n => ({
            id: n.id,
            type: n.type,
            status: n.status ?? null,
            group: n.group ?? null,
          })),
          edges: graph.edges.map(e => ({ source: e.source, target: e.target, type: e.type })),
          dot,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  const outDir = path.resolve(io.cwd, parsed.outDir ?? '.');
  fs.mkdirSync(outDir, { recursive: true });
  const outDot = path.join(outDir, `${parsed.kind}.dot`);
  const outPng = parsed.format === 'png' ? path.join(outDir, `${parsed.kind}.png`) : undefined;
  const outSvg = parsed.format === 'svg' ? path.join(outDir, `${parsed.kind}.svg`) : undefined;

  // runDot always writes the DOT; PNG/SVG are best-effort (skipped with a warning
  // when Graphviz is absent). The DOT is the renderer-agnostic source of truth.
  runDot(dot, { outDot, outPng, outSvg });

  io.stdout(`[ok] wrote: ${outDot}\n`);
  for (const raster of [outPng, outSvg]) {
    if (!raster) continue;
    if (fs.existsSync(raster)) {
      io.stdout(`[ok] wrote: ${raster}\n`);
    } else {
      io.stdout(`[warn] ${path.basename(raster)} not produced (Graphviz 'dot' unavailable?); DOT was written\n`);
    }
  }
  io.stdout(`nodes: ${graph.nodes.length}, edges: ${graph.edges.length}\n`);
  return 0;
}
