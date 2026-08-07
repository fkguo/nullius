import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendDecision } from './decisions-ledger.js';

/** `nullius release` — export a public snapshot of the project's CODE at a
 *  chosen commit, excluding run artifacts, machine state, and internal
 *  process files, so the exported tree can seed a public repository whose
 *  history starts clean at version one.
 *
 *  Deliberately small:
 *  - The version object is the git commit (the traceability design's D1);
 *    this command only EXPORTS a commit's tree — it never invents a second
 *    "clean copy" that could drift from the repository.
 *  - The exclusion list is fixed and printed in full on every run: hiding
 *    what was left out would turn an export into a silent editorial step.
 *  - Bookkeeping goes to the decisions ledger ("this revision is public
 *    version N"), and the exported commit gets a local tag, so the mapping
 *    between the public release and the internal history is pinned twice.
 *  - No network side effects: creating the public repository, licensing,
 *    and pushing stay explicit human steps (the receipt prints them).
 */

/** Run-artifact and machine-state trees plus internal process files.
 *  Paths are repo-relative prefixes matched against the commit's tree. */
export const RELEASE_EXCLUDED_PATHS: readonly string[] = [
  // Run products and review records — evidence, not code.
  'artifacts',
  'team/runs',
  // Machine state and host-agent surfaces.
  '.nullius',
  '.claude',
  '.codex',
  '.opencode',
  '.kimi-code',
  // Internal research-process files (the public repo gets a README the
  // author writes for readers, not the internal working notes).
  'research_plan.md',
  'research_notebook.md',
  'research_contract.md',
  'project_index.md',
  'AGENTS.md',
  'CLAUDE.md',
];

const RELEASE_TAG_PREFIX = 'public-v';

export type ReleaseOptions = {
  targetDir: string;
  commit: string | null;
  tag: string | null;
  actor: string | null;
  dryRun: boolean;
};

type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

function git(projectRoot: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', projectRoot, ...args], {
    encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveCommit(projectRoot: string, ref: string): string {
  try {
    return git(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`cannot resolve '${ref}' to a commit in this repository`);
  }
}

/** Tree entries of the commit that the exclusion list actually removes —
 *  reported so the receipt states what was left out of THIS export, not the
 *  full hypothetical list. */
export function excludedPresentInTree(projectRoot: string, commit: string): string[] {
  const tree = git(projectRoot, ['ls-tree', '-r', '--name-only', commit]).split('\n');
  const present: string[] = [];
  for (const prefix of RELEASE_EXCLUDED_PATHS) {
    const hit = tree.some(entry => entry === prefix || entry.startsWith(`${prefix}/`));
    if (hit) present.push(prefix.endsWith('.md') ? prefix : `${prefix}/`);
  }
  return present;
}

/** Next free public-vN name, scanning existing tags so a rerun never
 *  silently reuses a number. */
export function nextReleaseTag(projectRoot: string): string {
  const tags = git(projectRoot, ['tag', '--list', `${RELEASE_TAG_PREFIX}*`]).split('\n');
  let max = 0;
  for (const tag of tags) {
    const match = /^public-v(\d+)$/.exec(tag.trim());
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return `${RELEASE_TAG_PREFIX}${max + 1}`;
}

export function runReleaseCommand(projectRoot: string, options: ReleaseOptions, io: Io): number {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    throw new Error('release requires a git repository (the commit IS the version object); run git init and commit first');
  }

  // Default HEAD demands a clean tree: exporting HEAD while edits are
  // pending would publish a tree that is not what the working directory
  // shows. An explicit --commit names an immutable object, so the working
  // tree's state is irrelevant to it.
  let commit: string;
  if (options.commit) {
    commit = resolveCommit(projectRoot, options.commit);
  } else {
    const dirty = git(projectRoot, ['status', '--porcelain']).trim();
    if (dirty.length > 0) {
      throw new Error(
        'working tree has uncommitted changes; commit them (or name an exact revision with --commit) '
        + 'so the export matches a pinned version',
      );
    }
    commit = resolveCommit(projectRoot, 'HEAD');
  }

  const targetDir = path.resolve(options.targetDir);
  if (path.resolve(projectRoot) === targetDir || targetDir.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
    throw new Error('target directory must be OUTSIDE the project root (the public snapshot must not nest into the internal repository)');
  }
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`target directory ${targetDir} is not empty; release never overwrites existing content`);
  }

  const tag = options.tag ?? nextReleaseTag(projectRoot);
  const existing = git(projectRoot, ['tag', '--list', tag]).trim();
  if (existing.length > 0) {
    throw new Error(`tag ${tag} already exists; a release tag is never moved — pick another name with --tag`);
  }

  const excluded = excludedPresentInTree(projectRoot, commit);
  const pathspecs = ['.', ...RELEASE_EXCLUDED_PATHS.map(p => `:(exclude)${p}`)];

  if (options.dryRun) {
    io.stdout(`DRY RUN — nothing exported, tagged, or recorded.\n`);
    io.stdout(`would export commit ${commit.slice(0, 12)} to ${targetDir}\n`);
    io.stdout(`would tag it ${tag}\n`);
    io.stdout(excluded.length > 0
      ? `would exclude (present in this tree): ${excluded.join(', ')}\n`
      : 'nothing from the exclusion list is present in this tree\n');
    return 0;
  }

  // Export via git archive with exclude pathspecs; unpack with the system
  // tar. A temp tarball keeps the two steps independently retryable.
  fs.mkdirSync(targetDir, { recursive: true });
  const tarPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-release-')), 'snapshot.tar');
  try {
    execFileSync('git', ['-C', projectRoot, 'archive', '--format=tar', '-o', tarPath, commit, '--', ...pathspecs], {
      timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('tar', ['-xf', tarPath, '-C', targetDir], { timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.rmSync(path.dirname(tarPath), { recursive: true, force: true });
  }
  let fileCount = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else fileCount += 1;
    }
  };
  walk(targetDir);
  if (fileCount === 0) {
    throw new Error('export produced zero files — the commit tree is empty after exclusions; nothing was tagged or recorded');
  }

  // Tag AFTER a successful export, ledger AFTER the tag; a failure between
  // the steps is reported with exactly what completed, never papered over.
  git(projectRoot, ['tag', tag, commit]);
  try {
    appendDecision(projectRoot, {
      kind: 'decided',
      text: `Released public snapshot ${tag} from commit ${commit.slice(0, 12)}: `
        + `${fileCount} file(s) exported to ${targetDir}`
        + `${excluded.length > 0 ? `; excluded: ${excluded.join(', ')}` : ''}`,
      by: options.actor ?? 'release',
    });
  } catch (error) {
    io.stderr(
      `WARNING: export and tag ${tag} completed, but the decisions ledger entry FAILED `
      + `(${error instanceof Error ? error.message : String(error)}). Record it by hand: `
      + `nullius decision record "Released public snapshot ${tag} from commit ${commit.slice(0, 12)}"\n`,
    );
    return 1;
  }

  io.stdout(`released ${tag}: commit ${commit.slice(0, 12)} → ${fileCount} file(s) in ${targetDir}\n`);
  io.stdout(excluded.length > 0
    ? `excluded (present in this tree): ${excluded.join(', ')}\n`
    : 'nothing from the exclusion list was present in this tree\n');
  io.stdout(`recorded on the decisions ledger; internal tag ${tag} pins the mapping.\n`);
  io.stdout('next steps (manual by design): cd into the export, git init && git add -A && git commit, '
    + 'add a reader-facing README and a LICENSE, then push to the public host.\n');
  return 0;
}
