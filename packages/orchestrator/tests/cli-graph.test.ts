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
