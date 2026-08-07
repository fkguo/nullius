import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReleaseCommand, nextReleaseTag, RELEASE_EXCLUDED_PATHS } from '../src/cli-release.js';
import { parseCliArgs } from '../src/cli-args.js';
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
  // Near-miss name: MUST survive the 'artifacts' directory exclusion.
  fs.writeFileSync(path.join(projectRoot, 'artifacts.jl'), 'module Artifacts end\n');
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
    // The exclusion is a directory prefix, not a substring: artifacts.jl stays.
    expect(fs.existsSync(path.join(target, 'artifacts.jl'))).toBe(true);
    // Tag pins the exported commit.
    const head = git(['rev-parse', 'HEAD']).trim();
    expect(git(['rev-parse', 'public-v1^{commit}']).trim()).toBe(head);
    // Ledger carries the release decision with the exclusions named.
    const ledger = readDecisionsLedger(projectRoot);
    const entry = ledger.records.find((r) => r.text.includes('public-v1'));
    expect(entry).toBeDefined();
    expect(entry!.text).toContain(head.slice(0, 12));
    expect(entry!.text).toContain('artifacts/');
    expect(entry!.by).toBe('tester'); // --actor lands on the ledger record
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
    // Custom --tag succeeds and pins the same commit.
    const code2 = runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'p3'), commit: null, tag: 'paper-v1', actor: null, dryRun: false,
    }, ioCollector().io);
    expect(code2).toBe(0);
    expect(git(['rev-parse', 'paper-v1^{commit}']).trim()).toBe(git(['rev-parse', 'HEAD']).trim());
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

  it('refuses an uninitialized project BEFORE any export work (native r1#3)', () => {
    setUpProject();
    fs.rmSync(path.join(projectRoot, '.nullius', 'state.json'));
    const target = path.join(outside, 'pub');
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: target, commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/not initialized/);
    expect(fs.existsSync(target)).toBe(false);
    expect(git(['tag', '--list', 'public-v1']).trim()).toBe('');
  });

  it('reports honestly when the ledger entry fails after export and tag succeeded', () => {
    setUpProject();
    // Preflight passes (state.json intact); the append itself fails because
    // the ledger path is occupied by a directory.
    fs.mkdirSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), { recursive: true });
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

  it('reports excluded entries even when tracked names are non-ASCII (native r1#5)', () => {
    setUpProject();
    // team/runs/ exists ONLY via this non-ASCII name: with quote-mangled
    // ls-tree output the prefix match would miss it and the receipt would
    // under-report.
    fs.mkdirSync(path.join(projectRoot, 'team', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'team', 'runs', '数据.json'), '{}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'non-ascii artifact']);
    const { out, io } = ioCollector();
    runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'pub-na'), commit: null, tag: null, actor: null, dryRun: false,
    }, io);
    expect(out.join('')).toContain('team/runs/');
  });

  it('containment cannot be bypassed by a symlinked target or symlinked parent (codex r1#1)', () => {
    setUpProject();
    // Direct symlink: an OUTSIDE path pointing at an empty dir INSIDE the project.
    const insideEmpty = path.join(projectRoot, 'sneak');
    fs.mkdirSync(insideEmpty);
    const link = path.join(outside, 'link');
    fs.symlinkSync(insideEmpty, link);
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: link, commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/OUTSIDE the project root/);
    // Symlinked ancestry: the target's PARENT resolves into the project.
    const linkedParent = path.join(outside, 'linked-parent');
    fs.symlinkSync(projectRoot, linkedParent);
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: path.join(linkedParent, 'pub'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/OUTSIDE the project root/);
    expect(fs.existsSync(path.join(projectRoot, 'pub'))).toBe(false);
  });

  it('refuses export-ignore/export-subst attributes from the tree and from info/attributes (codex r1#2)', () => {
    setUpProject();
    // Committed attribute: would silently drop src/main.jl from git archive.
    fs.writeFileSync(path.join(projectRoot, '.gitattributes'), 'src/main.jl export-ignore\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'attrs']);
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'p-attr'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/export-ignore\/export-subst attributes/);
    // Repo-local attributes file, invisible in any commit, same refusal.
    git(['rm', '-q', '.gitattributes']);
    git(['commit', '-q', '-m', 'drop attrs']);
    fs.mkdirSync(path.join(projectRoot, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.git', 'info', 'attributes'), 'README.md export-subst\n');
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'p-attr2'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/export-ignore\/export-subst attributes/);
  });

  it('the ledger pins the FULL object id, independent of the tag (codex r1#3)', () => {
    setUpProject();
    runReleaseCommand(projectRoot, {
      targetDir: path.join(outside, 'pub'), commit: null, tag: null, actor: null, dryRun: false,
    }, ioCollector().io);
    const head = git(['rev-parse', 'HEAD']).trim();
    const entry = readDecisionsLedger(projectRoot).records.find((r) => r.text.includes('public-v1'));
    expect(entry!.text).toContain(head); // all 40 characters
  });

  it('an invalid --tag is refused BEFORE any export work (codex r1#4)', () => {
    setUpProject();
    const target = path.join(outside, 'pub');
    expect(() => runReleaseCommand(projectRoot, {
      targetDir: target, commit: null, tag: 'bad tag name', actor: null, dryRun: false,
    }, ioCollector().io)).toThrow(/not a valid tag name/);
    expect(fs.existsSync(target)).toBe(false); // nothing was exported
  });

  it('the parse layer wires release options through (codex r1#5)', () => {
    const parsed = parseCliArgs([
      'release', '/tmp/out', '--commit', 'abc123', '--tag', 'public-v9', '--actor', 'me', '--dry-run',
    ]);
    expect(parsed).toMatchObject({
      command: 'release', targetDir: '/tmp/out', commit: 'abc123',
      tag: 'public-v9', actor: 'me', dryRun: true,
    });
    expect(() => parseCliArgs(['release'])).toThrow(/requires a target directory/);
    expect(() => parseCliArgs(['release', '/tmp/out', '--bogus'])).toThrow(/unknown release option/);
  });

  it('every exclusion-list entry is repo-relative with no leading slash or dot', () => {
    for (const entry of RELEASE_EXCLUDED_PATHS) {
      expect(entry.startsWith('/')).toBe(false);
      expect(entry.startsWith('./')).toBe(false);
      expect(entry.includes('..')).toBe(false);
    }
  });
});
