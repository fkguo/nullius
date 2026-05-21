/**
 * Atomic file write utility (H-07; P1-migrated).
 *
 * Strategy: write to temp file → fsync(fd) → close → rename → fsync(dirFd)
 * for full POSIX durability. The implementation now delegates to
 * `@autoresearch/shared`'s `writeBytesAtomicDurable` primitive (P1)
 * which closes the prior parent-dir-fsync gap that left the rename's
 * directory entry vulnerable to power-loss between rename and the next
 * OS flush.
 *
 * Kept as a thin re-export so existing callers don't need to change.
 */
import { writeBytesAtomicDurable } from '@autoresearch/shared';

/**
 * Write data atomically + durably to `targetPath`.
 *
 * Uses tmp → fsync(fd) → close → rename → fsync(dirFd) to prevent
 * truncated/corrupt artifacts AND lost directory entries on process
 * crash or power loss. Tmp file is cleaned up on failure (best-effort).
 */
export function atomicWriteFileSync(targetPath: string, data: string | Buffer): void {
  writeBytesAtomicDurable(targetPath, data);
}
