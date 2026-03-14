import { closeSync, mkdirSync, openSync, rmSync } from 'fs';
import { dirname } from 'path';

export function withLock<T>(lockFilePath: string, fn: () => T): T {
  mkdirSync(dirname(lockFilePath), { recursive: true });
  const fd = openSync(lockFilePath, 'wx');
  closeSync(fd);

  try {
    return fn();
  } finally {
    rmSync(lockFilePath, { force: true });
  }
}
