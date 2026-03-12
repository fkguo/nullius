import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

export function writeJsonAtomic(filePath: string, payload: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function writeTextAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}
