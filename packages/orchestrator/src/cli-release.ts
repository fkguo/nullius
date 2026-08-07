import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendDecision } from './decisions-ledger.js';
import { nulliusControlDir } from './state-manager.js';

/** `nullius release` — export a public snapshot of the project's CODE at a
 *  chosen commit, excluding run artifacts, machine state, and internal
 *  process files, so the exported tree can seed a public repository whose
 *  history starts clean at version one.
 *
 *  Deliberately small:
 *  - The version object is the git commit (the traceability design's D1);
 *    this command only EXPORTS a commit's tree — it never invents a second
 *    "clean copy" that could drift from the repository.
 *  - The exclusion list is fixed, and every entry of it that is PRESENT in
 *    the exported tree is printed on the receipt: hiding what was left out
 *    would turn an export into a silent editorial step.
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

/** Canonical form of a path that may not exist yet: realpath of the nearest
 *  existing ancestor plus the non-existing tail. A lexical-only comparison
 *  would let a symlink smuggle the target back inside the project root. */
function canonicalizeMaybeMissing(target: string): string {
  let existing = target;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...tail);
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
  // -z: NUL-delimited, so non-ASCII names arrive verbatim instead of
  // C-quoted ("\346\225\260..."), which would dodge the prefix match and
  // under-report the receipt.
  const tree = git(projectRoot, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0');
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
  // The ledger entry is part of the contract, and whether it CAN be written
  // is knowable up front — refuse before exporting anything rather than
  // discovering it after the export and tag already landed.
  if (!fs.existsSync(path.join(nulliusControlDir(projectRoot), 'state.json'))) {
    throw new Error('project is not initialized (missing state.json in the control dir); the release is recorded on the decisions ledger — run nullius init first');
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
  const canonicalTarget = canonicalizeMaybeMissing(targetDir);
  const canonicalRoot = fs.realpathSync(path.resolve(projectRoot));
  if (canonicalRoot === canonicalTarget || canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('target directory must be OUTSIDE the project root (the public snapshot must not nest into the internal repository)');
  }
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`target directory ${targetDir} is not empty; release never overwrites existing content`);
  }

  const tag = options.tag ?? nextReleaseTag(projectRoot);
  try {
    execFileSync('git', ['check-ref-format', `refs/tags/${tag}`], { timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    throw new Error(`'${tag}' is not a valid tag name (git check-ref-format refused it); pick another --tag`);
  }
  const existing = git(projectRoot, ['tag', '--list', tag]).trim();
  if (existing.length > 0) {
    throw new Error(`tag ${tag} already exists; a release tag is never moved — pick another name with --tag`);
  }

  // git archive honors export-ignore / export-subst attributes (from the
  // commit's .gitattributes files or $GIT_DIR/info/attributes), which would
  // let the export silently omit or rewrite files BEYOND the fixed printed
  // exclusion list. That breaks this command's transparency contract, so
  // their presence is a hard refusal, not a silent modifier.
  const attributeHits: string[] = [];
  try {
    const hits = git(projectRoot, [
      'grep', '-l', '-e', 'export-ignore', '-e', 'export-subst', commit, '--', '.gitattributes', '**/.gitattributes',
    ]).trim();
    if (hits.length > 0) attributeHits.push(...hits.split('\n'));
  } catch {
    // git grep exits 1 on zero matches — that is the clean case.
  }
  const gitDir = git(projectRoot, ['rev-parse', '--absolute-git-dir']).trim();
  const infoAttributes = path.join(gitDir, 'info', 'attributes');
  if (fs.existsSync(infoAttributes)) {
    const text = fs.readFileSync(infoAttributes, 'utf-8');
    if (/export-ignore|export-subst/.test(text)) attributeHits.push(infoAttributes);
  }
  if (attributeHits.length > 0) {
    throw new Error(
      `export-ignore/export-subst attributes are in effect (${attributeHits.join(', ')}); `
      + 'these would silently alter the export beyond the fixed exclusion list. Remove them '
      + '(or release a commit without them) so the export is determined by the commit and '
      + 'the printed list alone',
    );
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
  try {
    git(projectRoot, ['tag', tag, commit]);
  } catch (error) {
    io.stderr(
      `WARNING: the export completed at ${targetDir}, but tagging FAILED `
      + `(${error instanceof Error ? error.message : String(error)}). Tag by hand: `
      + `git tag ${tag} ${commit} — the ledger entry was NOT recorded.\n`,
    );
    return 1;
  }
  try {
    appendDecision(projectRoot, {
      kind: 'decided',
      // The ledger must pin the version object INDEPENDENTLY of the tag, so
      // it carries the full object id; short forms are display-only.
      text: `Released public snapshot ${tag} from commit ${commit}: `
        + `${fileCount} file(s) exported to ${targetDir}`
        + `${excluded.length > 0 ? `; excluded: ${excluded.join(', ')}` : ''}`,
      by: options.actor ?? 'release',
    });
  } catch (error) {
    io.stderr(
      `WARNING: export and tag ${tag} completed, but the decisions ledger entry FAILED `
      + `(${error instanceof Error ? error.message : String(error)}). Record it by hand: `
      + `nullius decision record "Released public snapshot ${tag} from commit ${commit}"\n`,
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
