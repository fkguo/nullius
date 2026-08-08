import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunOriginV1, ValidityEventV1 } from '@nullius/shared';
import { mintUlid, ULID_PATTERN, writeBytesAtomicDurable } from '@nullius/shared';
import { createHash } from 'node:crypto';
import { appendValidityEvent, buildValidityEvent, readValidityLedger } from './validity-ledger.js';
import { captureRunOrigin, isTraceabilityArtifactPath } from './run-origin.js';
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
  try {
    const manifestPath = path.join(projectRoot, ownRunPrefix, 'computation', 'manifest.json');
    if (!fs.existsSync(manifestPath)) return declared;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      steps?: Array<{ expected_outputs?: string[] }>;
    };
    for (const step of parsed.steps ?? []) {
      for (const output of step.expected_outputs ?? []) {
        if (typeof output === 'string' && output.length > 0) {
          declared.add(path.posix.join(`${ownRunPrefix}/computation`, output.split('\\').join('/')));
        }
      }
    }
  } catch {
    // Conservative: an unreadable manifest excludes nothing.
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

function isRunnerWriteSurface(insideOwnRun: string): boolean {
  return insideOwnRun === 'computation/execution_status.json'
    || insideOwnRun.startsWith('computation/logs/')
    || insideOwnRun.startsWith('computation/outputs/')
    || insideOwnRun.startsWith('computation/workspace/')
    // Prior attempts' archived residue: quarantined by the retry entrance,
    // never deleted; counting it as "unknown code delta" would demote every
    // post-retry stamp for bookkeeping the machinery itself created.
    || insideOwnRun.startsWith('attempts/')
    || insideOwnRun.startsWith('artifacts/');
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
        if (isRunnerWriteSurface(inside)) return false;
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

const RETRY_BOOKKEEPING_ALLOWLIST = new Set(['run_origin.json', 'attempts', 'manifest.json', 'computation']);

/** The PRODUCT surface a resultless crash must leave empty: top-level
 *  entries beyond bookkeeping and inputs, plus the runner write surface
 *  under computation/ (status, logs, outputs, workspace). The computation/
 *  directory itself — manifest, scripts, staged inputs — is INPUT and
 *  never counts as residue: a launch that dies before its first product
 *  must heal as `missing`, not demand a declaration for its own inputs. */
function listRunProductEntries(runDir: string): string[] {
  const products = fs.readdirSync(runDir).filter(name => !RETRY_BOOKKEEPING_ALLOWLIST.has(name));
  const computationDir = path.join(runDir, 'computation');
  if (fs.existsSync(computationDir)) {
    for (const entry of RUNNER_PRODUCT_ENTRIES) {
      if (fs.existsSync(path.join(computationDir, entry))) products.push(path.join('computation', entry));
    }
  }
  return products;
}

/** The terminal result artifact a COMPLETED front-door run writes. The
 *  status file is runner-owned but mutable on disk; the terminal artifact
 *  is a second, independent completion witness — a retry that trusted the
 *  status file alone could be laundered by hand-editing one JSON field. */
function completedResultArtifactPresent(runDir: string): boolean {
  const artifactPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  try {
    if (!fs.existsSync(artifactPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as { status?: string; ok?: boolean };
    return parsed.status === 'completed' || parsed.ok === true;
  } catch {
    // An unreadable terminal artifact is suspicious, not conclusive; the
    // status-file path still governs.
    return false;
  }
}

/** Quarantine the failed attempt's execution PRODUCTS into
 *  attempts/attempt-<N>/ (never deleted): exactly the runner write surface
 *  — status file, logs, outputs, workspace. INPUTS (the manifest, script
 *  areas) stay in place: the retry re-runs them, and archiving an input
 *  would break the relaunch it exists to enable. Hand runs without a
 *  computation/ area keep their surface in place — their retries ride on
 *  DECLARED evidence, visibly second-class (a recorded limitation, not a
 *  silent one). Returns run-relative destination or null when nothing
 *  moved. */
const RUNNER_PRODUCT_ENTRIES = ['execution_status.json', 'logs', 'outputs', 'workspace'];

/** Quarantine into a PRIVATE staging directory first; only the appended
 *  winner promotes it to the canonical attempts/attempt-<N>/ name. Two
 *  concurrent retries therefore never share an archive: each stages its own
 *  moves, the race loser restores from ITS OWN staging only, and the
 *  winner's products are untouchable by the loser's rollback. */
function quarantineFailedAttempt(
  runDir: string,
  eventId: string,
): { staging: string | null; moved: number } {
  const stagingRel = path.join('attempts', `.staging-${eventId}`);
  const stagingAbs = path.join(runDir, stagingRel);
  const computationDir = path.join(runDir, 'computation');
  if (!fs.existsSync(computationDir)) return { staging: null, moved: 0 };
  let moved = 0;
  for (const entry of RUNNER_PRODUCT_ENTRIES) {
    const from = path.join(computationDir, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(stagingAbs, 'computation', entry);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved += 1;
  }
  return moved > 0 ? { staging: stagingRel, moved } : { staging: null, moved: 0 };
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
  const stagingComputation = path.join(stagingAbs, 'computation');
  if (fs.existsSync(stagingComputation)) {
    for (const entry of fs.readdirSync(stagingComputation)) {
      const to = path.join(destAbs, 'computation', entry);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try {
        fs.renameSync(path.join(stagingComputation, entry), to);
      } catch {
        // leave in staging; visible, never lost
      }
    }
  }
  try {
    fs.rmdirSync(stagingComputation);
    fs.rmdirSync(stagingAbs);
  } catch { /* non-empty leftovers stay visible */ }
  return destRel;
}

function restoreQuarantine(runDir: string, stagingRel: string): void {
  // Rollback for the lost race — restores ONLY this invocation's staged
  // moves; the winner's archive is a different directory by construction.
  const stagingComputation = path.join(runDir, stagingRel, 'computation');
  if (!fs.existsSync(stagingComputation)) return;
  const computationDir = path.join(runDir, 'computation');
  fs.mkdirSync(computationDir, { recursive: true });
  for (const entry of fs.readdirSync(stagingComputation)) {
    try {
      fs.renameSync(path.join(stagingComputation, entry), path.join(computationDir, entry));
    } catch {
      // leave the remainder staged; visible, never lost
    }
  }
  try {
    fs.rmdirSync(stagingComputation);
    fs.rmdirSync(path.join(runDir, stagingRel));
  } catch {
    // non-empty leftovers stay visible
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
  if (completedResultArtifactPresent(runDir)) {
    return {
      kind: 'rejected',
      message: `trace retry: ${runId}'s terminal result artifact records a COMPLETED execution — a hand-edited `
        + 'status file cannot relabel it a crash; "completed but wrong" is content territory: supersede or void '
        + 'it (full ceremony) and open a fresh run id',
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
  // second-class) where it cannot. "Completed" is content territory.
  const statusPath = path.join(runDir, 'computation', 'execution_status.json');
  let outcome: 'failed' | 'missing' | 'stalled' | 'declared_no_result';
  const evidence: RetryEvidence = { method: 'declared', detail: '' };
  if (fs.existsSync(statusPath)) {
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
      evidence.detail = (status.errors ?? [])[0] ?? 'execution status records failure';
      evidence.execution_status_sha256 = createHash('sha256').update(statusRaw!, 'utf-8').digest('hex');
    } else if (status.status === 'running') {
      if (!options.reason) {
        return {
          kind: 'rejected',
          message: `trace retry: ${runId}'s execution status still says running — declaring it stalled requires `
            + '--reason (the declaration is recorded as such)',
        };
      }
      outcome = 'stalled';
      evidence.method = 'declared';
      evidence.detail = options.reason;
      evidence.execution_status_sha256 = createHash('sha256').update(statusRaw!, 'utf-8').digest('hex');
    } else {
      return { kind: 'rejected', message: `trace retry: ${runId}'s execution status is unrecognized (${String(status.status)})` };
    }
  } else {
    const surface = listRunProductEntries(runDir);
    if (surface.length === 0) {
      // Nothing was ever produced — the stamp-predates-source class heals
      // as an honest chain advance; never counts against attempt budgets.
      outcome = 'missing';
      evidence.method = 'outputs_scan';
      evidence.detail = 'product surface empty: no execution products ever materialized';
    } else {
      if (!options.reason) {
        return {
          kind: 'rejected',
          message: `trace retry: ${runId} has ${surface.length} product file(s) on its surface and no execution status — `
            + 'retrying a hand run requires --reason declaring the execution produced no retained result '
            + '(recorded as a declaration, visibly second-class)',
        };
      }
      outcome = 'declared_no_result';
      evidence.method = 'declared';
      evidence.detail = options.reason;
    }
  }
  // Manifest-declared crash budget: total executions allowed, counting the
  // initial attempt and every CRASH retry (missing self-heals excluded).
  // Exhaustion restores the full ceremony; record-only closures stay
  // available so an abandoned run is still cheap to book.
  if (outcome !== 'missing' && !options.recordOnly) {
    const manifestPath = path.join(runDir, 'computation', 'manifest.json');
    let maxAttempts: number | null = null;
    try {
      if (fs.existsSync(manifestPath)) {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { max_attempts?: number };
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

  const eventId = options.eventId ?? mintUlid();
  // Stage the archive under this invocation's own name; the canonical
  // attempts/attempt-N destination is claimed only AFTER the append wins.
  let staging: string | null = null;
  let quarantinedTo: string | null = null;
  if (!options.recordOnly) {
    const quarantine = quarantineFailedAttempt(runDir, eventId);
    staging = quarantine.staging;
    if (quarantine.moved > 0) {
      evidence.quarantined_paths_count = quarantine.moved;
      quarantinedTo = path.join('attempts', `attempt-${closedOrdinal}`);
    }
  }

  let origin: RunOriginV1 | null = null;
  let mirrorWritten = true;
  const mirrorPath = path.join(runDir, 'run_origin.json');
  const previousMirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
  if (!options.recordOnly) {
    origin = captureRunOrigin(projectRoot, runId, {
      deps: options.deps ?? {},
      eventId,
      attemptOrdinal: closedOrdinal + 1,
    });
    try {
      writeBytesAtomicDurable(mirrorPath, `${JSON.stringify(origin, null, 2)}\n`);
    } catch {
      mirrorWritten = false;
    }
  }

  // Skew-immune predecessor: the event that OPENED the ordinal being
  // closed — the initial stamp for ordinal 1, else the attempt event whose
  // embedded origin bound this ordinal.
  const supersedesEvent = closedOrdinal === 1
    ? view.events.find(event => event.event === 'stamp' && event.run_id === runId)?.event_id ?? null
    : view.events.find(event => event.event === 'attempt' && event.run_id === runId
      && ((event as { attempt?: { origin?: { attempt_ordinal?: number } | null } }).attempt?.origin?.attempt_ordinal
        === closedOrdinal))?.event_id ?? null;
  if (supersedesEvent === null) {
    if (staging) restoreQuarantine(runDir, staging);
    return {
      kind: 'rejected',
      message: `trace retry: cannot identify the event that opened attempt ${closedOrdinal} of ${runId}; `
        + 'the chain is unreadable — repair the ledger before retrying',
    };
  }
  const event = buildValidityEvent({
    event: 'attempt',
    run_id: runId,
    actor: options.actor,
    reason: options.reason ?? evidence.detail,
    attempt: {
      closes_ordinal: closedOrdinal,
      previous_outcome: outcome,
      evidence,
      quarantined_to: quarantinedTo,
      supersedes_attempt_event: supersedesEvent,
      origin: origin as ValidityEventV1['stamp'] | null,
    },
    event_id: eventId,
    ...(origin ? { ts_utc: (origin as unknown as { captured_at_utc: string }).captured_at_utc } : {}),
  } as Omit<ValidityEventV1, 'schema_id' | 'event_id' | 'ts_utc'> & { event_id?: string; ts_utc?: string });

  let appendOutcome;
  try {
    appendOutcome = appendValidityEvent(projectRoot, event, {
      onlyIfAttemptChainHead: { closesOrdinal: closedOrdinal },
    });
  } catch (error) {
    if (staging) restoreQuarantine(runDir, staging);
    if (!options.recordOnly && mirrorWritten && previousMirror !== null) {
      try { writeBytesAtomicDurable(mirrorPath, previousMirror); } catch { /* divergence scan surfaces it */ }
    }
    throw error;
  }
  if (appendOutcome === 'skipped_attempt_not_chain_head') {
    if (staging) restoreQuarantine(runDir, staging);
    if (!options.recordOnly && mirrorWritten && previousMirror !== null) {
      try { writeBytesAtomicDurable(mirrorPath, previousMirror); } catch { /* divergence scan surfaces it */ }
    }
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
