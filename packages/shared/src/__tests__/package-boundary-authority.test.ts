import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function collectTsFiles(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function findWorkspaceImports(source: string): string[] {
  const offenders: string[] = [];
  const importPattern = /['"](@autoresearch\/[^'"]+)['"]/g;
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.includes('@autoresearch/')) continue;
    importPattern.lastIndex = 0;
    for (const match of line.matchAll(importPattern)) {
      offenders.push(`L${index + 1}:${match[1]}`);
    }
  }
  return offenders;
}

function workspaceDependencies(packageJsonPath: string): string[] {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
  const dependencyGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const offenders: string[] = [];
  for (const group of dependencyGroups) {
    const entries = packageJson[group];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries)) {
      if (name.startsWith('@autoresearch/')) {
        offenders.push(`${group}:${name}`);
      }
    }
  }
  return offenders.sort((left, right) => left.localeCompare(right));
}

describe('shared package boundary authority', () => {
  it('keeps shared source free of workspace package imports', () => {
    const repoRoot = repoRootFromThisFile();
    const srcRoot = path.join(repoRoot, 'packages', 'shared', 'src');
    const offenders = collectTsFiles(srcRoot).flatMap(filePath => {
      const matches = findWorkspaceImports(fs.readFileSync(filePath, 'utf-8'));
      const relPath = path.relative(repoRoot, filePath);
      return matches.map(match => `${relPath}:${match}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps shared package.json free of workspace package dependencies', () => {
    const repoRoot = repoRootFromThisFile();
    const packageJsonPath = path.join(repoRoot, 'packages', 'shared', 'package.json');
    expect(workspaceDependencies(packageJsonPath)).toEqual([]);
  });
});
