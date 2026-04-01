#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectArtifactPaths(pkgJson) {
  const artifacts = new Set();

  const addMaybe = value => {
    if (typeof value === 'string' && value.trim() !== '') {
      artifacts.add(value);
    }
  };

  addMaybe(pkgJson.main);
  addMaybe(pkgJson.module);
  addMaybe(pkgJson.types);

  if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    for (const value of Object.values(pkgJson.bin)) {
      addMaybe(value);
    }
  }

  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    const stack = [pkgJson.exports];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node === 'string') {
        addMaybe(node);
        continue;
      }
      if (node && typeof node === 'object') {
        for (const value of Object.values(node)) {
          stack.push(value);
        }
      }
    }
  }

  return [...artifacts];
}

function findWorkspacePackageDir(packageName) {
  const packagesDir = path.join(repoRoot, 'packages');
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkgJson = readJson(pkgJsonPath);
    if (pkgJson.name === packageName) {
      return path.dirname(pkgJsonPath);
    }
  }
  return null;
}

function hasAllArtifacts(packageDir, pkgJson) {
  const relativePaths = collectArtifactPaths(pkgJson);
  if (relativePaths.length === 0) return true;
  return relativePaths.every(relPath => fs.existsSync(path.join(packageDir, relPath)));
}

function ensureBuilt(packageName) {
  const packageDir = findWorkspacePackageDir(packageName);
  if (!packageDir) {
    console.error(`[ensure-artifacts] Unknown workspace package: ${packageName}`);
    process.exit(1);
  }

  const packageJsonPath = path.join(packageDir, 'package.json');
  const pkgJson = readJson(packageJsonPath);
  if (hasAllArtifacts(packageDir, pkgJson)) {
    console.log(`[ensure-artifacts] ok ${packageName}`);
    return;
  }

  console.log(`[ensure-artifacts] building ${packageName}`);
  const result = spawnSync('pnpm', ['--filter', packageName, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const packageNames = process.argv.slice(2);
if (packageNames.length === 0) {
  console.error('Usage: node scripts/ensure-workspace-package-artifacts.mjs <workspace-package> [more-packages...]');
  process.exit(1);
}

for (const packageName of packageNames) {
  ensureBuilt(packageName);
}
