import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

/** Check if Graphviz `dot` binary is available. */
export function isDotAvailable(): boolean {
  const result = spawnSync('which', ['dot'], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Write DOT source to file and optionally invoke Graphviz to render PNG/SVG.
 * If `dot` is not installed, writes .dot file and logs a warning (never throws).
 */
export function runDot(
  dotSource: string,
  opts: {
    outDot?: string;
    outPng?: string;
    outSvg?: string;
    layoutEngine?: string;
  }
): void {
  const { outDot, outPng, outSvg, layoutEngine = 'dot' } = opts;

  if (outDot) {
    ensureDir(outDot);
    writeFileSync(outDot, dotSource, 'utf8');
  }

  if (!outPng && !outSvg) return;

  if (!isDotAvailable()) {
    console.warn('[graph-viz] Graphviz `dot` not found. Skipping PNG/SVG generation.');
    return;
  }

  // Write DOT to a temp string for stdin if no outDot
  const dotBuffer = Buffer.from(dotSource, 'utf8');

  if (outPng) {
    ensureDir(outPng);
    const result = spawnSync(layoutEngine, ['-Tpng', '-o', outPng], {
      input: dotBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      console.warn('[graph-viz] dot PNG failed:', result.stderr?.toString());
    }
  }

  if (outSvg) {
    ensureDir(outSvg);
    const result = spawnSync(layoutEngine, ['-Tsvg', '-o', outSvg], {
      input: dotBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      console.warn('[graph-viz] dot SVG failed:', result.stderr?.toString());
    }
  }
}
