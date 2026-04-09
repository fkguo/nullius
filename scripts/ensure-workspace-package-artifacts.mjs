#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import {
  collectArtifactPaths,
  collectFreshnessErrors,
  defaultBuildInfoPath,
  readJson,
  resolvePackageFreshnessRoots,
} from './lib/workspace-package-freshness.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

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

function needsFreshBuild(packageDir, pkgJson) {
  const roots = resolvePackageFreshnessRoots(packageDir, pkgJson);
  if (roots === null) {
    return false;
  }
  if (!fs.existsSync(roots.srcRoot) || !fs.existsSync(roots.distRoot)) {
    return false;
  }
  return collectFreshnessErrors({
    repoRoot,
    ...roots,
    buildInfoPath: defaultBuildInfoPath(packageDir),
  }).length > 0;
}

function ensureBuilt(packageName) {
  const packageDir = findWorkspacePackageDir(packageName);
  if (!packageDir) {
    console.error(`[ensure-artifacts] Unknown workspace package: ${packageName}`);
    process.exit(1);
  }

  const packageJsonPath = path.join(packageDir, 'package.json');
  const pkgJson = readJson(packageJsonPath);
  if (hasAllArtifacts(packageDir, pkgJson) && !needsFreshBuild(packageDir, pkgJson)) {
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
