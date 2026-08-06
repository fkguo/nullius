import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mintUlid, writeBytesAtomicDurable } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import {
  appendValidityEvent,
  buildValidityEvent,
  readValidityLedger,
} from './validity-ledger.js';
import { listRunDirectories } from './traceability-view.js';

/** Retroactive origin binding for legacy runs (D8) and the round-chain
 *  supersession proposal/confirm flow (D3).
 *
 *  Backfill is a HEURISTIC and says so in every record it writes: the
 *  binding quality is `aligned_heuristic` (never anything exact-sounding),
 *  the alignment evidence (window to neighbouring commits, nominal-timestamp
 *  flag, ambiguous candidates) rides in the payload, and runs that cannot be
 *  aligned are honestly `unbound` with a named reason. Validity is NEVER
 *  backfilled automatically — round chains produce a PROPOSAL a human or
 *  agent explicitly confirms.
 *
 *  The ledger event is the truth; the run-directory mirror is best-effort
 *  (`run_dir_unwritable` on failure) so read-only legacy directories never
 *  block the record.
 */

// Both run-id shapes (D10): full `YYYYMMDDTHHMMSSZ-...` and short
// `YYYYMMDD-...`. A short id has only day precision — its alignment is
// flagged nominal (degraded confidence) just like a hand-rounded time.
const RUN_ID_TIMESTAMP = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?[-_.]/;

export function runIdEpochSeconds(runId: string): { epoch: number; nominal: boolean } | null {
  const match = RUN_ID_TIMESTAMP.exec(runId);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const hasTime = hour !== undefined;
  const iso = `${year}-${month}-${day}T${hasTime ? `${hour}:${minute}:${second}` : '00:00:00'}Z`;
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) return null;
  // Nominal = hand-rounded (midnight or zero minutes+seconds) or day-only:
  // sub-day precision cannot be trusted for alignment confidence.
  const nominal = !hasTime || (minute === '00' && second === '00');
  return { epoch: Math.floor(epochMs / 1000), nominal };
}

type CommitPoint = { epoch: number; sha: string };

function readCommitTimeline(projectRoot: string): CommitPoint[] | null {
  try {
    const output = execFileSync(
      'git',
      ['--no-optional-locks', '-C', projectRoot, 'log', '--exclude=refs/nullius/*', '--exclude=refs/stash', '--all', '--format=%H %ct'],
      { encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const points: CommitPoint[] = [];
    for (const line of output.trim().split('\n')) {
      const [sha, epochRaw] = line.split(' ');
      const epoch = Number.parseInt(epochRaw ?? '', 10);
      if (sha && /^[0-9a-f]{40}$/.test(sha) && Number.isFinite(epoch)) {
        points.push({ epoch, sha });
      }
    }
    points.sort((a, b) => a.epoch - b.epoch || (a.sha < b.sha ? -1 : 1));
    return points;
  } catch {
    return null;
  }
}

export type BackfillOutcome = {
  run_id: string;
  action: 'stamped_aligned' | 'stamped_unbound' | 'already_stamped' | 'mirror_unwritable';
  detail: string;
};

export function backfillRunOrigins(projectRoot: string): {
  outcomes: BackfillOutcome[];
  aligned: number;
  unbound: number;
  skipped: number;
} {
  const timeline = readCommitTimeline(projectRoot);
  const ledger = readValidityLedger(projectRoot);
  const outcomes: BackfillOutcome[] = [];
  let aligned = 0;
  let unbound = 0;
  let skipped = 0;
  for (const entry of listRunDirectories(projectRoot)) {
    const known = ledger.runs.get(entry.run_id);
    if (known?.stamped) {
      skipped += 1;
      outcomes.push({ run_id: entry.run_id, action: 'already_stamped', detail: 'stamp exists in the ledger' });
      continue;
    }
    const eventId = mintUlid();
    const parsed = runIdEpochSeconds(entry.run_id);
    let payload: Record<string, unknown>;
    if (!timeline || timeline.length === 0) {
      payload = {
        schema_id: 'run_origin_v1', event_id: eventId, run_id: entry.run_id,
        captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
        baseline_commit: null, dirty: { tracked_modified: 0, untracked_count: 0 },
        no_repo_reason: 'no git history to align against (no repository or no commits)',
      };
      unbound += 1;
    } else if (!parsed) {
      payload = {
        schema_id: 'run_origin_v1', event_id: eventId, run_id: entry.run_id,
        captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
        baseline_commit: null, dirty: { tracked_modified: 0, untracked_count: 0 },
        no_repo_reason: 'unparseable_run_id: no timestamp to align',
      };
      unbound += 1;
    } else {
      // Latest commit at or before the run timestamp (bisect on the sorted
      // timeline). Everything about this binding is heuristic: rebased or
      // force-pushed history can make it plausible-but-wrong, which is why
      // the quality never sounds exact and the evidence rides along.
      let low = 0;
      let high = timeline.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (timeline[mid]!.epoch <= parsed.epoch) low = mid + 1;
        else high = mid;
      }
      const index = low - 1;
      if (index < 0) {
        payload = {
          schema_id: 'run_origin_v1', event_id: eventId, run_id: entry.run_id,
          captured_at_utc: new Date().toISOString(), binding_quality: 'unbound',
          baseline_commit: null, dirty: { tracked_modified: 0, untracked_count: 0 },
          no_repo_reason: 'run predates the first commit in history',
        };
        unbound += 1;
      } else {
        const chosen = timeline[index]!;
        const next = timeline[index + 1] ?? null;
        const ambiguous = timeline
          .filter(point => point.epoch === chosen.epoch && point.sha !== chosen.sha)
          .map(point => point.sha);
        payload = {
          schema_id: 'run_origin_v1', event_id: eventId, run_id: entry.run_id,
          captured_at_utc: new Date().toISOString(), binding_quality: 'aligned_heuristic',
          baseline_commit: null,
          aligned_commit: chosen.sha,
          alignment: {
            window_prev_s: parsed.epoch - chosen.epoch,
            window_next_s: next ? next.epoch - parsed.epoch : null,
            nominal_timestamp: parsed.nominal,
            // The timeline scope is part of the heuristic's evidence: a
            // reader judging this binding must know it drew from ALL refs,
            // not the first-parent mainline.
            history_scope: 'all_refs',
            ...(ambiguous.length > 0 ? { ambiguous_candidates: ambiguous } : {}),
          },
          dirty: { tracked_modified: 0, untracked_count: 0 },
        };
        aligned += 1;
      }
    }
    // Mirror attempted first ONLY so its outcome lands inside the
    // authoritative ledger event; the ledger stays the truth. If the append
    // itself fails, the just-written mirror is REMOVED — an orphan mirror
    // with no ledger event behind it would look like a valid stamp to a
    // human browsing the run directory.
    const mirrorPath = path.join(projectRoot, entry.canonical_root, entry.run_id, 'run_origin.json');
    // A pre-existing (legacy, hand-made) mirror is preserved across failure:
    // rollback RESTORES it rather than deleting it — only a mirror this
    // invocation created from nothing is removed.
    const previousMirror = fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, 'utf-8') : null;
    let mirrorWritten = true;
    try {
      writeBytesAtomicDurable(mirrorPath, `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      mirrorWritten = false;
      payload.run_dir_unwritable = true;
    }
    try {
      appendValidityEvent(projectRoot, buildValidityEvent({
        event: 'stamp', run_id: entry.run_id, actor: 'backfill', reason: null,
        event_id: eventId,
        ts_utc: String(payload.captured_at_utc),
        stamp: payload as ValidityEventV1['stamp'],
      }));
    } catch (error) {
      if (mirrorWritten) {
        try {
          if (previousMirror !== null) writeBytesAtomicDurable(mirrorPath, previousMirror);
          else fs.rmSync(mirrorPath, { force: true });
        } catch {
          // A failing restore must not mask the append error; the
          // divergence scan surfaces the leftover mirror on the next read.
        }
      }
      throw error;
    }
    const quality = String(payload.binding_quality);
    outcomes.push({
      run_id: entry.run_id,
      action: mirrorWritten
        ? (quality === 'aligned_heuristic' ? 'stamped_aligned' : 'stamped_unbound')
        : 'mirror_unwritable',
      detail: quality === 'aligned_heuristic'
        ? `aligned to ${String((payload as { aligned_commit?: string }).aligned_commit).slice(0, 12)}${(payload.alignment as { nominal_timestamp: boolean }).nominal_timestamp ? ' (nominal timestamp — low confidence)' : ''}`
        : String(payload.no_repo_reason ?? quality),
    });
  }
  return { outcomes, aligned, unbound, skipped };
}

// Round-chain proposal: same-slug runs with increasing trailing round numbers
// are the measured review-driven redo pattern. The proposal NEVER touches the
// ledger — a human/agent reviews the file and confirms explicitly.
const CHAIN_ID = /^(?:\d{8}(?:T\d{6}Z)?)[-_.](?:m\d+-)?(?:r\d+-)?(.+?)-r(\d+)$/;

export type ChainProposal = {
  slug: string;
  supersede: Array<{ old_run_id: string; new_run_id: string }>;
};

/** True when someone already DECIDED about this run — an explicit event on
 *  it (including a reinstate that put it back to active), OR a validity that
 *  is not plain-active for any reason the event list cannot show: a
 *  quarantined ledger assigns worst-state validity from DIVERGENT event ids
 *  that are deliberately excluded from `events`, so the event check alone is
 *  NOT sufficient (that gap survived one mutation round as "dead code"
 *  before review traced the divergent path). */
function isAlreadyDecided(ledger: ReturnType<typeof readValidityLedger>, runId: string): boolean {
  const known = ledger.runs.get(runId);
  if (known && (known.validity !== 'active' || known.no_authoritative_identity)) return true;
  // Only FULL-scope events are decisions about the run's overall validity;
  // a named-scope supersession annotates without deciding (schema contract),
  // so it must not shield the run from a round-chain proposal.
  return ledger.events.some(event => event.run_id === runId
    && (event.event === 'supersede' || event.event === 'void' || event.event === 'reinstate')
    && (event.scope ?? 'full') === 'full');
}

export const CHAIN_PROPOSAL_RELATIVE_PATH = path.join('artifacts', 'runs', 'round_chain_proposal.json');

export function proposeRoundChains(projectRoot: string): { proposals: ChainProposal[]; path: string } {
  const ledger = readValidityLedger(projectRoot);
  const bySlug = new Map<string, Array<{ run_id: string; round: number }>>();
  for (const entry of listRunDirectories(projectRoot)) {
    const match = CHAIN_ID.exec(entry.run_id);
    if (!match) continue;
    const bucket = bySlug.get(match[1]!) ?? [];
    bucket.push({ run_id: entry.run_id, round: Number.parseInt(match[2]!, 10) });
    bySlug.set(match[1]!, bucket);
  }
  const proposals: ChainProposal[] = [];
  for (const [slug, runs] of bySlug) {
    if (runs.length < 2) continue;
    runs.sort((a, b) => a.round - b.round || a.run_id.localeCompare(b.run_id));
    const supersede: ChainProposal['supersede'] = [];
    for (let index = 0; index < runs.length - 1; index += 1) {
      const older = runs[index]!;
      const newer = runs[index + 1]!;
      if (older.round === newer.round) continue; // same round twice: not a chain step
      if (isAlreadyDecided(ledger, older.run_id)) continue;
      supersede.push({ old_run_id: older.run_id, new_run_id: newer.run_id });
    }
    if (supersede.length > 0) proposals.push({ slug, supersede });
  }
  proposals.sort((a, b) => a.slug.localeCompare(b.slug));
  const proposalPath = path.join(projectRoot, CHAIN_PROPOSAL_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(proposalPath), { recursive: true });
  fs.writeFileSync(proposalPath, `${JSON.stringify({
    schema: 'round_chain_proposal_v1',
    generated_at_utc: new Date().toISOString(),
    note: 'PROPOSAL ONLY — nothing here has touched the validity ledger. Review each pair; '
      + 'delete lines you reject; then run `nullius trace confirm-chains` to append the '
      + 'supersede events with your actor identity.',
    proposals,
  }, null, 2)}\n`);
  return { proposals, path: proposalPath };
}

export function confirmRoundChains(
  projectRoot: string,
  actor: string,
): { appended: number; already: number; skippedDecided: number } {
  const proposalPath = path.join(projectRoot, CHAIN_PROPOSAL_RELATIVE_PATH);
  if (!fs.existsSync(proposalPath)) {
    throw new Error(`no proposal file at ${CHAIN_PROPOSAL_RELATIVE_PATH}; run \`nullius trace propose-chains\` first`);
  }
  const parsed = JSON.parse(fs.readFileSync(proposalPath, 'utf-8')) as { proposals?: ChainProposal[] };
  // Idempotency is SEMANTIC, not event-id based: every confirmation mints
  // fresh event ids, so "already recorded" must mean "this supersession is
  // already on the ledger", or a re-run would double-append every pair.
  const ledger = readValidityLedger(projectRoot);
  let appended = 0;
  let already = 0;
  let skippedDecided = 0;
  const confirmed = new Set<string>();
  for (const proposal of parsed.proposals ?? []) {
    for (const pair of proposal.supersede) {
      // A duplicate pair inside one hand-edited proposal confirms once.
      const key = `${pair.old_run_id}→${pair.new_run_id}`;
      if (confirmed.has(key)) {
        already += 1;
        continue;
      }
      confirmed.add(key);
      const recorded = ledger.events.some(event => event.event === 'supersede'
        && event.run_id === pair.old_run_id
        && event.by_run_id === pair.new_run_id
        && (event.scope ?? 'full') === 'full');
      if (recorded) {
        already += 1;
        continue;
      }
      // Decisions made BETWEEN proposal generation and confirmation are
      // honored, not relitigated: re-check at confirm time with the same
      // rule the proposer used.
      if (isAlreadyDecided(ledger, pair.old_run_id)) {
        skippedDecided += 1;
        continue;
      }
      appendValidityEvent(projectRoot, buildValidityEvent({
        event: 'supersede',
        run_id: pair.old_run_id,
        by_run_id: pair.new_run_id,
        actor,
        reason: `round-chain confirmation: ${pair.new_run_id} is the later round of the same candidate (${proposal.slug})`,
      }));
      appended += 1;
    }
  }
  return { appended, already, skippedDecided };
}
