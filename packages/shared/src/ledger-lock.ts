import { randomFillSync } from 'node:crypto';
import * as fs from 'node:fs';

/** Path-keyed cross-process mutual exclusion and ULID identity for append-only
 *  JSONL ledgers.
 *
 *  Extracted shape of the decisions ledger's proven lock (same O_EXCL create,
 *  bounded retry, fail-closed on an overdue lock, holder metadata in the lock
 *  file), generalized so any ledger file can key its own lock without
 *  inheriting decisions-specific error prose or the engine-state requirement.
 *  The decisions ledger itself is NOT migrated here in this change — its lock
 *  carries decision-specific recovery guidance — but both follow one
 *  discipline: every read-validate-append transition runs whole under the
 *  file's own lock, and a crash can leave a lock file that a human removes
 *  after confirming no writer is alive.
 *
 *  Why a lock at all: durable appends are O_APPEND single writes, but a
 *  ledger append is read-validate-append (duplicate event_id detection reads
 *  the current file first), and two concurrent writers interleaving that
 *  transition could both pass validation before either lands. The lock keeps
 *  the whole transition atomic per ledger file.
 */

const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_SLEEP_MS = 25;

function sleepBlocking(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function describeLockHolder(lockPath: string): string {
  try {
    const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    if (typeof content.pid === 'number') {
      return `held by pid ${content.pid} since ${String(content.ts ?? 'unknown time')}`;
    }
  } catch {
    // fall through
  }
  return 'holder unknown';
}

/** Run `action` while exclusively holding `<ledgerPath>.lock`.
 *
 *  Fail-closed: if the lock cannot be acquired within the bounded wait, throw
 *  an error naming the lock file, its recorded holder, and the caller-supplied
 *  quiescent-repair guidance (what to check before removing a crashed
 *  holder's lock file). No automatic stale-lock reclamation: a lock that
 *  outlives the wait means either a live writer (removal would corrupt) or a
 *  crash (a human confirms and removes) — the code cannot tell which.
 */
export function withLedgerLock<T>(
  ledgerPath: string,
  repairGuidance: string,
  action: () => T,
): T {
  const lockPath = `${ledgerPath}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      sleepBlocking(LOCK_RETRY_SLEEP_MS);
      continue;
    }
    try {
      // We own the freshly created lock from here on: any failure writing or
      // closing its metadata must not orphan it.
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      fs.rmSync(lockPath, { force: true });
      throw error;
    }
    acquired = true;
    break;
  }
  if (!acquired) {
    throw new Error(
      `ledger is locked (${lockPath}; ${describeLockHolder(lockPath)}). `
      + `If no writing process is running (e.g. after a crash): ${repairGuidance} `
      + 'Then remove the lock file and retry.',
    );
  }
  try {
    return action();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Mint a standard ULID: 48-bit millisecond timestamp + 80 random bits,
 *  Crockford base32, 26 characters. The first character is always 0-7
 *  (the 48-bit timestamp's two high pad bits are zero), matching the ledger
 *  schemas' `^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$` pattern.
 *
 *  One ULID identifies one LOGICAL event for its whole life: a retry of the
 *  same event — including a cross-process crash-recovery retry — must reuse
 *  the id it was minted (the CLIs accept --event-id for that), so ledger
 *  readers can deduplicate after git union merges.
 */
export function mintUlid(epochMs: number = Date.now()): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs >= 2 ** 48) {
    throw new Error(`epoch ${epochMs} ms is outside the 48-bit ULID timestamp range`);
  }
  let time = '';
  let rest = epochMs;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD_BASE32[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = randomFillSync(new Uint8Array(10));
  // 80 random bits → 16 base32 chars: consume 5 bits at a time from a bit
  // accumulator so no byte boundary bias is introduced.
  let random = '';
  let acc = 0;
  let accBits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      random += CROCKFORD_BASE32[(acc >> accBits) & 0x1f]!;
    }
  }
  return time + random;
}

export const ULID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
