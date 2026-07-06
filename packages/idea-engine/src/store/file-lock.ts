import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * A mutation attempted while another holder genuinely owns the lock. The
 * service layer maps this to a distinct RPC error (store_locked) instead of
 * the misleading schema_invalid a raw EEXIST would produce.
 */
export class StoreLockedError extends Error {
  readonly holderPid: number | null;
  readonly lockFilePath: string;

  constructor(lockFilePath: string, holderPid: number | null) {
    super(`campaign store is locked by ${holderPid === null ? 'an unknown holder' : `pid ${holderPid}`}: ${lockFilePath}`);
    this.name = 'StoreLockedError';
    this.holderPid = holderPid;
    this.lockFilePath = lockFilePath;
  }
}

/** Locks with no readable pid are reclaimed only past this age. */
const STALE_LOCK_MAX_AGE_MS = 10 * 60 * 1000;

/** Zero-byte locks (crash between create and pid write) reclaim much sooner:
 * a live acquirer writes its pid within milliseconds of creating the file. */
const EMPTY_LOCK_MAX_AGE_MS = 5 * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process — provably dead. EPERM: exists but not ours —
    // alive. Anything else: assume alive (never reclaim on uncertainty).
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Returns true when the stale lock was reclaimed (holder provably dead, or no
 * readable holder and the file is old); throws StoreLockedError when the lock
 * is genuinely held.
 *
 * A kill-crash (SIGKILL, power loss) between store writes leaves the lock
 * file behind; without reclamation the very retry that crash recovery needs
 * would be refused forever with a misleading error.
 */
function reclaimStaleLockOrThrow(lockFilePath: string): boolean {
  let holderPid: number | null = null;
  let empty = false;
  try {
    const raw = readFileSync(lockFilePath, 'utf8');
    empty = raw.length === 0;
    const content = JSON.parse(raw) as Record<string, unknown>;
    if (typeof content.pid === 'number' && Number.isInteger(content.pid) && content.pid > 0) {
      holderPid = content.pid;
    }
  } catch {
    holderPid = null; // unreadable/legacy lock: fall through to the age check
  }

  if (holderPid !== null) {
    if (processAlive(holderPid)) {
      throw new StoreLockedError(lockFilePath, holderPid);
    }
    rmSync(lockFilePath, { force: true });
    return true;
  }

  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(lockFilePath).mtimeMs;
  } catch {
    return true; // vanished between EEXIST and stat: just retry
  }
  // A zero-byte lock means the holder crashed between creating the file and
  // writing its pid — but a LIVE acquirer also passes through that window for
  // a few milliseconds, so reclaim only past a short grace period.
  const maxAgeMs = empty ? EMPTY_LOCK_MAX_AGE_MS : STALE_LOCK_MAX_AGE_MS;
  if (ageMs > maxAgeMs) {
    rmSync(lockFilePath, { force: true });
    return true;
  }
  throw new StoreLockedError(lockFilePath, null);
}

export function withLock<T>(lockFilePath: string, fn: () => T): T {
  mkdirSync(dirname(lockFilePath), { recursive: true });

  let fd: number | null = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt += 1) {
    try {
      fd = openSync(lockFilePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (attempt === 1) {
        // Reclaimed a stale lock but lost the re-acquire race to a concurrent
        // live acquirer: this is a held-lock condition, not a schema problem.
        throw new StoreLockedError(lockFilePath, null);
      }
      reclaimStaleLockOrThrow(lockFilePath);
    }
  }
  if (fd === null) {
    throw new StoreLockedError(lockFilePath, null);
  }
  try {
    writeFileSync(fd, JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid }), 'utf8');
  } finally {
    closeSync(fd);
  }

  try {
    return fn();
  } finally {
    rmSync(lockFilePath, { force: true });
  }
}
