/**
 * Atomic file write utility (H-07).
 *
 * Strategy: write to temp file → fsync → rename (POSIX atomic on same filesystem).
 * Temp file placed in same directory as target to guarantee same-fs rename.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Write data atomically to `targetPath`.
 *
 * Uses write-to-temp + fsync + rename to prevent truncated/corrupt artifacts
 * on process crash.
 */
export function atomicWriteFileSync(targetPath: string, data: string | Buffer): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      // writeFileSync(fd, ...) handles full-write guarantee internally.
      fs.writeFileSync(fd, data);
      // fsync on the same writable fd (required on Windows where FlushFileBuffers
      // needs GENERIC_WRITE access).
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
