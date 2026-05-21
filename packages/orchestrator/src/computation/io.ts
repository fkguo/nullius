import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  writeBytesAtomicDurable,
  writeJsonAtomicDurable,
} from '@autoresearch/shared';

export function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function toPosixRelative(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join('/');
}

/**
 * Atomic JSON write — now backed by the shared durable primitive (P1).
 * The previous implementation did tmp + rename WITHOUT fsync, leaving
 * artifact files vulnerable to power-loss truncation. Now uses the
 * full POSIX-correct sequence (file fsync + dir fsync).
 *
 * Kept as a thin re-export so existing callers don't need to change.
 */
export function writeJsonAtomic(filePath: string, payload: unknown): void {
  writeJsonAtomicDurable(filePath, payload);
}

/**
 * Atomic text write — now backed by the shared durable primitive (P1).
 * See `writeJsonAtomic` for the migration rationale.
 */
export function writeTextAtomic(filePath: string, content: string): void {
  writeBytesAtomicDurable(filePath, content);
}
