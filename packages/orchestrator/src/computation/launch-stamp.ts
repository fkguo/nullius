import { execFileSync } from 'node:child_process';
import { captureRunOrigin, isTraceabilityArtifactPath } from '../run-origin.js';
import { defaultStampActor, stampRunDirectory } from '../run-stamp.js';
import { readValidityLedger } from '../validity-ledger.js';
import type { ExecutionOriginStampOutcome } from './types.js';

/** Automatic origin stamp at the computation front door.
 *
 *  The stamp happens at LAUNCH — after approval clears, before the first
 *  step runs — because that is the moment the tree state and the results
 *  are the same fact. Measured adoption showed the alternative: hundreds of
 *  runs whose origin had to be reconstructed heuristically because stamping
 *  relied on an agent remembering a second command. The front door is a
 *  mandatory machine moment, so the binding happens here by construction.
 *
 *  Outcome semantics (never blocks execution — a computation must not die
 *  for a bookkeeping failure; a missing stamp is an honest, visible state
 *  in the read model, while a killed run is lost science):
 *  - `stamped`: origin recorded on the ledger, exact-at-launch.
 *  - `already_stamped`: a stamp for this run already binds the SAME tracked
 *    code tree (a same-tree relaunch); no duplicate ledger event is written,
 *    because a byte-different payload for one run is the reader's
 *    conflicting-stamps defect — noise, not information, for a no-op rerun.
 *  - `stale_stamp`: a stamp exists but binds a DIFFERENT tracked tree: this
 *    rerun is about to overwrite results that the recorded stamp no longer
 *    describes. Deliberately NOT auto-restamped — the snapshot ref is
 *    create-if-absent by contract (a run id never silently rebinds), and the
 *    honest fix is a fresh run id (the round-suffix convention), so the
 *    detail says exactly that. The signal is in the execution result, where
 *    the launching agent reads it at the moment it can still act.
 *  - `skipped`: the run directory is outside the stampable run roots; the
 *    reason names the roots so the caller can relocate the run.
 *  - `failed`: capture or ledger append threw; the error is carried, the
 *    computation proceeds, and the run surfaces as unstamped in the read
 *    model until stamped by hand. */
export type ExecutionOriginStamp = ExecutionOriginStampOutcome;

/** The commit whose TREE is the code a stamp describes: snapshot when
 *  tracked files were dirty, else the baseline. Null for aligned/unbound
 *  stamps (no exact identity to compare against). */
function stampedCodeCommit(origin: unknown): string | null {
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
 *  bookkeeping — i.e. the RESEARCH code is the same tree. */
function sameResearchCode(projectRoot: string, commitA: string, commitB: string): boolean {
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

export function stampComputationLaunch(projectRoot: string, runDir: string): ExecutionOriginStamp {
  try {
    const runId = runDir.split(/[\\/]/).filter(Boolean).pop() ?? runDir;
    const ledger = readValidityLedger(projectRoot);
    const known = ledger.runs.get(runId);
    if (known?.stamped && known.origin) {
      // A stamp already exists: compare tracked RESEARCH-code identity
      // before deciding anything. Untracked drift between launches (outputs
      // landing on disk) and control-plane bookkeeping churn do not change
      // what code produces the results and must not manufacture ledger
      // noise; a changed research tree must.
      const probe = captureRunOrigin(projectRoot, runId, { pin: false });
      const knownCommit = stampedCodeCommit(known.origin);
      const probeCommit = stampedCodeCommit(probe);
      const same = knownCommit === null || probeCommit === null
        ? knownCommit === probeCommit
        : sameResearchCode(projectRoot, knownCommit, probeCommit);
      if (same) {
        const quality = (known.origin as unknown as Record<string, unknown>).binding_quality;
        return {
          status: 'already_stamped',
          binding_quality: typeof quality === 'string' ? quality : 'unknown',
          detail: 'an origin stamp for this run already binds the same tracked code tree; not re-stamped',
        };
      }
      return {
        status: 'stale_stamp',
        detail: 'this run already carries an origin stamp bound to a DIFFERENT tracked code tree; '
          + 'this launch will overwrite results the recorded stamp no longer describes. '
          + 'Use a fresh run id for the changed code (round-suffix convention) so each result keeps an exact origin.',
      };
    }
    const result = stampRunDirectory(projectRoot, runDir, { actor: defaultStampActor() });
    if (result.kind === 'rejected') {
      return { status: 'skipped', reason: result.message };
    }
    if (result.kind === 'already_recorded') {
      // Unreachable without an eventId option, but map it honestly.
      return {
        status: 'already_stamped',
        binding_quality: 'unknown',
        detail: 'stamp event already recorded on the ledger',
      };
    }
    const origin = result.origin as unknown as Record<string, unknown>;
    return {
      status: 'stamped',
      event_id: result.eventId,
      binding_quality: String(origin.binding_quality ?? 'unknown'),
      baseline_commit: typeof origin.baseline_commit === 'string' ? origin.baseline_commit : null,
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
