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
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    if (typeof data === 'string') {
      fs.writeSync(fd, data, null, 'utf-8');
    } else {
      fs.writeSync(fd, data);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
