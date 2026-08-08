import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOriginV1, ValidityEventV1 } from '@nullius/shared';
import { mintUlid, ULID_PATTERN, writeBytesAtomicDurable } from '@nullius/shared';
import { createHash } from 'node:crypto';
import { appendValidityEvent, buildValidityEvent, readValidityLedger, type ValidityLedgerView } from './validity-ledger.js';
import { captureRunOrigin, isTraceabilityArtifactPath, readAttemptSnapshotRef, swapAttemptSnapshotRef } from './run-origin.js';
import { validateResultRegistry } from './result-registry.js';
import { refreshNotebookCurrentState } from './notebook-current-state.js';

/** The actor recorded on ledger events when the caller has no better name:
 *  the OS user, matching what the hand-invoked CLI has always written. */
export function defaultStampActor(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The full origin-stamp write flow, shared by every stamp entrance: the
 *  `nullius trace stamp` CLI verb and the computation front door's automatic
 *  launch stamp. One implementation so the containment rules (run-root
 *  membership, canonical-root preference, symlink refusal), the event-id
 *  idempotency contract, and the mirror-rollback discipline cannot drift
 *  between the hand-invoked and machine-invoked paths.
 *
 *  Results are structured, not printed: callers own their rendering. A
 *  `rejected` outcome carries the exact operator-facing sentence the CLI
 *  historically printed, so the CLI wrapper stays byte-identical. */

export type StampRunOptions = {
  actor: string;
  /** Crash-recovery retry of the SAME logical stamp: when set, the ledger is
   *  the retry entrance (was this event recorded?), never a payload compare. */
  eventId?: string | null;
  /** Dependency repositories to record, keyed by a caller-chosen name. */
  deps?: Record<string, string>;
};

export type StampRunResult =
  /** Preflight refused; `message` is the operator-facing reason. */
  | { kind: 'rejected'; message: string }
  /** --event-id preflight found the event already recorded for this run. */
  | { kind: 'already_recorded'; runId: string; eventId: string }
  /** A stamp for this run (under a DIFFERENT event id) is already on the
   *  ledger — one run id carries one stamp, so nothing was appended.
   *  `recordedOrigin` is the authoritative stamp payload (null only when
   *  the ledger line lacks one), for the caller to grade the current tree
   *  against (same tree → benign no-op; different tree → stale). */
  | { kind: 'run_already_stamped'; runId: string; recordedOrigin: RunOriginV1 | null }
  /** Capture ran and the ledger append completed (or found the identical
   *  line already present under the lock). */
  | {
    kind: 'stamped';
    runId: string;
    eventId: string;
    origin: RunOriginV1;
    mirrorWritten: boolean;
    appendOutcome: 'appended' | 'already_present';
  };

/** Resolve a stamp target the way the CLI always has: absolute paths stand,
 *  relative paths resolve against the PROJECT ROOT (not the shell cwd). */
export function resolveStampTarget(projectRoot: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
}

/** True when `runDir` sits DIRECTLY under one of the two stampable run
 *  roots. Symlink-resolved on BOTH sides — every root-membership decision
 *  (the stamp containment below AND the front door's identity check) must
 *  share this one predicate: two callers answering "inside a run root?"
 *  with different resolution semantics is how a symlinked project root
 *  makes one of them stamp what the other refused to bind. A path that
 *  cannot be resolved is not inside any root. */
export function isInsideStampableRoot(projectRoot: string, runDir: string): boolean {
  let resolvedRunDir: string;
  try {
    resolvedRunDir = fs.realpathSync(runDir);
  } catch {
    return false;
  }
  return ['artifacts/runs', 'team/runs'].some((relRoot) => {
    const root = path.resolve(projectRoot, relRoot);
    if (!fs.existsSync(root)) return false;
    try {
      return path.dirname(resolvedRunDir) === fs.realpathSync(root);
    } catch {
      return false;
    }
  });
}

/** The commit whose TREE is the code a stamp describes: snapshot when
 *  tracked files were dirty, else the baseline. Null for aligned/unbound
 *  stamps (no exact identity to compare against). */
export function stampedCodeCommit(origin: unknown): string | null {
  const record = origin as Record<string, unknown> | null;
  if (!record) return null;
  if (record.binding_quality === 'aligned_heuristic' || record.binding_quality === 'unbound') return null;
  const snapshot = typeof record.snapshot_commit === 'string' ? record.snapshot_commit : null;
  const baseline = typeof record.baseline_commit === 'string' ? record.baseline_commit : null;
  return snapshot ?? baseline;
}

/** Control-plane bookkeeping the execution machinery itself rewrites on
 *  every launch (run state, the decision ledger, approval receipts under
 *  .nullius/). Counting those as research-code drift would make EVERY
 *  relaunch read as "different code" — the same self-referential noise the
 *  untracked-side exclusion (isTraceabilityArtifactPath) already handles. */
function isControlPlanePath(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  return normalized === '.nullius' || normalized.startsWith('.nullius/');
}

/** True when two stamped code identities differ ONLY in control-plane
 *  bookkeeping — i.e. the RESEARCH code is the same tree. Throws when git
 *  cannot compare the objects (e.g. a recorded commit missing from this
 *  repository); callers map that to an explicit failure, never to "same". */
export function sameResearchCode(projectRoot: string, commitA: string, commitB: string): boolean {
  if (commitA === commitB) return true;
  const diff = execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, 'diff', '--name-only', commitA, commitB],
    { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return diff
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .every(line => isControlPlanePath(line) || isTraceabilityArtifactPath(line));
}

/** What a stamp rollback may do to the mirror file: undo only what THIS
 *  invocation wrote. Between our mirror write and the rollback a concurrent
 *  stamper may have won the ledger race and written ITS mirror — removing
 *  or overwriting the winner's file would orphan a successful stamp that
 *  just reported its mirror written. So: bytes on disk are ours → restore
 *  whatever preceded us (previous content, or remove what we created);
 *  bytes are anyone else's (or the file is gone) → leave it alone. */
export function mirrorRollbackAction(
  currentBytes: string | null,
  ourBytes: string,
  previousBytes: string | null,
): 'restore_previous' | 'remove' | 'leave' {
  if (currentBytes !== ourBytes) return 'leave';
  return previousBytes !== null ? 'restore_previous' : 'remove';
}

export type ExistingStampGrade =
  | { grade: 'same_tree'; bindingQuality: string }
  | { grade: 'untracked_delta'; bindingQuality: string; signalUntracked: number }
  | { grade: 'different_tree' };

/** Grade an already-recorded stamp against the CURRENT tree.
 *
 *  - same_tree: the tracked research code is the same AND no new
 *    code-bearing untracked paths appeared — a benign re-entry.
 *  - untracked_delta: the tracked tree is unchanged, but the recorded
 *    stamp claims an EXACT grade while the probe now sees SIGNAL
 *    untracked paths (the run's own directory, or outside the run roots).
 *    The recorded exactness no longer describes what a relaunch would
 *    execute; commit the new files or use a fresh run id. The signal
 *    scope is deliberate: FOREIGN runs' accumulation (which the honesty
 *    grade conservatively keeps counting) must not trip this, or every
 *    re-entry in a busy project would false-alarm — quality asks "how
 *    certain is this stamp" (full set), re-entry asks "did code RELEVANT
 *    TO THIS RUN change" (signal set).
 *  - different_tree: the tracked code itself changed — the honest
 *    response is a fresh run id, never a silent rebind.
 *
 *  The probe is read-only apart from a git stat-cache refresh
 *  (pin:false — no ref is created). */
export function gradeExistingStamp(
  projectRoot: string,
  runId: string,
  recordedOrigin: RunOriginV1 | null,
): ExistingStampGrade {
  const probe = captureRunOrigin(projectRoot, runId, { pin: false });
  const knownCommit = stampedCodeCommit(recordedOrigin);
  const probeCommit = stampedCodeCommit(probe);
  const same = knownCommit === null || probeCommit === null
    ? knownCommit === probeCommit
    : sameResearchCode(projectRoot, knownCommit, probeCommit);
  if (!same) return { grade: 'different_tree' };
  const recordedRecord = recordedOrigin as unknown as Record<string, unknown> | null;
  const recordedQuality = typeof recordedRecord?.binding_quality === 'string'
    ? recordedRecord.binding_quality
    : 'unknown';
  if (recordedQuality === 'exact_clean' || recordedQuality === 'exact_tracked_snapshot') {
    const signalUntracked = countCodeBearingUntracked(projectRoot, runId);
    if (signalUntracked > 0) {
      return { grade: 'untracked_delta', bindingQuality: recordedQuality, signalUntracked };
    }
  }
  return { grade: 'same_tree', bindingQuality: recordedQuality };
}

/** The run's declared OUTPUT paths, workspace-relative, read from its own
 *  manifest. A manifest may declare outputs anywhere inside the workspace
 *  (including under scripts/), so metabolism-vs-code cannot be decided by
 *  location alone — the declaration decides. Unreadable or malformed
 *  manifest → empty set (conservative: nothing gets excluded on its say-so). */
function declaredOutputPaths(projectRoot: string, ownRunPrefix: string): Set<string> {
  const declared = new Set<string>();
  const runDir = path.join(projectRoot, ownRunPrefix);
  for (const workspace of findComputationWorkspaces(runDir)) {
    if (!workspace.manifestPath) continue;
    const workspacePrefix = workspace.workspaceRel === ''
      ? ownRunPrefix
      : path.posix.join(ownRunPrefix, workspace.workspaceRel);
    try {
      const parsed = JSON.parse(fs.readFileSync(workspace.manifestPath, 'utf-8')) as {
        steps?: Array<{ expected_outputs?: string[] }>;
      };
      for (const step of parsed.steps ?? []) {
        for (const output of step.expected_outputs ?? []) {
          if (typeof output === 'string' && output.length > 0) {
            declared.add(path.posix.join(workspacePrefix, output.split('\\').join('/')));
          }
        }
      }
    } catch {
      // Conservative: an unreadable manifest excludes nothing.
    }
  }
  return declared;
}

/** The runner's own write surface inside a run directory — files the
 *  execution machinery itself produces on every launch. Counting these as
 *  code deltas would flag every same-tree relaunch of a completed run. */
type ContainedRunDir =
  | { kind: 'ok'; runDir: string; runId: string }
  | { kind: 'rejected'; message: string };

/** Shared containment for every verb that writes about a run directory:
 *  only the two run roots are addressable (a record about a run the read
 *  model can never show is a silent hole), symlinked run dirs are refused
 *  (the directory scan skips symlink entries — same hole through a side
 *  door), and the canonical-root rule (D9) sends writers to artifacts/runs
 *  when both roots carry the id. */
function resolveContainedRunDirectory(
  projectRoot: string,
  target: string,
  verb: string,
  verbNoun: string,
): ContainedRunDir {
  const runDir = resolveStampTarget(projectRoot, target);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    return { kind: 'rejected', message: `${verb}: run directory not found: ${runDir}` };
  }
  if (fs.lstatSync(runDir).isSymbolicLink()) {
    return {
      kind: 'rejected',
      message: `${verb}: ${target} is a symlink; run directories must be real directories under a run root`,
    };
  }
  if (!isInsideStampableRoot(projectRoot, runDir)) {
    return {
      kind: 'rejected',
      message: `${verb}: run directories live directly under artifacts/runs/ or team/runs/; `
        + `${target} is outside both roots and would be invisible to the read model`,
    };
  }
  const runId = path.basename(runDir);
  const canonicalDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  const mirrorDirOfCanonical = path.join(projectRoot, 'team', 'runs', runId);
  if (
    path.resolve(runDir) === path.resolve(mirrorDirOfCanonical)
    && fs.existsSync(canonicalDir)
  ) {
    return {
      kind: 'rejected',
      message: `${verb}: ${runId} exists under artifacts/runs (canonical) and team/runs (review mirror); `
        + `${verbNoun} the canonical directory: artifacts/runs/${runId}`,
    };
  }
  return { kind: 'ok', runDir, runId };
}

function isRunnerWriteSurface(insideOwnRun: string, workspaceRels: string[]): boolean {
  // Prior attempts' archived residue: quarantined by the retry entrance,
  // never deleted; counting it as "unknown code delta" would demote every
  // post-retry stamp for bookkeeping the machinery itself created.
  if (insideOwnRun.startsWith('attempts/') || insideOwnRun.startsWith('artifacts/')) return true;
  // The runner's own entries under WHATEVER directory the manifest made
  // the workspace ('computation' is the convention, not a guarantee).
  const roots = workspaceRels.length > 0 ? workspaceRels : ['computation'];
  return roots.some((workspaceRel) => {
    const prefix = workspaceRel === '' ? '' : `${workspaceRel}/`;
    return insideOwnRun === `${prefix}execution_status.json`
      || insideOwnRun.startsWith(`${prefix}logs/`)
      || insideOwnRun.startsWith(`${prefix}outputs/`)
      || insideOwnRun.startsWith(`${prefix}workspace/`);
  });
}

/** Untracked paths that bear on THIS run's code identity, for re-entry
 *  grading. Signal = everything untracked EXCEPT (a) control-plane and
 *  traceability bookkeeping, (b) OTHER runs' directories (their
 *  accumulation is not this run's code — the honesty GRADE still counts
 *  them conservatively; this narrower scope answers a different question:
 *  did code relevant to this run change), (c) stray files directly ON a
 *  run root (indistinguishable from machine-maintained files — stated
 *  limit), and (d) inside the run's OWN directory, the runner's write
 *  surface plus the manifest's DECLARED expected outputs. Everything else
 *  in the own directory — a helper module, an undeclared file, the
 *  manifest itself — is conservatively signal: manifests may reference
 *  scripts anywhere in the workspace, so no location whitelist can clear
 *  a file as non-code, and an undeclared output SHOULD have been declared
 *  (the manifest contract) — its one-line fix is to declare or commit it. */
function countCodeBearingUntracked(projectRoot: string, runId: string): number {
  const output = execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, 'ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ownRunPrefixes = ['artifacts/runs', 'team/runs'].map(root => `${root}/${runId}`);
  const declaredOutputs = new Set<string>(
    ownRunPrefixes.flatMap(prefix => [...declaredOutputPaths(projectRoot, prefix)]),
  );
  const workspaceRelsByPrefix = new Map<string, string[]>(
    ownRunPrefixes.map(prefix => [
      prefix,
      findComputationWorkspaces(path.join(projectRoot, prefix)).map(workspace => workspace.workspaceRel),
    ]),
  );
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !isTraceabilityArtifactPath(line))
    .filter(line => !isControlPlanePath(line))
    .filter((line) => {
      const own = ownRunPrefixes.find(prefix => line.startsWith(`${prefix}/`));
      if (own) {
        const inside = line.slice(own.length + 1);
        if (isRunnerWriteSurface(inside, workspaceRelsByPrefix.get(own) ?? [])) return false;
        if (declaredOutputs.has(line)) return false;
        return true;
      }
      // Inside a run root but another run's directory, or a stray file
      // directly on the root: not this run's code signal.
      if (line.startsWith('artifacts/runs/') || line.startsWith('team/runs/')) return false;
      return true;
    })
    .length;
}

export function stampRunDirectory(
  projectRoot: string,
  target: string,
  options: StampRunOptions,
): StampRunResult {
  const contained = resolveContainedRunDirectory(projectRoot, target, 'trace stamp', 'stamp');
  if (contained.kind === 'rejected') return contained;
  const { runDir, runId } = contained;
  // One logical stamp = one ULID for life: with --event-id the retry
  // entrance is the LEDGER (was this event already recorded?), not a
  // payload comparison — a re-capture would legitimately differ (time
  // moved, the tree may have moved) and must not read as divergence.
  // The short-circuit accepts ONLY a stamp event for THIS run: reusing
  // an id that belongs to any other event must fail loudly, never
  // report a stamp that was not taken. Validation happens BEFORE any
  // mirror write so a rejected id leaves no half-state behind.
  if (options.eventId) {
    if (!ULID_PATTERN.test(options.eventId)) {
      return {
        kind: 'rejected',
        message: `trace stamp: --event-id ${JSON.stringify(options.eventId)} is not a ULID`,
      };
    }
    const ledgerView = readValidityLedger(projectRoot);
    // Divergent ids are excluded from `events` by the reader's dedup —
    // check the defect list too, or a divergent id would sail past this
    // preflight into a mirror write before the append rejects it.
    if (ledgerView.integrity_defects.some(defect => defect.event_id === options.eventId)) {
      return {
        kind: 'rejected',
        message: `trace stamp: event ${options.eventId} is a ledger-integrity defect (divergent payloads); `
          + 'repair the ledger and mint a fresh event id',
      };
    }
    const existing = ledgerView.events.find(event => event.event_id === options.eventId);
    if (existing) {
      if (existing.event !== 'stamp' || existing.run_id !== runId) {
        return {
          kind: 'rejected',
          message: `trace stamp: event ${options.eventId} is already recorded as a ${existing.event} `
            + `for ${existing.run_id}; it cannot identify a stamp of ${runId}`,
        };
      }
      return { kind: 'already_recorded', runId: existing.run_id, eventId: options.eventId };
    }
  }
  // One run id, one stamp: a stamp already on the ledger (under another
  // event id) short-circuits before any capture or write. This unlocked
  // pre-read serves the common re-entry case; the race two concurrent
  // stampers would run past it is closed by the same predicate evaluated
  // INSIDE the append lock below.
  const preRead = readValidityLedger(projectRoot);
  const preKnown = preRead.runs.get(runId);
  if (preKnown?.stamped) {
    return { kind: 'run_already_stamped', runId, recordedOrigin: preKnown.origin };
  }
  const eventId = options.eventId ?? mintUlid();
  const origin = captureRunOrigin(projectRoot, runId, {
    deps: options.deps ?? {},
    eventId,
  });
  // Mirror attempted before the append so its outcome is recorded in the
  // authoritative event; AUTHORITY stays with the ledger regardless of
  // write order (all consumers read the ledger, D2).
  const mirrorPath = path.join(runDir, 'run_origin.json');
  const previousMirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
  let mirrorWritten = true;
  try {
    writeBytesAtomicDurable(mirrorPath, `${JSON.stringify(origin, null, 2)}\n`);
  } catch {
    mirrorWritten = false;
    // Commit-uncertain: the atomic helper renames before its final
    // durability step, so on failure the destination may already hold
    // the new bytes. Best-effort restore either way — harmless when the
    // rename never happened, and the only defense against clobbering a
    // pre-existing legacy mirror with no ledger event behind it.
    try {
      if (previousMirror !== null) writeBytesAtomicDurable(mirrorPath, previousMirror);
      else fs.rmSync(mirrorPath, { force: true });
    } catch {
      // Restore is best-effort; the divergence scan surfaces leftovers.
    }
  }
  const payload = {
    ...(origin as unknown as Record<string, unknown>),
    ...(mirrorWritten ? {} : { run_dir_unwritable: true }),
  };
  const event = buildValidityEvent({
    event: 'stamp',
    run_id: runId,
    actor: options.actor,
    reason: null,
    stamp: payload as ValidityEventV1['stamp'],
    event_id: eventId,
    ts_utc: (payload as { captured_at_utc: string }).captured_at_utc,
  });
  const writtenMirrorBytes = `${JSON.stringify(origin, null, 2)}\n`;
  const rollbackMirror = () => {
    if (!mirrorWritten) return;
    try {
      const current = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
      const action = mirrorRollbackAction(current, writtenMirrorBytes, previousMirror);
      if (action === 'restore_previous') writeBytesAtomicDurable(mirrorPath, previousMirror!);
      else if (action === 'remove') fs.rmSync(mirrorPath, { force: true });
      // (A writer sneaking in between the read above and the write here is
      // a residual window; its worst case is the same divergence the
      // mirror scan already surfaces.)
    } catch {
      // A failing restore must not mask the primary outcome; the
      // divergence scan surfaces the leftover mirror on the next read.
    }
  };
  let appendOutcome;
  try {
    appendOutcome = appendValidityEvent(projectRoot, event, { onlyIfRunUnstamped: true });
  } catch (error) {
    // No orphan and no clobber: a mirror this invocation created is
    // removed; a pre-existing one is restored to its prior content.
    rollbackMirror();
    throw error;
  }
  if (appendOutcome === 'skipped_run_already_stamped') {
    // A concurrent stamper won the race between our pre-read and the lock:
    // their stamp is the record, our capture and mirror are not. Roll the
    // mirror back and report theirs.
    rollbackMirror();
    const postRead = readValidityLedger(projectRoot);
    return {
      kind: 'run_already_stamped',
      runId,
      recordedOrigin: postRead.runs.get(runId)?.origin ?? null,
    };
  }
  if (appendOutcome === 'skipped_attempt_not_chain_head') {
    // Plain stamps never pass onlyIfAttemptChainHead; reaching this arm
    // would mean the option object above changed without this fork.
    rollbackMirror();
    throw new Error('unreachable: plain stamp append reported an attempt-chain skip');
  }
  // Best-effort notebook current-state refresh at the ONE writer shared by
  // the CLI stamp verb and the computation front door's launch stamp. The
  // block renders from the registry projection, so a plain stamp almost
  // never changes it (zero writes at fast cadence); it does change when a
  // stamp flips a REGISTERED run's sentinel status. Computing the full
  // projection re-hashes every registered artifact — unacceptable per stamp
  // at field cadence — so the hot path first checks cheaply whether this
  // run id appears in project_index.md at all: a stamp for an unregistered
  // run cannot alter the projection. (Unrelated pre-existing staleness is
  // the read side's job to name, not this hook's job to repair.) A refresh
  // failure must never fail the stamp — the ledger event is the record.
  if (appendOutcome === 'appended') {
    try {
      let registryMentionsRun = false;
      try {
        registryMentionsRun = fs
          .readFileSync(path.join(projectRoot, 'project_index.md'), 'utf-8')
          .includes(runId);
      } catch {
        // no index, nothing registered, nothing to refresh
      }
      if (registryMentionsRun) {
        refreshNotebookCurrentState(projectRoot, { insertIfMissing: false });
      }
    } catch {
      // surfaced on the next status/current read as out-of-sync
    }
  }
  return {
    kind: 'stamped',
    runId,
    eventId: event.event_id,
    origin: payload as unknown as RunOriginV1,
    mirrorWritten,
    appendOutcome,
  };
}

/** ---- Attempt–run separation: the retry entrance -------------------------
 *
 *  A run id names one EXPERIMENT SLOT; each execution of it is an ATTEMPT
 *  with its own launch-time code capture. A crash that provably (or, for
 *  hand runs, declaredly) produced no retained result is retriable under
 *  the SAME id at near-zero ceremony: one atomic `attempt` ledger event
 *  closes the failed ordinal (typed outcome + machine evidence + quarantine
 *  record) and embeds the NEXT attempt's fresh origin — a silent rebind is
 *  unrepresentable because a new binding can only ride inside a closure.
 *  Content-wrong results NEVER pass here: they keep the full supersede/void
 *  ceremony and a fresh id.
 */

export type RetryEvidence = {
  method: 'execution_status' | 'outputs_scan' | 'declared';
  detail: string;
  execution_status_sha256?: string;
  exit_code?: number;
  quarantined_paths_count?: number;
};

export type OpenRetryResult =
  | { kind: 'rejected'; message: string }
  | { kind: 'already_recorded'; runId: string; eventId: string }
  | { kind: 'attempt_conflict'; runId: string; message: string }
  | {
    kind: 'retried';
    runId: string;
    eventId: string;
    closedOrdinal: number;
    openedOrdinal: number | null; // null = record-only closure
    previousOutcome: 'failed' | 'missing' | 'stalled' | 'declared_no_result';
    evidence: RetryEvidence;
    quarantinedTo: string | null;
    origin: RunOriginV1 | null;
    mirrorWritten: boolean;
  };

/** Where a run's computation actually lives. `nullius run --manifest`
 *  accepts a manifest ANYWHERE inside the run directory and derives the
 *  workspace (and the runner's execution_status.json) from the manifest's
 *  own directory — so every boundary that hardcoded computation/ was blind
 *  to a relocated manifest. This discovery is the one shared answer:
 *  directories (bounded depth, attempts/ excluded — quarantined residue
 *  must never read as a live workspace) that hold a manifest or a status
 *  file. */
export type ComputationWorkspace = {
  /** Run-relative posix path ('' = the run root itself). */
  workspaceRel: string;
  manifestPath: string | null;
  statusPath: string | null;
};

export function findComputationWorkspaces(
  runDir: string,
  stats?: { truncated: boolean },
): ComputationWorkspace[] {
  const found: ComputationWorkspace[] = [];
  // The manifest may sit at ANY depth (prepareManifest only requires
  // containment in the run directory), so discovery has no depth cap — a
  // capped walk would leave every boundary blind to a deep workspace. The
  // walk stays cheap by pruning a discovered workspace's own product
  // subtrees (logs/outputs/workspace — a manifest planted inside runner
  // products is not an execution surface), never following directory
  // symlinks, and bounding pathological trees by visited-directory count.
  // Hitting the bound is REPORTED via `stats.truncated` — a truncated walk
  // may have missed a workspace, and every boundary consuming this must
  // refuse to rule rather than rule on a partial survey.
  let visited = 0;
  const walk = (rel: string): void => {
    if (visited >= 10_000) {
      if (stats) stats.truncated = true;
      return;
    }
    visited += 1;
    const abs = rel === '' ? runDir : path.join(runDir, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const fileNames = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
    const isWorkspace = fileNames.has('manifest.json') || fileNames.has('execution_status.json');
    if (isWorkspace) {
      found.push({
        workspaceRel: rel,
        manifestPath: fileNames.has('manifest.json') ? path.join(abs, 'manifest.json') : null,
        statusPath: fileNames.has('execution_status.json') ? path.join(abs, 'execution_status.json') : null,
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      // Manifest preparation accepts dot-prefixed directories, so discovery
      // must walk them too — only .git (never an execution surface) stays
      // out. Staging directories live under attempts/, excluded at the
      // root.
      if (entry.name === '.git') continue;
      if (rel === '' && (entry.name === 'attempts' || entry.name === 'artifacts')) continue;
      if (isWorkspace && (entry.name === 'logs' || entry.name === 'outputs' || entry.name === 'workspace')) continue;
      walk(rel === '' ? entry.name : path.posix.join(rel, entry.name));
    }
  };
  walk('');
  return found;
}

/** Every INPUT path a manifest declares, workspace-relative → run-relative:
 *  the manifest itself, the scripts it names, and the declared dependency
 *  surface (lock files, data files, external dependency refs) — all of
 *  which the relaunch requires in place. Malformed entries (absolute,
 *  dot-dot, URI-schemed) are simply not credited — conservative toward the
 *  product side. */
function manifestInputPaths(workspace: ComputationWorkspace): Set<string> {
  const inputs = new Set<string>();
  if (!workspace.manifestPath) return inputs;
  const prefix = workspace.workspaceRel;
  const toRunRel = (wsRel: string): string => (prefix === '' ? wsRel : path.posix.join(prefix, wsRel));
  inputs.add(toRunRel('manifest.json'));
  const credit = (declared: unknown): void => {
    if (typeof declared !== 'string' || declared.length === 0) return;
    const clean = declared.split('\\').join('/');
    if (clean.startsWith('/') || clean.split('/').includes('..') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(clean)) return;
    inputs.add(toRunRel(clean));
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(workspace.manifestPath, 'utf-8')) as {
      entry_point?: { script?: string };
      steps?: Array<{ script?: string }>;
      dependencies?: {
        lock_files?: string[];
        data_files?: string[];
        external_dependency_refs?: Array<{ path?: string }>;
      };
    };
    credit(parsed.entry_point?.script);
    for (const step of parsed.steps ?? []) credit(step.script);
    for (const lockFile of parsed.dependencies?.lock_files ?? []) credit(lockFile);
    for (const dataFile of parsed.dependencies?.data_files ?? []) credit(dataFile);
    for (const ref of parsed.dependencies?.external_dependency_refs ?? []) credit(ref?.path);
  } catch {
    // Unreadable manifest credits nothing as input beyond itself.
  }
  return inputs;
}

/** Run-relative paths of files git tracks inside this run directory.
 *  Tracked files are part of the captured tree by definition — moving one
 *  would DIRTY the very tree the fresh capture is about to bind, so they
 *  are residue (they exist) but never movable. Empty set when git cannot
 *  answer. */
function trackedPathsUnder(projectRoot: string, runDir: string): Set<string> {
  const tracked = new Set<string>();
  const rel = path.relative(projectRoot, runDir);
  if (rel.startsWith('..')) return tracked;
  try {
    const output = execFileSync(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', projectRoot, 'ls-files', '--', rel],
      { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const prefix = `${rel.split(path.sep).join('/')}/`;
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(prefix)) tracked.add(trimmed.slice(prefix.length));
    }
  } catch {
    // No git answer → nothing credited as tracked.
  }
  return tracked;
}

/** The PRODUCT surface of the current attempt, one enumeration shared by
 *  the residue check (is there anything a resultless crash left behind?)
 *  and the quarantine (what must move aside so attempt N's bytes cannot
 *  ride into attempt N+1's binding). Sharing one walk is the point — the
 *  two consumers drifting apart is exactly how a checkpoint file stayed
 *  live while the residue check reported the surface handled.
 *
 *  Classification, walking from the run root:
 *  - bookkeeping at the root (run_origin.json, attempts/, a root-level
 *    manifest.json) is neither residue nor movable;
 *  - manifest-credited inputs (each workspace's manifest + the scripts it
 *    names) stay;
 *  - a root-level computation/ WITHOUT a manifest or status file keeps the
 *    legacy convention: it is an input-staging area, and only the runner's
 *    own four entries under it count (a launch that dies before its first
 *    product must still heal as `missing`);
 *  - everything else — runner write surface, declared outputs, terminal
 *    artifacts/, checkpoints, ANY undeclared write — is residue; the
 *    movable subset excludes git-tracked files (part of the captured tree)
 *    and recurses into directories that mix inputs or tracked files with
 *    products. */
function enumerateAttemptProducts(
  projectRoot: string,
  runDir: string,
): { workspaces: ComputationWorkspace[]; residue: string[]; movable: string[]; truncated: boolean } {
  const discovery = { truncated: false };
  const workspaces = findComputationWorkspaces(runDir, discovery);
  const inputs = new Set<string>();
  for (const workspace of workspaces) {
    for (const input of manifestInputPaths(workspace)) inputs.add(input);
  }
  const tracked = trackedPathsUnder(projectRoot, runDir);
  const residue: string[] = [];
  const movable: string[] = [];
  const hasPrefixIn = (set: Set<string>, rel: string): boolean => {
    const prefix = `${rel}/`;
    for (const candidate of set) {
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  };
  const workspaceRoots = new Set(workspaces.map(workspace => workspace.workspaceRel));
  const classify = (rel: string): void => {
    const abs = rel === '' ? runDir : path.join(runDir, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : path.posix.join(rel, entry.name);
      // Root-level bookkeeping is neither residue nor movable: the mirror,
      // the attempt archives, a root-level manifest, and the A3 approval
      // audit trail (approvals/ holds the packets pending approvals are
      // read back from — archiving it would sever a pending approval).
      if (rel === '' && (entry.name === 'run_origin.json' || entry.name === 'attempts'
        || entry.name === 'manifest.json' || entry.name === 'approvals')) {
        continue;
      }
      if (inputs.has(childRel)) continue;
      if (entry.isDirectory()) {
        if (rel === '' && entry.name === 'computation' && !workspaceRoots.has('computation')) {
          // Legacy input-staging convention: only the runner's entries count.
          for (const runnerEntry of RUNNER_PRODUCT_ENTRIES) {
            const runnerRel = path.posix.join('computation', runnerEntry);
            if (!fs.existsSync(path.join(runDir, runnerRel))) continue;
            residue.push(runnerRel);
            if (!tracked.has(runnerRel) && !hasPrefixIn(tracked, runnerRel)) movable.push(runnerRel);
          }
          continue;
        }
        if (hasPrefixIn(inputs, childRel) || hasPrefixIn(tracked, childRel)) {
          classify(childRel);
          continue;
        }
        residue.push(childRel);
        movable.push(childRel);
      } else {
        residue.push(childRel);
        if (!tracked.has(childRel)) movable.push(childRel);
      }
    }
  };
  classify('');
  return { workspaces, residue, movable, truncated: discovery.truncated };
}

/** The terminal result artifact a COMPLETED front-door run writes. The
 *  status file is runner-owned but mutable on disk; the terminal artifact
 *  is a second, independent completion witness — a retry that trusted the
 *  status file alone could be laundered by hand-editing one JSON field. */
export type TerminalResultWitness = 'completed' | 'absent' | 'unreadable' | 'other';

export function readTerminalResultWitness(runDir: string): TerminalResultWitness {
  const artifactPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  // Existence is judged by the ENTRY (lstat), not by what it resolves to:
  // existsSync follows symlinks, so a dangling symlink planted where the
  // artifact lived would read as 'absent' — reopening exactly the
  // laundering path the witness closes. An entry that exists but cannot
  // be read (dangling link, permission, truncation) is 'unreadable'.
  try {
    fs.lstatSync(artifactPath);
  } catch {
    return 'absent';
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as {
      execution_status?: string;
      status?: string;
      ok?: boolean;
    };
    // The canonical artifact (computation/result.ts) records
    // `execution_status`; the extra spellings keep hand-written or older
    // artifacts conservative.
    if (parsed.execution_status === 'completed' || parsed.status === 'completed' || parsed.ok === true) {
      return 'completed';
    }
    return 'other';
  } catch {
    // An UNREADABLE witness is fail-closed at every consumer: a truncated
    // or corrupted artifact plus a removed status file must never read as
    // "nothing completed here" — that is precisely the laundering shape
    // the witness exists to block.
    return 'unreadable';
  }
}

/** The runner's own write entries under a workspace directory. */
const RUNNER_PRODUCT_ENTRIES = ['execution_status.json', 'logs', 'outputs', 'workspace'];

/** Recursively merge-move the contents of `fromDir` into `toDir`,
 *  preserving relative structure. A child whose destination already exists
 *  as a non-directory (or whose rename fails) is left in place — visible,
 *  never lost, never overwritten. Returns the number of renames performed. */
function moveTreeMerge(fromDir: string, toDir: string): number {
  let moved = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fromDir, { withFileTypes: true });
  } catch {
    return moved;
  }
  for (const entry of entries) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (fs.existsSync(to)) {
      if (entry.isDirectory() && fs.statSync(to).isDirectory()) {
        moved += moveTreeMerge(from, to);
      }
      // Non-directory collision: leave staged, visible.
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved += 1;
    } catch {
      // leave in place; visible, never lost
    }
  }
  try {
    fs.rmdirSync(fromDir);
  } catch {
    // non-empty leftovers stay visible
  }
  return moved;
}

/** Quarantine the failed attempt's PRODUCTS (the shared enumeration's
 *  movable set — runner write surface, declared outputs, terminal
 *  artifacts/, checkpoints, undeclared writes; git-tracked files and
 *  manifest-credited inputs stay) into a PRIVATE staging directory first;
 *  only the appended winner promotes it to the canonical
 *  attempts/attempt-<N>/ name. Two concurrent retries therefore never
 *  share an archive: each stages its own moves, the race loser restores
 *  from ITS OWN staging only, and the winner's products are untouchable by
 *  the loser's rollback. Structure inside staging mirrors the run-relative
 *  layout, so promote and restore are the same generic merge-move. */
function quarantineFailedAttempt(
  runDir: string,
  eventId: string,
  closedOrdinal: number,
  movable: string[],
): { staging: string | null; moved: number; failed: string[] } {
  // The staging name carries the ordinal the products BELONG to, so a
  // later recovery can decide their rightful place (the ordinal's
  // canonical archive if someone else closed it, the live surface if the
  // chain never moved) instead of blindly restoring attempt N's bytes
  // onto a surface already bound to attempt N+1.
  const stagingRel = path.join('attempts', `.staging-${eventId}-o${closedOrdinal}`);
  const stagingAbs = path.join(runDir, stagingRel);
  let moved = 0;
  const failed: string[] = [];
  for (const rel of movable) {
    const from = path.join(runDir, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(stagingAbs, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved += 1;
    } catch {
      // A product that CANNOT move is a product that would stay live under
      // the next attempt's binding — the caller must refuse, not proceed.
      failed.push(rel);
    }
  }
  if (moved === 0) {
    // Nothing of ours is inside; the mkdir skeleton left by failed renames
    // must not survive — an empty .staging-* would lock every later retry
    // behind the in-flight refusal while promising a self-heal that has
    // nothing to heal.
    try {
      fs.rmSync(stagingAbs, { recursive: true, force: true });
    } catch {
      // visible leftover; recovery parks it
    }
  }
  return { staging: moved > 0 ? stagingRel : null, moved, failed };
}

/** Move whatever remains of a staging directory to the visible
 *  attempts/unattributed-* parking name. Nothing may survive under the
 *  retry-blocking .staging-* name once its invocation is over. */
function parkStagingRemainder(runDir: string, stagingRel: string, eventId: string): void {
  const from = path.join(runDir, stagingRel);
  if (!fs.existsSync(from)) return;
  const dest = path.join(runDir, 'attempts', `unattributed-${eventId}`);
  try {
    if (!fs.existsSync(dest)) fs.renameSync(from, dest);
    else moveTreeMerge(from, dest);
  } catch {
    // deepest fallback: stays visible under the staging name
  }
}

/** Promote this invocation's staging to the canonical archive name. If the
 *  canonical name already exists (a prior attempt archived there — one
 *  canonical dir per ordinal), merge by moving staging entries under it. */
function promoteQuarantine(runDir: string, stagingRel: string, closedOrdinal: number): string {
  const destRel = path.join('attempts', `attempt-${closedOrdinal}`);
  const destAbs = path.join(runDir, destRel);
  const stagingAbs = path.join(runDir, stagingRel);
  if (!fs.existsSync(destAbs)) {
    fs.renameSync(stagingAbs, destAbs);
    return destRel;
  }
  moveTreeMerge(stagingAbs, destAbs);
  return destRel;
}

function restoreQuarantine(runDir: string, stagingRel: string): void {
  // Rollback for the lost race — restores ONLY this invocation's staged
  // moves; the winner's archive is a different directory by construction.
  // Staging mirrors run-relative structure, so restoring is merging the
  // staging tree back onto the run root.
  const stagingAbs = path.join(runDir, stagingRel);
  if (!fs.existsSync(stagingAbs)) return;
  moveTreeMerge(stagingAbs, runDir);
}

/** How long a staging directory may sit before a later retry treats it as
 *  the debris of a CRASHED invocation (rather than a concurrent one still
 *  in flight) and recovers it. In-flight retries hold staging for seconds. */
const STALE_STAGING_MS = 10 * 60_000;

/** Parse a staging directory name: `.staging-<eventId>-o<ordinal>` (the
 *  ordinal the staged products belong to), tolerating the earlier
 *  ordinal-less form. Null for anything else. */
function parseStagingName(name: string): { eventId: string; ordinal: number | null } | null {
  if (!name.startsWith('.staging-')) return null;
  const rest = name.slice('.staging-'.length);
  const match = /^([0-9A-HJKMNP-TV-Z]{26})(?:-o([1-9]\d*))?$/.exec(rest);
  if (!match) return null;
  if (!ULID_PATTERN.test(match[1]!)) return null;
  return { eventId: match[1]!, ordinal: match[2] ? Number(match[2]) : null };
}

/** Staging directories whose event id the ledger does NOT know: either a
 *  retry in flight right now or one that crashed inside the recovery
 *  window. Their contents are part of the surface being judged, so while
 *  one exists no honest evidence reading is possible. */
function listUnrecordedStagings(runDir: string, view: ValidityLedgerView): string[] {
  const attemptsDir = path.join(runDir, 'attempts');
  let entries: string[];
  try {
    entries = fs.readdirSync(attemptsDir);
  } catch {
    return [];
  }
  const unrecorded: string[] = [];
  for (const name of entries) {
    const parsed = parseStagingName(name);
    if (!parsed) continue;
    if (!view.events.some(event => event.event_id === parsed.eventId)) unrecorded.push(name);
  }
  return unrecorded;
}

/** Crash recovery for the two windows a prior retry can die in:
 *  - staged but never appended (event id absent from the ledger) → the
 *    products belong back on the live surface;
 *  - appended but never promoted (closure recorded, archive still under
 *    the private staging name) → finish the promotion.
 *  Age-gated so a CONCURRENT retry's live staging is never touched. */
function recoverOrphanStagings(runDir: string, view: ValidityLedgerView, runId: string): void {
  const attemptsDir = path.join(runDir, 'attempts');
  let entries: string[];
  try {
    entries = fs.readdirSync(attemptsDir);
  } catch {
    return;
  }
  const entry = view.runs.get(runId);
  const closureOrdinals = new Set((entry?.attempts.closures ?? []).map(closure => closure.ordinal));
  // Whatever a recovery pass could not place (a file-vs-file collision
  // with the recreated live surface, a permission failure) must not stay
  // under the .staging-* name — that name blocks every future retry with
  // a promise of self-healing it can no longer keep; parkStagingRemainder
  // moves it to the visible attempts/unattributed-* name.
  for (const name of entries) {
    const parsed = parseStagingName(name);
    if (!parsed) continue;
    const rel = path.join('attempts', name);
    try {
      if (Date.now() - fs.statSync(path.join(runDir, rel)).mtimeMs < STALE_STAGING_MS) continue;
    } catch {
      continue;
    }
    const recorded = view.events.find(event => event.event_id === parsed.eventId);
    if (recorded) {
      // Appended but never promoted: finish the promotion under the
      // ordinal the EVENT says it closed.
      if (recorded.event === 'attempt' && recorded.run_id === runId) {
        const closes = (recorded as { attempt?: { closes_ordinal?: number } }).attempt?.closes_ordinal;
        if (typeof closes === 'number') {
          try {
            promoteQuarantine(runDir, rel, closes);
          } catch {
            // parked below
          }
          parkStagingRemainder(runDir, rel, parsed.eventId);
        }
      }
      continue;
    }
    // Unrecorded: the append never landed. The products belong to the
    // ordinal the staging name carries — where they go depends on what the
    // chain did since:
    //  - that ordinal is CLOSED now (a sibling won) → they are that closed
    //    attempt's residue; promote into its canonical archive. Restoring
    //    them live would hand attempt N's bytes to attempt N+1's binding.
    //  - the chain never moved (head still that ordinal, unclosed) → the
    //    live surface is still theirs; restore for honest re-evidence.
    //  - anything else (legacy nameless ordinal on an advanced chain,
    //    inconsistent state) → park visibly under attempts/unattributed-*,
    //    never guessed onto the live surface.
    const ordinal = parsed.ordinal;
    if (ordinal !== null && closureOrdinals.has(ordinal)) {
      try {
        promoteQuarantine(runDir, rel, ordinal);
      } catch {
        // parked below
      }
    } else if (
      (ordinal !== null && entry?.attempts.latest_ordinal === ordinal)
      || (ordinal === null && (entry?.attempts.latest_ordinal ?? 1) === 1 && closureOrdinals.size === 0)
    ) {
      restoreQuarantine(runDir, rel);
    }
    // Whether promoted, restored, or unattributable: nothing may remain
    // under the blocking .staging-* name after a recovery pass.
    parkStagingRemainder(runDir, rel, parsed.eventId);
  }
}

export function openRetryAttempt(
  projectRoot: string,
  target: string,
  options: {
    actor?: string;
    reason?: string;
    recordOnly?: boolean;
    eventId?: string;
    deps?: Record<string, string>;
  } = {},
): OpenRetryResult {
  const contained = resolveContainedRunDirectory(projectRoot, target, 'trace retry', 'retry');
  if (contained.kind === 'rejected') return contained;
  const { runDir, runId } = contained;
  // Normalize BEFORE any side effect: the ledger schema requires a
  // non-empty actor and reason, and discovering that only at append time
  // would leave a quarantine and a pinned capture behind a validation
  // throw. Whitespace-only reasons are treated as absent.
  const actor = options.actor?.trim() || defaultStampActor();
  const declaredReason = options.reason?.trim() || undefined;

  if (options.eventId && !ULID_PATTERN.test(options.eventId)) {
    return { kind: 'rejected', message: `trace retry: --event-id ${JSON.stringify(options.eventId)} is not a ULID` };
  }
  const view = readValidityLedger(projectRoot);
  if (options.eventId) {
    if (view.integrity_defects.some(defect => defect.event_id === options.eventId)) {
      return {
        kind: 'rejected',
        message: `trace retry: event ${options.eventId} is a ledger-integrity defect (divergent payloads); `
          + 'repair the ledger and mint a fresh event id',
      };
    }
    const existing = view.events.find(event => event.event_id === options.eventId);
    if (existing) {
      if (existing.event !== 'attempt' || existing.run_id !== runId) {
        return {
          kind: 'rejected',
          message: `trace retry: event ${options.eventId} is already recorded as a ${existing.event} `
            + `for ${existing.run_id}; it cannot identify a retry of ${runId}`,
        };
      }
      return { kind: 'already_recorded', runId, eventId: options.eventId };
    }
  }

  const entry = view.runs.get(runId);
  if (!entry || !entry.stamped || entry.attempts.latest_ordinal < 1) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId} carries no origin binding — stamp the first attempt with \`nullius trace stamp\`, `
        + 'then retry only after a resultless crash',
    };
  }
  if (entry.validity !== 'active') {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId} is ${entry.validity} — a DECIDED run is content territory; `
        + 'reinstate first if the decision was wrong, or open a fresh run id',
    };
  }
  if (entry.conflicting_stamps || entry.attempts.conflicting_attempts || entry.no_authoritative_identity
    || entry.attempts.chain_defect) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId} has ledger integrity or attempt-chain defects; repair the record first — `
        + 'a retry must chain from an unambiguous binding',
    };
  }
  const bindingQuality = (entry.origin as { binding_quality?: string } | null)?.binding_quality ?? null;
  if (bindingQuality === 'aligned_heuristic' || bindingQuality === 'unbound') {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId}'s binding is ${bindingQuality} — no exact identity to chain from; `
        + 'legacy-aligned runs take fresh run ids',
    };
  }
  const registry = validateResultRegistry(projectRoot, view);
  if (registry.rows.some(row => row.run_id === runId)) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId} is named by the results registry — a consumed result never takes the `
        + 'cheap path; supersede or void it (full ceremony) and open a fresh run id',
    };
  }
  // Heal the debris of prior CRASHED retries first, so the boundary below
  // judges the true surface (a stranded archive would otherwise hide the
  // very residue — or terminal artifact — the checks exist to see).
  recoverOrphanStagings(runDir, view, runId);
  // Anything still staged and unrecorded after recovery is FRESH — a
  // sibling retry in flight or one that crashed moments ago. Its staging
  // holds products this boundary is about to judge (an emptied surface
  // would misread as `missing`), so the entrance waits rather than reads.
  const unrecordedStagings = listUnrecordedStagings(runDir, view);
  if (unrecordedStagings.length > 0) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId} has ${unrecordedStagings.length} in-flight or freshly crashed retry `
        + `staging director${unrecordedStagings.length === 1 ? 'y' : 'ies'} under attempts/ `
        + `(${unrecordedStagings.join(', ')}) — evidence is unreadable while products sit in staging; `
        + 'retry again shortly (stale stagings recover automatically after ~10 minutes)',
    };
  }
  const terminalWitness = readTerminalResultWitness(runDir);
  if (terminalWitness === 'completed') {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId}'s terminal result artifact records a COMPLETED execution — a hand-edited `
        + 'status file cannot relabel it a crash; "completed but wrong" is content territory: supersede or void '
        + 'it (full ceremony) and open a fresh run id',
    };
  }
  if (terminalWitness === 'unreadable') {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId}'s terminal result artifact (artifacts/computation_result_v1.json) is `
        + 'unreadable — the boundary cannot certify the prior execution did not complete; repair or remove the '
        + 'artifact (recording why) before retrying',
    };
  }
  const closedOrdinal = entry.attempts.latest_ordinal;
  if (entry.attempts.closures.some(closure => closure.ordinal === closedOrdinal)) {
    return {
      kind: 'rejected',
      message: `trace retry: attempt ${closedOrdinal} of ${runId} is already closed`
        + `${options.recordOnly ? '' : ' — a new attempt was not opened; retry again from the current state'}`,
    };
  }

  // Evidence: machine where the machine can see, declared (and visibly
  // second-class) where it cannot. "Completed" is content territory. The
  // status file lives wherever the manifest put the workspace — discovery,
  // not a hardcoded computation/ path, decides what the machine can see.
  const products = enumerateAttemptProducts(projectRoot, runDir);
  if (products.truncated) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId}'s directory is too large to enumerate (workspace discovery truncated at its `
        + 'safety bound) — the boundary cannot certify what the surface holds; relocate bulk subdirectories '
        + '(tool caches and dot-directories inside the run dir count too) and retry',
    };
  }
  const statusWorkspaces = products.workspaces.filter(workspace => workspace.statusPath !== null);
  if (statusWorkspaces.length > 1) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId} carries ${statusWorkspaces.length} execution status files `
        + `(${statusWorkspaces.map(workspace => workspace.workspaceRel || '.').join(', ')}) — ambiguous evidence; `
        + 'remove or archive the stale workspace before retrying',
    };
  }
  const statusPath = statusWorkspaces[0]?.statusPath ?? null;
  let outcome: 'failed' | 'missing' | 'stalled' | 'declared_no_result';
  const evidence: RetryEvidence = { method: 'declared', detail: '' };
  if (statusPath !== null) {
    let statusRaw: string;
    let status: { status?: string; errors?: string[] } = {};
    try {
      statusRaw = fs.readFileSync(statusPath, 'utf-8');
      status = JSON.parse(statusRaw) as { status?: string; errors?: string[] };
    } catch {
      return { kind: 'rejected', message: `trace retry: ${runId}'s execution status file is unreadable; repair or remove it first` };
    }
    if (status.status === 'completed') {
      return {
        kind: 'rejected',
        message: `trace retry: ${runId} recorded a COMPLETED execution — "completed but wrong" is content `
          + 'territory: supersede or void it (full ceremony) and open a fresh run id',
      };
    }
    if (status.status === 'failed') {
      outcome = 'failed';
      evidence.method = 'execution_status';
      evidence.detail = ((status.errors ?? [])[0] ?? '').trim() || 'execution status records failure';
      evidence.execution_status_sha256 = createHash('sha256').update(statusRaw!, 'utf-8').digest('hex');
    } else if (status.status === 'running') {
      if (!declaredReason) {
        return {
          kind: 'rejected',
          message: `trace retry: ${runId}'s execution status still says running — declaring it stalled requires `
            + '--reason (the declaration is recorded as such)',
        };
      }
      outcome = 'stalled';
      evidence.method = 'declared';
      evidence.detail = declaredReason;
      evidence.execution_status_sha256 = createHash('sha256').update(statusRaw!, 'utf-8').digest('hex');
    } else {
      return { kind: 'rejected', message: `trace retry: ${runId}'s execution status is unrecognized (${String(status.status)})` };
    }
  } else {
    if (products.residue.length === 0) {
      // Nothing was ever produced — the stamp-predates-source class heals
      // as an honest chain advance; never counts against attempt budgets.
      outcome = 'missing';
      evidence.method = 'outputs_scan';
      evidence.detail = 'product surface empty: no execution products ever materialized';
    } else {
      if (!declaredReason) {
        return {
          kind: 'rejected',
          message: `trace retry: ${runId} has ${products.residue.length} product path(s) on its surface and no execution status — `
            + 'retrying a hand run requires --reason declaring the execution produced no retained result '
            + '(recorded as a declaration, visibly second-class)',
        };
      }
      outcome = 'declared_no_result';
      evidence.method = 'declared';
      evidence.detail = declaredReason;
    }
  }
  // The zero-ceremony self-heal is for the OCCASIONAL early crash. A run
  // id that keeps advancing its chain without ever producing a byte is
  // churning — after a handful of heals the honest move is a fresh id.
  if (outcome === 'missing') {
    const missingHeals = entry.attempts.closures.filter(closure => closure.previous_outcome === 'missing').length;
    if (missingHeals >= 5) {
      return {
        kind: 'rejected',
        message: `trace retry: ${runId} already carries ${missingHeals} missing-source self-heals — this id is `
          + 'churning without ever executing; open a fresh run id (the zero-ceremony heal is for the occasional '
          + 'early crash, not a loop)',
      };
    }
  }
  // Manifest-declared crash budget: total executions allowed, counting the
  // initial attempt and every CRASH retry (missing self-heals excluded).
  // Exhaustion restores the full ceremony; record-only closures stay
  // available so an abandoned run is still cheap to book. The budget reads
  // from the evidence workspace's manifest (or the single manifest when no
  // status file exists).
  if (outcome !== 'missing' && !options.recordOnly) {
    const manifestWorkspaces = products.workspaces.filter(workspace => workspace.manifestPath !== null);
    const budgetManifestPath = statusWorkspaces[0]?.manifestPath
      ?? (manifestWorkspaces.length === 1 ? manifestWorkspaces[0]!.manifestPath : null);
    let maxAttempts: number | null = null;
    try {
      if (budgetManifestPath !== null) {
        const parsed = JSON.parse(fs.readFileSync(budgetManifestPath, 'utf-8')) as { max_attempts?: number };
        if (typeof parsed.max_attempts === 'number' && parsed.max_attempts >= 1) maxAttempts = parsed.max_attempts;
      }
    } catch {
      // an unreadable manifest never decides the boundary; the schema gate owns manifest validity
    }
    if (maxAttempts !== null && entry.attempts.crash_retry_count + 1 >= maxAttempts) {
      return {
        kind: 'rejected',
        message: `trace retry: ${runId} has exhausted its ${maxAttempts}-attempt crash budget — the full `
          + 'supersede/void ceremony with a fresh run id is the remaining path (a --record-only closure '
          + 'stays available for honest bookkeeping)',
      };
    }
  }

  // Skew-immune predecessor, resolved BEFORE any side effect: the event
  // that OPENED the ordinal being closed — the initial stamp for ordinal 1,
  // else the attempt event whose embedded origin bound this ordinal.
  const supersedesEvent = closedOrdinal === 1
    ? view.events.find(event => event.event === 'stamp' && event.run_id === runId)?.event_id ?? null
    : view.events.find(event => event.event === 'attempt' && event.run_id === runId
      && ((event as { attempt?: { origin?: { attempt_ordinal?: number } | null } }).attempt?.origin?.attempt_ordinal
        === closedOrdinal))?.event_id ?? null;
  if (supersedesEvent === null) {
    return {
      kind: 'rejected',
      message: `trace retry: cannot identify the event that opened attempt ${closedOrdinal} of ${runId}; `
        + 'the chain is unreadable — repair the ledger before retrying',
    };
  }

  // Bracket the evidence window: every reading above (product enumeration,
  // status parse) is trusted ONLY if no sibling retry was mid-quarantine
  // while we read. A sibling creates its staging directory before its
  // first move, so any move that emptied the surface under us left its
  // staging visible here — refusing now is what makes an empty-residue
  // conclusion honest rather than a misread of a freshly emptied surface.
  if (listUnrecordedStagings(runDir, view).length > 0) {
    return {
      kind: 'attempt_conflict',
      runId,
      message: `trace retry: a concurrent retry of ${runId} began quarantining while this one read the surface; `
        + 're-read and retry from the new state',
    };
  }

  const eventId = options.eventId ?? mintUlid();
  // Stage the archive under this invocation's own name; the canonical
  // attempts/attempt-N destination is claimed only AFTER the append wins.
  let staging: string | null = null;
  let quarantinedTo: string | null = null;
  if (!options.recordOnly) {
    const quarantine = quarantineFailedAttempt(runDir, eventId, closedOrdinal, products.movable);
    staging = quarantine.staging;
    if (quarantine.failed.length > 0) {
      // A product left live would ride into the next attempt's binding —
      // refuse admission entirely, put back what did move, and leave
      // NOTHING under the .staging-* name (a leftover would lock the very
      // "fix and retry" this message advises behind the in-flight refusal).
      if (staging) {
        restoreQuarantine(runDir, staging);
        parkStagingRemainder(runDir, staging, eventId);
      }
      return {
        kind: 'rejected',
        message: `trace retry: cannot quarantine ${quarantine.failed.length} product path(s) of ${runId} `
          + `(${quarantine.failed.slice(0, 3).join(', ')}${quarantine.failed.length > 3 ? ', …' : ''}) — `
          + 'a product left on the live surface would ride into the next attempt\'s binding; '
          + 'fix permissions (or archive it by hand) and retry',
      };
    }
    if (quarantine.moved > 0) {
      evidence.quarantined_paths_count = quarantine.moved;
      quarantinedTo = path.join('attempts', `attempt-${closedOrdinal}`);
    }
  }
  // Where OUR staged products go if this invocation does not win the
  // append: they belong to `closedOrdinal`, so if someone else closed that
  // ordinal meanwhile they go to its canonical archive (restoring them
  // live would hand attempt N's bytes to attempt N+1's binding); if the
  // chain never moved, the live surface is still theirs.
  const rollbackStaging = (): void => {
    if (!staging) return;
    try {
      const fresh = readValidityLedger(projectRoot).runs.get(runId);
      const closedNow = fresh?.attempts.closures.some(closure => closure.ordinal === closedOrdinal) ?? false;
      if (closedNow) promoteQuarantine(runDir, staging, closedOrdinal);
      else restoreQuarantine(runDir, staging);
    } catch {
      // Leave staged; the age-gated recovery attributes it by its
      // ordinal-carrying name.
    }
  };

  let origin: RunOriginV1 | null = null;
  let mirrorWritten = true;
  const mirrorPath = path.join(runDir, 'run_origin.json');
  const previousMirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
  let writtenMirrorBytes: string | null = null;
  let reclaimedSha: string | null = null;
  if (!options.recordOnly) {
    // A pin already sitting on the NEXT ordinal is normally the debris of
    // a retry that crashed between pinning and appending. But "no ledger
    // event references it" was proven by a view that has aged — a sibling
    // may have pinned AND appended since. Re-read immediately before
    // reclaiming: if the chain moved, this invocation lost and must not
    // touch the ref (stealing a committed pin would leave the authoritative
    // binding's snapshot unprotected).
    const observedPin = readAttemptSnapshotRef(projectRoot, runId, closedOrdinal + 1);
    if (observedPin !== null) {
      const fresh = readValidityLedger(projectRoot).runs.get(runId);
      const chainMoved = (fresh?.attempts.latest_ordinal ?? closedOrdinal) !== closedOrdinal
        || (fresh?.attempts.closures.some(closure => closure.ordinal === closedOrdinal) ?? false);
      if (chainMoved) {
        rollbackStaging();
        return {
          kind: 'attempt_conflict',
          runId,
          message: `trace retry: a concurrent retry advanced ${runId}'s attempt chain first; re-read and retry from the new state`,
        };
      }
    }
    try {
      origin = captureRunOrigin(projectRoot, runId, {
        deps: options.deps ?? {},
        eventId,
        attemptOrdinal: closedOrdinal + 1,
        attemptPinReclaimSha: observedPin,
      });
      const pinned = (origin as unknown as { snapshot_commit?: string }).snapshot_commit;
      if (observedPin !== null && typeof pinned === 'string' && pinned !== observedPin) {
        reclaimedSha = observedPin;
      }
    } catch (error) {
      // The capture failed AFTER products moved into staging; put them
      // back — a throw must not strand the live surface in the archive.
      rollbackStaging();
      throw error;
    }
    try {
      writtenMirrorBytes = `${JSON.stringify(origin, null, 2)}\n`;
      writeBytesAtomicDurable(mirrorPath, writtenMirrorBytes);
    } catch {
      mirrorWritten = false;
      // Same commit-uncertain restore as the stamp path: the atomic helper
      // renames before its final durability step, so the destination may
      // already hold the new bytes.
      try {
        if (previousMirror !== null) writeBytesAtomicDurable(mirrorPath, previousMirror);
        else fs.rmSync(mirrorPath, { force: true });
      } catch {
        // Restore is best-effort; the divergence scan surfaces leftovers.
      }
    }
  }
  // The mirror outcome is recorded IN the authoritative event, exactly as
  // the initial stamp records it — a read-only run directory is a
  // legitimate, visible state, not a silent divergence.
  const originPayload = origin === null ? null : {
    ...(origin as unknown as Record<string, unknown>),
    ...(mirrorWritten ? {} : { run_dir_unwritable: true }),
  };
  const event = buildValidityEvent({
    event: 'attempt',
    run_id: runId,
    actor,
    reason: declaredReason ?? evidence.detail,
    attempt: {
      closes_ordinal: closedOrdinal,
      previous_outcome: outcome,
      evidence,
      quarantined_to: quarantinedTo,
      supersedes_attempt_event: supersedesEvent,
      origin: originPayload as ValidityEventV1['stamp'] | null,
    },
    event_id: eventId,
    ...(origin ? { ts_utc: (origin as unknown as { captured_at_utc: string }).captured_at_utc } : {}),
  } as Omit<ValidityEventV1, 'schema_id' | 'event_id' | 'ts_utc'> & { event_id?: string; ts_utc?: string });

  // Rollback discipline shared with the stamp path: undo only what THIS
  // invocation wrote — a concurrent winner's mirror is left alone, and a
  // mirror WE created (no predecessor) is removed, not orphaned.
  const rollbackMirror = (): void => {
    if (options.recordOnly || !mirrorWritten || writtenMirrorBytes === null) return;
    try {
      const current = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
      const action = mirrorRollbackAction(current, writtenMirrorBytes, previousMirror);
      if (action === 'restore_previous') writeBytesAtomicDurable(mirrorPath, previousMirror!);
      else if (action === 'remove') fs.rmSync(mirrorPath, { force: true });
    } catch {
      // A failing restore must not mask the primary outcome; the
      // divergence scan surfaces the leftover mirror on the next read.
    }
  };

  // If this invocation reclaimed an observed pin and then LOST, the sha it
  // displaced may be the one a winning sibling's event references — swap
  // it back so the authoritative binding's snapshot stays GC-protected.
  const rollbackReclaimedPin = (): void => {
    if (reclaimedSha === null || origin === null) return;
    const ours = (origin as unknown as { snapshot_commit?: string }).snapshot_commit;
    if (typeof ours !== 'string') return;
    swapAttemptSnapshotRef(projectRoot, runId, closedOrdinal + 1, ours, reclaimedSha);
  };

  let appendOutcome;
  try {
    appendOutcome = appendValidityEvent(projectRoot, event, { onlyIfAttemptChainHead: true });
  } catch (error) {
    rollbackStaging();
    rollbackMirror();
    rollbackReclaimedPin();
    throw error;
  }
  if (appendOutcome === 'skipped_attempt_not_chain_head') {
    rollbackStaging();
    rollbackMirror();
    rollbackReclaimedPin();
    return {
      kind: 'attempt_conflict',
      runId,
      message: `trace retry: a concurrent retry advanced ${runId}'s attempt chain first; re-read and retry from the new state`,
    };
  }
  // The append is the record; promote this invocation's staging to the
  // canonical archive name (merge-tolerant, never deletes).
  if (staging) {
    try {
      promoteQuarantine(runDir, staging, closedOrdinal);
    } catch {
      // staged files stay visible under attempts/.staging-<event>; the
      // event's quarantined_to names the canonical intent
    }
  }

  return {
    kind: 'retried',
    runId,
    eventId: event.event_id,
    closedOrdinal,
    openedOrdinal: options.recordOnly ? null : closedOrdinal + 1,
    previousOutcome: outcome,
    evidence,
    quarantinedTo,
    origin,
    mirrorWritten,
  };
}
