import { existsSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';

export function defaultProjectRoot(rootDir: string): string {
  let current = rootDir;
  while (true) {
    if (existsSync(resolve(current, '.nullius'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return basename(rootDir) === 'idea-store' ? dirname(rootDir) : rootDir;
}

export function insideOrEqual(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function encodeProjectPath(path: string): string {
  return path.split(sep).join('/').split('/').map(encodeURIComponent).join('/');
}
