import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-graph-'));
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stdout,
    stderr,
  };
}

// A research_plan.md in the exact scaffolded shape parseProgressMd expects.
const PLAN_MD = [
  '## 3. Milestones',
  '',
  '### M0 — Baseline Reproduction',
  '### M1 — Core Derivation',
  '',
  '## Task Board',
  '',
  '- [x] T1: set up baseline',
  '- [ ] T2: derive core',
  '- [ ] T3: validate numerics',
  '',
  '## Progress Log',
  '',
  '- 2026-06-20 tag=m0-r1 status=converged task=T1',
  '',
].join('\n');

const CLAIMS_JSONL = [
  JSON.stringify({ id: 'C1', statement: 'baseline holds', status: 'verified' }),
  JSON.stringify({ id: 'C2', statement: 'core derivation', status: 'active' }),
  '',
].join('\n');
const EDGES_JSONL = JSON.stringify({ source: 'C2', target: 'C1', type: 'requires' }) + '\n';

const LIT_JSON = JSON.stringify({
  records: [
    { recid: '1', metadata: { citation_count: 600, authors: [{ full_name: 'A. Author' }], earliest_date: '2020-01-01' } },
    { recid: '2', metadata: { citation_count: 5, authors: [{ full_name: 'B. Writer' }], earliest_date: '2023-01-01' } },
  ],
  edges: [{ citing_recid: '2', cited_recid: '1', relation_type: 'cites' }],
});

const ROADMAP_SPEC = JSON.stringify({
  title: 'Roadmap dependency map',
  goal: 'M_C',
  nodes: [
    { id: 'M_A', label: 'Milestone A', status: 'done', effort: '~2 units', critical: true },
    { id: 'M_B', label: 'Milestone B', status: 'in_progress', critical: true },
    { id: 'L_X', label: 'Lane X', status: 'candidate' },
    { id: 'M_C', label: 'Milestone C', status: 'todo', critical: true },
    { id: 'M_D', label: 'Milestone D', status: 'deferred' },
  ],
  edges: [
    { from: 'M_A', to: 'M_B', kind: 'unlocks', critical: true },
    { from: 'M_B', to: 'M_C', kind: 'unlocks', critical: true },
    { from: 'L_X', to: 'M_B', kind: 'feeds_into' },
    { from: 'M_C', to: 'M_D', kind: 'feeds_into' },
  ],
});

describe('autoresearch graph command', () => {
  it('progress: parses a scaffolded research_plan.md into a milestone/task DAG', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'research_plan.md'), PLAN_MD, 'utf8');
    const { io, stdout } = makeIo(dir);

    const code = await runCli(['graph', '--kind', 'progress', '--plan', 'research_plan.md', '--out-dir', 'out'], io);

    expect(code).toBe(0);
    const dot = fs.readFileSync(path.join(dir, 'out', 'progress.dot'), 'utf8');
    expect(dot).toContain('digraph G {');
    expect(dot).toContain('rankdir=LR;');
    // Milestones + tasks present; milestone is a doubleoctagon; converged task is green.
    for (const id of ['M0', 'M1', 'T1', 'T2', 'T3']) expect(dot).toContain(`"${id}"`);
    expect(dot).toContain('doubleoctagon');
    expect(stdout.join('')).toContain('[ok] wrote:');
  });

  it('progress --json: emits structured metadata with computed statuses', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'research_plan.md'), PLAN_MD, 'utf8');
    const { io, stdout } = makeIo(dir);

    const code = await runCli(['graph', '--kind', 'progress', '--plan', 'research_plan.md', '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload.kind).toBe('progress');
    expect(payload.node_count).toBe(5);
    const byId: Record<string, string> = Object.fromEntries(payload.nodes.map((n: { id: string; status: string }) => [n.id, n.status]));
    expect(byId.T1).toBe('converged'); // from the progress log
    expect(byId.M1).toBe('active'); // has a non-converged task
    expect(typeof payload.dot).toBe('string');
  });

  it('claims: renders the claim DAG and honors --no-color / --rank-dir', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'claims.jsonl'), CLAIMS_JSONL, 'utf8');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), EDGES_JSONL, 'utf8');
    const { io } = makeIo(dir);

    const code = await runCli(
      ['graph', '--kind', 'claims', '--claims', 'claims.jsonl', '--edges', 'edges.jsonl', '--out-dir', 'g', '--no-color', '--rank-dir', 'TB'],
      io,
    );

    expect(code).toBe(0);
    const dot = fs.readFileSync(path.join(dir, 'g', 'claims.dot'), 'utf8');
    expect(dot).toContain('rankdir=TB;');
    expect(dot).toContain('"C1"');
    expect(dot).toContain('"C2"');
    // --no-color drops fill colors from the palette.
    expect(dot).not.toContain('fillcolor="#e8f5e9"');
  });

  it('literature --json: classifies nodes by citation count', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'lit.json'), LIT_JSON, 'utf8');
    const { io, stdout } = makeIo(dir);

    const code = await runCli(['graph', '--kind', 'literature', '--input', 'lit.json', '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload.node_count).toBe(2);
    const statuses = payload.nodes.map((n: { status: string }) => n.status).sort();
    expect(statuses).toEqual(['seminal', 'standard']);
  });

  it('format svg: always writes DOT and exits 0 (raster is best-effort)', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'claims.jsonl'), CLAIMS_JSONL, 'utf8');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), EDGES_JSONL, 'utf8');
    const { io, stdout } = makeIo(dir);

    const code = await runCli(
      ['graph', '--kind', 'claims', '--claims', 'claims.jsonl', '--edges', 'edges.jsonl', '--out-dir', 'g', '--format', 'svg'],
      io,
    );

    // The command never fails on raster availability; the DOT (portable SSOT) is
    // always written. The .svg is produced only when Graphviz is present — otherwise
    // a warning is printed and the exit code stays 0.
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'g', 'claims.dot'))).toBe(true);
    const svgExists = fs.existsSync(path.join(dir, 'g', 'claims.svg'));
    expect(svgExists || stdout.join('').includes('not produced')).toBe(true);
  });

  it('legend embedded vs none controls the embedded legend cluster', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'claims.jsonl'), CLAIMS_JSONL, 'utf8');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), EDGES_JSONL, 'utf8');
    const { io } = makeIo(dir);

    const embedded = await runCli(
      ['graph', '--kind', 'claims', '--claims', 'claims.jsonl', '--edges', 'edges.jsonl', '--out-dir', 'e', '--legend', 'embedded'],
      io,
    );
    const none = await runCli(
      ['graph', '--kind', 'claims', '--claims', 'claims.jsonl', '--edges', 'edges.jsonl', '--out-dir', 'n', '--legend', 'none'],
      io,
    );

    expect(embedded).toBe(0);
    expect(none).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'e', 'claims.dot'), 'utf8')).toContain('cluster_legend');
    expect(fs.readFileSync(path.join(dir, 'n', 'claims.dot'), 'utf8')).not.toContain('cluster_legend');
  });

  it('rejects an invalid --legend value', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'claims.jsonl'), CLAIMS_JSONL, 'utf8');
    fs.writeFileSync(path.join(dir, 'edges.jsonl'), EDGES_JSONL, 'utf8');
    const { io } = makeIo(dir);
    await expect(
      runCli(['graph', '--kind', 'claims', '--claims', 'claims.jsonl', '--edges', 'edges.jsonl', '--legend', 'bogus'], io),
    ).rejects.toThrow(/--legend/);
  });

  it('roadmap: encodes planning status, critical path, and the goal shape', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'roadmap.json'), ROADMAP_SPEC, 'utf8');
    const { io } = makeIo(dir);

    const code = await runCli(['graph', '--kind', 'roadmap', '--spec', 'roadmap.json', '--out-dir', 'r'], io);

    expect(code).toBe(0);
    const dot = fs.readFileSync(path.join(dir, 'r', 'roadmap.dot'), 'utf8');
    expect(dot).toContain('#e8f5e9'); // done fill
    expect(dot).toContain('#ede7f6'); // candidate fill
    expect(dot).toContain('#b71c1c'); // critical path color (nodes + edges)
    expect(dot).toContain('doubleoctagon'); // goal node shape
    expect(dot).toContain('penwidth=2.4'); // critical node pen
    expect(dot).toContain('style=dashed'); // feeds_into edges
  });

  it('roadmap: the `optional` edge kind aliases to a dashed "feeds into" edge', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'opt.json'),
      JSON.stringify({
        nodes: [{ id: 'A', status: 'done' }, { id: 'B', status: 'todo' }],
        edges: [{ from: 'A', to: 'B', kind: 'optional' }],
      }),
      'utf8',
    );
    const { io } = makeIo(dir);
    const code = await runCli(['graph', '--kind', 'roadmap', '--spec', 'opt.json', '--out-dir', 'o'], io);
    expect(code).toBe(0);
    const dot = fs.readFileSync(path.join(dir, 'o', 'roadmap.dot'), 'utf8');
    expect(dot).toContain('label="feeds into"');
    expect(dot).toContain('style=dashed');
  });

  it('roadmap --json reports node/edge counts', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'roadmap.json'), ROADMAP_SPEC, 'utf8');
    const { io, stdout } = makeIo(dir);
    const code = await runCli(['graph', '--kind', 'roadmap', '--spec', 'roadmap.json', '--json'], io);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload.kind).toBe('roadmap');
    expect(payload.node_count).toBe(5);
    expect(payload.edge_count).toBe(4);
  });

  it('roadmap: an edge to an undeclared node fails fast (-> exit 2 in production)', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ nodes: [{ id: 'A', status: 'todo' }], edges: [{ from: 'A', to: 'GHOST' }] }),
      'utf8',
    );
    const { io } = makeIo(dir);
    // The adapter throws (validation); runCli propagates it and the CLI entrypoint
    // maps any throw to exit code 2 (verified separately via the built CLI).
    await expect(
      runCli(['graph', '--kind', 'roadmap', '--spec', 'bad.json', '--out-dir', 'x'], io),
    ).rejects.toThrow(/undeclared node id 'GHOST'/);
  });

  it('rejects a missing required input flag', async () => {
    const dir = makeTempDir();
    const { io } = makeIo(dir);
    await expect(runCli(['graph', '--kind', 'progress'], io)).rejects.toThrow(/requires --plan/);
  });

  it('rejects an unknown kind', async () => {
    const dir = makeTempDir();
    const { io } = makeIo(dir);
    await expect(runCli(['graph', '--kind', 'bogus'], io)).rejects.toThrow(/--kind/);
  });

  it('rejects a nonexistent input file', async () => {
    const dir = makeTempDir();
    const { io } = makeIo(dir);
    await expect(
      runCli(['graph', '--kind', 'progress', '--plan', 'nope.md'], io),
    ).rejects.toThrow(/input file not found/);
  });
});
