import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import type { PathLike } from 'fs';
import { dirname } from 'path';

export function readJsonFile<T>(path: PathLike, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFileAtomic(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  const fd = openSync(tempPath, 'w');

  try {
    writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(tempPath, path);
}

export function appendJsonLine(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+'); // a+ (not a): the heal below must READ the last byte

  try {
    // A crash mid-append can leave the file ending in a torn fragment with no
    // trailing newline. Appending directly would GLUE the new entry onto that
    // fragment, turning a recoverable torn line into a permanently
    // unparseable one. Heal instead: start a fresh line when the last byte is
    // not a newline (the torn fragment stays behind as its own bad line,
    // which log readers already skip).
    const size = statSync(path).size;
    let prefix = '';
    if (size > 0) {
      const lastByte = Buffer.alloc(1);
      readSync(fd, lastByte, 0, 1, size - 1);
      if (lastByte[0] !== 0x0a) {
        prefix = '\n';
      }
    }
    writeFileSync(fd, `${prefix}${JSON.stringify(payload)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
