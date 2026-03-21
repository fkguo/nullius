#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    srcRoot: path.join(repoRoot, 'packages', 'orchestrator', 'src'),
    distRoot: path.join(repoRoot, 'packages', 'orchestrator', 'dist'),
    packageLabel: '@autoresearch/orchestrator',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--src-root') {
      options.srcRoot = path.resolve(argv[++index] ?? '');
      continue;
    }
    if (arg === '--dist-root') {
      options.distRoot = path.resolve(argv[++index] ?? '');
      continue;
    }
    if (arg === '--package-label') {
      options.packageLabel = argv[++index] ?? '';
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function collectSourceFiles(dirPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      !fullPath.endsWith('.ts') ||
      fullPath.endsWith('.d.ts') ||
      fullPath.endsWith('.test.ts')
    ) {
      continue;
    }
    out.push(fullPath);
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function toDisplayPath(targetPath) {
  const relative = path.relative(repoRoot, targetPath);
  if (!relative.startsWith('..') && relative !== '') {
    return relative;
  }
  return targetPath;
}

function buildArtifactPaths(sourcePath, srcRoot, distRoot) {
  const relative = path.relative(srcRoot, sourcePath);
  const stem = relative.slice(0, -'.ts'.length);
  return {
    primaryPath: path.join(distRoot, `${stem}.js`),
    declarationPath: path.join(distRoot, `${stem}.d.ts`),
  };
}

function collectFreshnessErrors({ srcRoot, distRoot }) {
  if (!existsSync(srcRoot)) {
    return [`Source root not found: ${toDisplayPath(srcRoot)}`];
  }
  if (!existsSync(distRoot)) {
    return [`Dist root not found: ${toDisplayPath(distRoot)}`];
  }

  const sourceFiles = collectSourceFiles(srcRoot);
  if (sourceFiles.length === 0) {
    return [`No source files found under ${toDisplayPath(srcRoot)}`];
  }

  const errors = [];
  for (const sourcePath of sourceFiles) {
    const sourceStat = statSync(sourcePath);
    const { primaryPath, declarationPath } = buildArtifactPaths(sourcePath, srcRoot, distRoot);
    if (!existsSync(primaryPath)) {
      errors.push(
        `missing emitted artifact: source=${toDisplayPath(sourcePath)} artifact=${toDisplayPath(primaryPath)}`
      );
      continue;
    }
    if (!existsSync(declarationPath)) {
      errors.push(
        `missing emitted artifact: source=${toDisplayPath(sourcePath)} artifact=${toDisplayPath(declarationPath)}`
      );
      continue;
    }

    const artifactStat = statSync(primaryPath);
    if (artifactStat.mtimeMs < sourceStat.mtimeMs) {
      errors.push(
        `stale emitted artifact: source=${toDisplayPath(sourcePath)} artifact=${toDisplayPath(primaryPath)}`
      );
    }
  }

  return errors;
}

function printUsage() {
  process.stderr.write(
    'Usage: node scripts/check-orchestrator-package-freshness.mjs ' +
      '[--src-root <dir>] [--dist-root <dir>] [--package-label <label>]\n'
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const errors = collectFreshnessErrors(options);
  if (errors.length > 0) {
    process.stderr.write(
      `[stale-dist] ${options.packageLabel} package output is missing or out of date.\n`
    );
    for (const error of errors) {
      process.stderr.write(` - ${error}\n`);
    }
    process.stderr.write(
      `Run: pnpm --filter ${options.packageLabel} build\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `[ok] ${options.packageLabel} package output is fresh.\n`
  );
}

main();
