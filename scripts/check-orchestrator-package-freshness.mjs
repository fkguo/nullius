#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  collectFreshnessErrors,
  resolvePackageFreshnessOptions,
} from './lib/workspace-package-freshness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    packageDir: null,
    srcRoot: null,
    distRoot: null,
    buildInfoPath: null,
    packageLabel: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package-dir') {
      options.packageDir = path.resolve(argv[++index] ?? '');
      continue;
    }
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

function printUsage() {
  process.stderr.write(
    'Usage: node scripts/check-orchestrator-package-freshness.mjs ' +
      '[--package-dir <dir>] [--src-root <dir>] [--dist-root <dir>] [--package-label <label>]\n'
  );
  process.stderr.write(
    'Defaults to @autoresearch/orchestrator when no package-dir/src-root/dist-root is provided.\n'
  );
}

function finalizeOptions(options) {
  const finalized = { ...options };

  if (finalized.packageDir !== null) {
    const inferred = resolvePackageFreshnessOptions({
      packageDir: finalized.packageDir,
      packageLabel: finalized.packageLabel ?? undefined,
    });
    finalized.packageLabel = inferred.packageLabel;
    finalized.srcRoot ??= inferred.srcRoot;
    finalized.distRoot ??= inferred.distRoot;
    finalized.buildInfoPath ??= inferred.buildInfoPath;
  }

  const usingDefaultOrchestratorPaths = finalized.packageDir === null
    && finalized.srcRoot === null
    && finalized.distRoot === null;
  finalized.srcRoot ??= path.join(repoRoot, 'packages', 'orchestrator', 'src');
  finalized.distRoot ??= path.join(repoRoot, 'packages', 'orchestrator', 'dist');
  finalized.packageLabel ??= '@autoresearch/orchestrator';
  if (usingDefaultOrchestratorPaths) {
    finalized.buildInfoPath ??= path.join(repoRoot, 'packages', 'orchestrator', 'tsconfig.tsbuildinfo');
  }

  return finalized;
}

function main() {
  let options;
  try {
    options = finalizeOptions(parseArgs(process.argv.slice(2)));
  } catch (error) {
    printUsage();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const errors = collectFreshnessErrors({ repoRoot, ...options });
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
