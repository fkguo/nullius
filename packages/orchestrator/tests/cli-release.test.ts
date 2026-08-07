import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReleaseCommand, nextReleaseTag, RELEASE_EXCLUDED_PATHS } from '../src/cli-release.js';
import { readDecisionsLedger } from '../src/decisions-ledger.js';

let projectRoot: string;
let outside: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prj-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'release-out-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf-8' });
}
function ioCollector(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); } } };
}

/** A committed project carrying code, a TRACKED artifact file (the audit's
 *  deliberately-visible-evidence case), and internal process files — exactly
 *  the mix the exclusion list must separate. */
function setUpProject(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.nullius/\n');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'main.jl'), 'module Main end\n');
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# public readme\n');
  fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'artifacts', 'runs', 'r1', 'summary.json'), '{}\n');
  fs.writeFileSync(path.join(projectRoot, 'research_plan.md'), 'internal plan\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
  // Initialized project (the decisions ledger requires state.json).
  fs.mkdirSync(path.join(projectRoot, '.nullius'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.nullius', 'state.json'), '{}\n');
}

describe('nullius release', () => {
  it('exports code, excludes artifacts and internal files, tags, and records the decision', () => {
    setUpProject();
    const target = path.join(outside, 'pub');
    const { out, io } = ioCollector();
    const code = runReleaseCommand(projectRoot, {
      targetDir: target, commit: null, tag: null, actor: 'tester', dryRun: false,
    }, io);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(target, 'src', 'main.jl'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    // Tracked artifact and internal process file stay OUT of the export.
    expect(fs.existsSync(path.join(target, 'artifacts'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'research_plan.md'))).toBe(false);
    // Tag pins the exported commit.
    const head = git(['rev-parse', 'HEAD']).trim();
    expect(git(['rev-parse', 'public-v1^{commit}']).trim()).toBe(head);
    // Ledger carries the release decision with the exclusions named.
    const ledger = readDecisionsLedger(projectRoot);
    const entry = ledger.records.find((r) => r.text.includes('public-v1'));
    expect(entry).toBeDefined();
    expect(entry!.text).toContain(head.slice(0, 12));
    expect(entry!.text).toContain('artifacts/');
    // Receipt names what was excluded from THIS tree.
    const receipt = out.join('');
    expect(receipt).toContain('excluded (present in this tree)');
    expect(receipt).toContain('research_plan.md');
  });

  it('refuses a dirty tree by default but accepts an explicit --commit', () => {
    setUpProject();
    fs.writeFileSync(path.join(projectRoot, 'src', 'main.jl'), 'module Main; const X = 1; end\n');
    const { io } = ioCollector();
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'pub-a'), commit: null, tag: null, actor: null, dryRun: false,
    }, io)).toThrow(/uncommitted changes/);
    const head = git(['rev-parse', 'HEAD']).trim();
    const code = runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'pub-b'), commit: head, tag: null, actor: null, dryRun: false,
    }, ioCollector().io);
    expect(code).toBe(0);
    // The export is the COMMIT's content, not the dirty working tree's.
    expect(fs.readFileSync(path.join(outside, 'pub-b', 'src', 'main.jl'), 'utf-8')).toBe('module Main end\n');
  });

  it('refuses a non-empty target and a target nested inside the project root', () => {
    setUpProject();
    const occupied = path.join(outside, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'x'), 'x');
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: occupied, commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/not empty/);
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: path.join(projectRoot, 'export'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/OUTSIDE the project root/);
  });

  it('never reuses or moves a tag: explicit collision refuses, default increments', () => {
    setUpProject();
    runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'p1'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io);
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'p2'), commit: null, tag: 'public-v1', actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/already exists/);
    expect(nextReleaseTag(projectRoot)).toBe('public-v2');
    const code = runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'p2'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io);
    expect(code).toBe(0);
    expect(git(['tag', '--list', 'public-v2']).trim()).toBe('public-v2');
  });

  it('dry run writes nothing: no export, no tag, no ledger entry', () => {
    setUpProject();
    const target = path.join(outside, 'dry');
    const { out, io } = ioCollector();
    const code = runReleaseCommand(projectRoot, {
      targetDir: target, commit: null, tag: null, actor: null, dryRun: true,
    }, io);
    expect(code).toBe(0);
    expect(out.join('')).toContain('DRY RUN');
    expect(fs.existsSync(target)).toBe(false);
    expect(git(['tag', '--list', 'public-v1']).trim()).toBe('');
    expect(readDecisionsLedger(projectRoot).records.some((r) => r.text.includes('public-v'))).toBe(false);
  });

  it('reports honestly when the ledger entry fails after export and tag succeeded', () => {
    setUpProject();
    fs.rmSync(path.join(projectRoot, '.nullius', 'state.json')); // appendDecision now refuses
    const target = path.join(outside, 'pub');
    const { err, io } = ioCollector();
    const code = runReleaseCommand(projectRoot, {
      targetDir: target, commit: null, tag: null, actor: null, dryRun: false,
    }, io);
    expect(code).toBe(1);
    // Export and tag DID land; the warning says so and names the manual repair.
    expect(fs.existsSync(path.join(target, 'src', 'main.jl'))).toBe(true);
    expect(git(['tag', '--list', 'public-v1']).trim()).toBe('public-v1');
    const warning = err.join('');
    expect(warning).toContain('ledger entry FAILED');
    expect(warning).toContain('nullius decision record');
  });

  it('every exclusion-list entry is repo-relative with no leading slash or dot', () => {
    for (const entry of RELEASE_EXCLUDED_PATHS) {
      expect(entry.startsWith('/')).toBe(false);
      expect(entry.startsWith('./')).toBe(false);
      expect(entry.includes('..')).toBe(false);
    }
  });
});
