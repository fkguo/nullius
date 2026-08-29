#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectArtifactPaths,
  collectFreshnessErrors,
  defaultBuildInfoPath,
  readJson,
  resolvePackageFreshnessRoots,
} from './lib/workspace-package-freshness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  // Windows package-manager shims are .cmd files. Node cannot execute those
  // directly, so use the native command interpreter there; keep direct argv
  // spawning on POSIX. packageName has already been matched to a checked-in
  // workspace package above, rather than accepting an arbitrary shell token.
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const args = process.platform === 'win32'
    ? ['/d', '/c', 'pnpm', '--filter', packageName, 'build']
    : ['--filter', packageName, 'build'];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[ensure-artifacts] failed to launch ${command}: ${result.error.message}`);
    process.exit(1);
  }
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
