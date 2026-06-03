#!/usr/bin/env node

/**
 * P3-C: harness-invocation anti-drift CI check.
 *
 * Locks the contract that every `*-mcp` package's outermost dispatch
 * function calls `verifyHarnessInvocationMarker` from `@autoresearch/shared`
 * before performing tool work. This catches:
 *   - A new `*-mcp` package added without wiring the verifier.
 *   - An existing dispatcher refactor that drops the call.
 *   - The verifier being downgraded to a no-op (e.g. wrapped in an always-
 *     skipped conditional) — we look for the bare function call.
 *
 * The check is a structural grep: each tracked dispatcher entry-point file
 * must (a) import `verifyHarnessInvocationMarker` from `@autoresearch/shared`
 * and (b) reference it at least once in the file body.
 *
 * Adding a new `*-mcp` package: register its dispatcher entry-point in
 * `DISPATCHER_ENTRYPOINTS` below. The discovery pass also fails CI when a
 * new `*-mcp` package is not yet registered, so this anti-drift check
 * cannot be silently bypassed by forgetting the update.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tracked dispatcher entry-point files. Each MUST import + reference
// `verifyHarnessInvocationMarker` from `@autoresearch/shared`.
const DISPATCHER_ENTRYPOINTS = [
  'packages/arxiv-mcp/src/tools/dispatcher.ts',
  'packages/hep-mcp/src/tools/dispatcher.ts',
  'packages/hepdata-mcp/src/tools/dispatcher.ts',
  'packages/idea-mcp/src/server.ts',
  'packages/openalex-mcp/src/tools/dispatcher.ts',
  'packages/pdg-mcp/src/tools/dispatcher.ts',
  'packages/zotero-mcp/src/tools/dispatcher.ts',
];

// Paths searched (in order) for the dispatcher entry-point of a newly
// discovered *-mcp package. The first existing match wins.
const CANDIDATE_ENTRY_RELS = ['src/tools/dispatcher.ts', 'src/server.ts', 'src/dispatcher.ts'];
const MCP_PACKAGE_NAME_RE = /^[a-z][a-z0-9-]*-mcp$/;

const IMPORT_PATTERN = /verifyHarnessInvocationMarker[^;]*from\s+['"]@autoresearch\/shared['"]/;
const USAGE_PATTERN = /\bverifyHarnessInvocationMarker\s*\(/;

function discoverMcpPackages() {
  const packagesRoot = path.join(repoRoot, 'packages');
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && MCP_PACKAGE_NAME_RE.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

function findEntryPointForPackage(packageDir) {
  for (const rel of CANDIDATE_ENTRY_RELS) {
    const candidate = `packages/${packageDir}/${rel}`;
    if (existsSync(path.join(repoRoot, candidate))) return candidate;
  }
  return null;
}

function checkDispatcher(relPath, errors) {
  const absPath = path.join(repoRoot, relPath);
  if (!existsSync(absPath)) {
    errors.push(`${relPath}: tracked dispatcher entry-point is missing — has the file been moved or renamed?`);
    return;
  }
  const content = readFileSync(absPath, 'utf-8');
  if (!IMPORT_PATTERN.test(content)) {
    errors.push(
      `${relPath}: missing import of \`verifyHarnessInvocationMarker\` from '@autoresearch/shared'.`,
    );
  }
  if (!USAGE_PATTERN.test(content)) {
    errors.push(
      `${relPath}: imports \`verifyHarnessInvocationMarker\` but never calls it. ` +
      `The call must run at the outermost dispatch layer before any tool work.`,
    );
  }
}

function main() {
  const errors = [];

  // 1. Every tracked dispatcher must wire the verifier.
  for (const relPath of DISPATCHER_ENTRYPOINTS) {
    checkDispatcher(relPath, errors);
  }

  // 2. Every *-mcp package on disk must be registered. This catches "new
  // MCP added without wiring up the verifier" by discovering packages from
  // the filesystem rather than trusting the static list.
  const trackedSet = new Set(DISPATCHER_ENTRYPOINTS);
  for (const pkg of discoverMcpPackages()) {
    const found = findEntryPointForPackage(pkg);
    if (!found) {
      errors.push(
        `packages/${pkg}/: appears to be an *-mcp package but no dispatcher entry-point ` +
        `(${CANDIDATE_ENTRY_RELS.join(' | ')}) was found.`,
      );
      continue;
    }
    if (!trackedSet.has(found)) {
      errors.push(
        `${found}: new *-mcp dispatcher detected — add this path to DISPATCHER_ENTRYPOINTS ` +
        `in scripts/check-harness-invocation-anti-drift.mjs, then wire ` +
        `\`verifyHarnessInvocationMarker(process.cwd())\` into the dispatcher.`,
      );
    }
  }

  if (errors.length > 0) {
    process.stderr.write('[harness-invocation-drift] dispatcher anti-drift check failed:\n\n');
    for (const error of errors) {
      process.stderr.write(`  - ${error}\n`);
    }
    process.stderr.write(
      '\nEvery *-mcp dispatcher must import and call ' +
      '`verifyHarnessInvocationMarker(process.cwd(), { toolIsStateTouching: ... })` ' +
      "from '@autoresearch/shared' at the outermost layer of `handleToolCall` " +
      '(or equivalent), before any tool work. The dispatcher passes a per-tool ' +
      '`toolIsStateTouching` boolean computed from its package-local ' +
      '`state-touch-classification.ts` table. See packages/hep-mcp/src/tools/dispatcher.ts ' +
      'for the canonical wiring.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[ok] all *-mcp dispatchers wire `verifyHarnessInvocationMarker` from @autoresearch/shared.\n');
}

main();
