import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunOriginV1 } from '@nullius/shared';
import { mintUlid } from '@nullius/shared';

/** Capture the origin stamp for a run: the exact code state of the project
 *  repository at stamp time, graded on the honest binding-quality ladder.
 *
 *  Measurement atomicity: `tracked_modified` is derived FROM the snapshot
 *  commit's diff against the baseline (one object-level comparison), not from
 *  a separate status probe, so there is no inspect-then-snapshot window for
 *  tracked content. Untracked enumeration is a separate instantaneous
 *  observation in the same invocation.
 *
 *  Known limits (by design, stated in the schema): dirty submodule CONTENTS
 *  are not captured (gitlink only); staged vs unstaged is not distinguished;
 *  byte-identity with a concurrently-edited shared worktree is out of scope
 *  (one-worktree-per-lane norm) — the stamp describes the snapshot object it
 *  created, never a fiction.
 */

const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const RUN_SNAPSHOT_REF_PREFIX = 'refs/nullius/runs/';

/** Paths produced by the traceability machinery itself (the ledger, its
 *  lock, .gitattributes carrier, and run-directory origin mirrors). Excluded
 *  from untracked-noise counting so stamping does not demote later stamps
 *  self-referentially. NARROW by construction: only the exact ledger-family
 *  paths under artifacts/runs, and only run_origin.json mirrors that sit
 *  inside one of the two run roots — a research file that happens to share
 *  one of these names anywhere else still counts as untracked. */
export function isTraceabilityArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  if (
    normalized === 'artifacts/runs/validity_ledger.jsonl'
    || normalized === 'artifacts/runs/validity_ledger.jsonl.lock'
    || normalized === 'artifacts/runs/.gitattributes'
  ) {
    return true;
  }
  return path.posix.basename(normalized) === 'run_origin.json'
    && (normalized.startsWith('artifacts/runs/') || normalized.startsWith('team/runs/'));
}

/** Paths inside ANOTHER run's directory under either run root. Excluded
 *  from untracked-noise counting when stamping THIS run: accumulated
 *  outputs of earlier runs say nothing about what code the current run
 *  executes, and counting them demotes every later stamp in a working
 *  session for foreign noise (measured: a 91-run exploratory chain where
 *  every stamp degraded on the previous runs' artifacts). The run's OWN
 *  directory is deliberately NOT excluded — its uncommitted scripts and
 *  manifest are exactly the code-identity uncertainty the grade must
 *  keep reporting. Files sitting directly ON a run root (not inside a run
 *  directory) stay counted too. */
export function isForeignRunPath(relativePath: string, runId: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  for (const root of ['artifacts/runs/', 'team/runs/']) {
    if (!normalized.startsWith(root)) continue;
    const remainder = normalized.slice(root.length);
    const firstSegment = remainder.split('/', 1)[0] ?? '';
    // A first segment with no trailing path is a file on the root itself.
    if (!remainder.includes('/')) return false;
    return firstSegment !== runId;
  }
  return false;
}

function git(projectRoot: string, args: string[], options: { allowFailure?: boolean } = {}): string | null {
  try {
    return execFileSync(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, ...args],
      { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

/** Map a run id onto a valid single ref-name component. Conservative
 *  whitelist (git check-ref-format forbids much more than it allows):
 *  anything outside [A-Za-z0-9._-] becomes '-', dot runs collapse, leading
 *  and trailing dots and a trailing '.lock' are stripped. An empty result
 *  falls back to 'run'. Distinct run ids can in principle collide after
 *  sanitization; the create-if-absent contract below turns that into a hard
 *  error instead of a silent cross-binding. */
export function sanitizeRunRefComponent(runId: string): string {
  let component = runId.replace(/[^A-Za-z0-9._-]/g, '-');
  component = component.replace(/\.{2,}/g, '.');
  component = component.replace(/^\.+/, '').replace(/\.+$/, '');
  while (component.endsWith('.lock')) component = component.slice(0, -'.lock'.length);
  if (component.length === 0) component = 'run';
  return component;
}

export type SnapshotPinOutcome = 'created' | 'already_pinned';

/** Pin a snapshot commit at refs/nullius/runs/<sanitized-run-id> so git gc
 *  can never prune it (unreachable objects are pruned after ~2 weeks).
 *
 *  Create-if-absent: an existing ref pointing at the SAME object is an
 *  idempotent success (a re-stamp of the same state); a different object is
 *  a hard error naming both shas — never overwritten, because silently
 *  rebinding a run id to another session's snapshot is exactly the
 *  cross-binding this contract exists to prevent. */
export function pinSnapshotRef(
  projectRoot: string,
  runId: string,
  snapshotCommit: string,
): { outcome: SnapshotPinOutcome; ref: string } {
  const ref = RUN_SNAPSHOT_REF_PREFIX + sanitizeRunRefComponent(runId);
  // Atomic create-if-absent: the empty <oldvalue> makes git itself require
  // that the ref does not exist yet, closing the read-then-write race two
  // concurrent stampers would otherwise have. On failure, re-read to decide
  // idempotent-success (same object) vs hard error (cross-binding).
  const created = git(projectRoot, ['update-ref', ref, snapshotCommit, ''], { allowFailure: true });
  if (created !== null) return { outcome: 'created', ref };
  const existing = git(projectRoot, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
  const existingSha = existing?.trim() || null;
  if (existingSha === snapshotCommit) return { outcome: 'already_pinned', ref };
  throw new Error(
    `snapshot ref ${ref} already points at ${existingSha ?? '(unreadable)'}, refusing to rebind it to `
    + `${snapshotCommit}; two different runs (or two sessions) appear to share one sanitized run id`,
  );
}

export function listSubmodulePaths(projectRoot: string): string[] {
  if (!fs.existsSync(path.join(projectRoot, '.gitmodules'))) return [];
  const output = git(
    projectRoot,
    ['config', '-f', '.gitmodules', '--get-regexp', String.raw`submodule\..*\.path`],
    { allowFailure: true },
  );
  if (!output) return [];
  return output
    .trim()
    .split('\n')
    .map(line => line.split(/\s+/).slice(1).join(' '))
    .filter(entry => entry.length > 0);
}

export type CaptureRunOriginOptions = {
  /** Dependency repositories to record, keyed by a caller-chosen name. */
  deps?: Record<string, string>;
  /** Reuse a previously minted event id (crash-recovery retry of the SAME
   *  logical stamp). */
  eventId?: string;
  /** When false, capture WITHOUT pinning the snapshot at
   *  refs/nullius/runs/<run-id> — a read-only identity probe (the stash
   *  object stays an unreferenced dangling commit for git to collect). Used
   *  to compare the current tree against an already-recorded stamp before
   *  deciding whether a new ledger event is warranted. Default true: a
   *  recorded stamp must always pin what it describes. */
  pin?: boolean;
};

/** Capture the origin of `runId` in the repository at `projectRoot`. */
export function captureRunOrigin(
  projectRoot: string,
  runId: string,
  options: CaptureRunOriginOptions = {},
): RunOriginV1 {
  const capturedAt = new Date().toISOString();
  const eventId = options.eventId ?? mintUlid();

  const base: Record<string, unknown> = {
    schema_id: 'run_origin_v1',
    event_id: eventId,
    run_id: runId,
    captured_at_utc: capturedAt,
  };

  const insideWorkTree = git(projectRoot, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (insideWorkTree?.trim() !== 'true') {
    return {
      ...base,
      binding_quality: 'unbound',
      baseline_commit: null,
      dirty: { tracked_modified: 0, untracked_count: 0 },
      no_repo_reason: 'project root is not inside a git work tree',
    } as RunOriginV1;
  }
  const head = git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
  const baselineCommit = head?.trim() || null;
  if (!baselineCommit || !SHA_PATTERN.test(baselineCommit)) {
    return {
      ...base,
      binding_quality: 'unbound',
      baseline_commit: null,
      dirty: { tracked_modified: 0, untracked_count: 0 },
      no_repo_reason: 'repository has no commit yet (unborn HEAD)',
    } as RunOriginV1;
  }

  // Snapshot FIRST, then derive the tracked-modification count from the
  // snapshot object itself — no window between inspect and snapshot.
  // Stat-cache refresh precedes the snapshot: after an edit is REVERTED
  // byte-identically (a routine agent motion), the index is stat-dirty
  // while the content is clean, and `git stash create` exits nonzero on
  // its FIRST invocation in that state — which would misread an ordinary
  // tree as a broken measurement. The refresh's own exit code carries no
  // information here (nonzero merely means real modifications exist),
  // hence allowFailure.
  git(projectRoot, ['update-index', '-q', '--refresh'], { allowFailure: true });
  // NOT allowFailure: a failing `stash create` must throw, because mapping a
  // failure onto the same null as a legitimately clean tree would grade a
  // broken measurement `exact_clean` — the one direction the honesty ladder
  // must never err in. Empty output on success = genuinely clean.
  const stashOutput = git(projectRoot, ['stash', 'create']);
  const snapshotCommit = stashOutput?.trim() || null;
  let snapshotTree: string | null = null;
  let trackedModified = 0;
  if (snapshotCommit && SHA_PATTERN.test(snapshotCommit)) {
    if (options.pin !== false) pinSnapshotRef(projectRoot, runId, snapshotCommit);
    snapshotTree = git(projectRoot, ['rev-parse', `${snapshotCommit}^{tree}`])!.trim();
    const diff = git(projectRoot, ['diff', '--name-only', baselineCommit, snapshotCommit])!;
    trackedModified = diff.split('\n').filter(line => line.trim().length > 0).length;
  } else {
    snapshotTree = git(projectRoot, ['rev-parse', `${baselineCommit}^{tree}`])!.trim();
  }

  // Untracked, non-ignored paths: a pure-read enumeration (ls-files touches
  // no index), labeled an instantaneous observation. The traceability
  // machinery's own on-disk artifacts are excluded — a stamp writes the
  // ledger and a run_origin.json mirror, and counting those as "unknown code
  // delta" would demote every stamp after the first for self-referential
  // noise, not for actual code drift. (They still belong in version control;
  // exclusion here only keeps the honesty grade about the RESEARCH tree.)
  const untrackedOutput = git(projectRoot, ['ls-files', '--others', '--exclude-standard'])!;
  const untracked = untrackedOutput
    .split('\n')
    .filter(line => line.trim().length > 0)
    .filter(line => !isTraceabilityArtifactPath(line))
    // Other runs' accumulated artifacts are not THIS run's code delta.
    .filter(line => !isForeignRunPath(line, runId));

  // Dirty submodule CONTENTS (gitlink unchanged, inner tree dirty) are the
  // one tracked-side change the snapshot cannot carry; count them so the
  // honesty grade can demote.
  let submodulesDirty = 0;
  for (const submodulePath of listSubmodulePaths(projectRoot)) {
    const absolute = path.join(projectRoot, submodulePath);
    if (!fs.existsSync(path.join(absolute, '.git'))) continue;
    // Untracked files INSIDE a submodule are also invisible to the
    // superproject snapshot, so they count toward the dirty grade too —
    // hiding them behind --untracked-files=no would over-claim exactness.
    const inner = git(absolute, ['status', '--porcelain'], { allowFailure: true });
    if (inner === null || inner.trim().length > 0) submodulesDirty += 1;
  }

  const dirty = {
    tracked_modified: trackedModified,
    untracked_count: untracked.length,
    ...(untracked.length > 0 ? { untracked_sample: untracked.slice(0, 20) } : {}),
    ...(submodulesDirty > 0 ? { submodules_dirty: submodulesDirty } : {}),
  };

  const bindingQuality = untracked.length > 0 || submodulesDirty > 0
    ? 'head_plus_untracked'
    : trackedModified > 0
      ? 'exact_tracked_snapshot'
      : 'exact_clean';

  const deps: Record<string, string> = {};
  for (const [name, depRoot] of Object.entries(options.deps ?? {})) {
    const depHead = git(depRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
    const sha = depHead?.trim();
    if (sha && SHA_PATTERN.test(sha)) deps[name] = sha;
  }

  return {
    ...base,
    binding_quality: bindingQuality,
    baseline_commit: baselineCommit,
    ...(snapshotCommit && SHA_PATTERN.test(snapshotCommit) ? { snapshot_commit: snapshotCommit } : {}),
    snapshot_tree: snapshotTree,
    dirty,
    ...(Object.keys(deps).length > 0 ? { deps } : {}),
  } as RunOriginV1;
}

/** The effective code identity of a stamped run: the commit whose TREE is
 *  the code that ran — snapshot_commit when tracked files were dirty, else
 *  baseline_commit. Null for aligned/unbound stamps. */
export function effectiveCodeIdentity(origin: RunOriginV1): string | null {
  const record = origin as unknown as Record<string, unknown>;
  const snapshot = typeof record.snapshot_commit === 'string' ? record.snapshot_commit : null;
  const baseline = typeof record.baseline_commit === 'string' ? record.baseline_commit : null;
  const quality = record.binding_quality;
  if (quality === 'aligned_heuristic' || quality === 'unbound') return null;
  return snapshot ?? baseline;
}
