import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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
  const fd = openSync(path, 'a');

  try {
    writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
