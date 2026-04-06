import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// `autoresearch workflow-plan` is a native TS front door in the orchestrator
// package, so it may consume the checked-in generic workflow authority package
// in addition to shared contract/control-plane helpers.
const ALLOWED_WORKSPACE_IMPORTS = new Set([
  '@autoresearch/shared',
  '@autoresearch/literature-workflows',
]);
// Exact-name only: `app-state` or `ui-kit` do not match these reserved
// top-level shell/app-layer directory names.
const FORBIDDEN_TOP_LEVEL_DIRS = new Set(['shell', 'frontend', 'gateway', 'ui', 'web', 'app']);

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
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

function findWorkspaceImportOffenders(source: string): string[] {
  const offenders: string[] = [];
  const importPattern = /['"](@autoresearch\/[^'"]+)['"]/g;
  for (const [index, line] of source.split('\n').entries()) {
    if (!line.includes('@autoresearch/')) continue;
    if (!/(?:^\s*import\b|^\s*export\b|\bfrom\s*['"]|\bimport\s*\()/.test(line)) continue;
    importPattern.lastIndex = 0;
    for (const match of line.matchAll(importPattern)) {
      if (!ALLOWED_WORKSPACE_IMPORTS.has(match[1]!)) {
        offenders.push(`L${index + 1}:${match[1]}`);
      }
    }
  }
  return offenders;
}

function isForbiddenUiSpecifier(specifier: string): boolean {
  return (
    specifier === 'react' ||
    specifier === 'react-dom' ||
    specifier === 'next' ||
    specifier === 'vite' ||
    specifier === 'electron' ||
    specifier === 'expo' ||
    specifier === 'react-native' ||
    specifier.startsWith('@tauri-apps/')
  );
}

function findUiImportOffenders(source: string): string[] {
  const offenders: string[] = [];
  const importPattern = /['"]([^'"]+)['"]/g;
  for (const [index, line] of source.split('\n').entries()) {
    if (!/(?:^\s*import\b|^\s*export\b|\bfrom\s*['"]|\bimport\s*\()/.test(line)) continue;
    importPattern.lastIndex = 0;
    for (const match of line.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (isForbiddenUiSpecifier(specifier)) {
        offenders.push(`L${index + 1}:${specifier}`);
      }
    }
  }
  return offenders;
}

function packageDependencyOffenders(packageJsonPath: string): string[] {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
  const dependencyGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const offenders: string[] = [];
  for (const group of dependencyGroups) {
    const entries = packageJson[group];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const name of Object.keys(entries)) {
      if (name.startsWith('@autoresearch/') && !ALLOWED_WORKSPACE_IMPORTS.has(name)) {
        offenders.push(`${group}:${name}`);
      }
      if (isForbiddenUiSpecifier(name)) {
        offenders.push(`${group}:${name}`);
      }
    }
  }
  return offenders.sort((left, right) => left.localeCompare(right));
}

describe('orchestrator package boundary', () => {
  it('keeps orchestrator source limited to shared plus checked-in workflow authority workspace dependencies', () => {
    const repoRoot = repoRootFromThisFile();
    const srcRoot = path.join(repoRoot, 'packages', 'orchestrator', 'src');
    const offenders = collectTsFiles(srcRoot).flatMap(filePath => {
      const relPath = path.relative(repoRoot, filePath);
      const source = fs.readFileSync(filePath, 'utf-8');
      return findWorkspaceImportOffenders(source).map(match => `${relPath}:${match}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps orchestrator free of UI and app-shell imports/dependencies', () => {
    const repoRoot = repoRootFromThisFile();
    const srcRoot = path.join(repoRoot, 'packages', 'orchestrator', 'src');
    const sourceOffenders = collectTsFiles(srcRoot).flatMap(filePath => {
      const relPath = path.relative(repoRoot, filePath);
      const source = fs.readFileSync(filePath, 'utf-8');
      return findUiImportOffenders(source).map(match => `${relPath}:${match}`);
    });
    const packageJsonPath = path.join(repoRoot, 'packages', 'orchestrator', 'package.json');
    const dependencyOffenders = packageDependencyOffenders(packageJsonPath);

    expect([...sourceOffenders, ...dependencyOffenders]).toEqual([]);
  });

  it('keeps top-level shell and app-layer directories out of orchestrator/src', () => {
    const repoRoot = repoRootFromThisFile();
    const srcRoot = path.join(repoRoot, 'packages', 'orchestrator', 'src');
    const offenders = fs.readdirSync(srcRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && FORBIDDEN_TOP_LEVEL_DIRS.has(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));

    expect(offenders).toEqual([]);
  });
});
