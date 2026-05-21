#!/usr/bin/env node

/**
 * ART-03: atomic-write anti-drift CI check.
 *
 * Locks in the P1 migration (PRs #17, #18, #19, #20) by failing CI if any
 * new production-code site introduces a bare `fs.writeFileSync`,
 * `fs.renameSync`, `fs.appendFileSync`, `fs.promises.writeFile`,
 * `fs.promises.rename`, or `fs.promises.appendFile`. Every artifact write
 * in production paths must go through the durable primitives in
 * `@autoresearch/shared` (`writeBytesAtomicDurable`, `writeJsonAtomicDurable`,
 * `appendJsonlDurable`, `writeExecutableAtomicDurable`, `commitStagedDurable`).
 *
 * Why this matters:
 *   - Bare writeFileSync/renameSync skips the file fsync + parent-dir fsync
 *     that the durable primitives perform, leaving artifact files vulnerable
 *     to power-loss truncation between write and the next OS flush, or to
 *     directory-entry loss between rename and the next OS flush.
 *   - We've migrated every production site in orchestrator/src and
 *     hep-mcp/src to the durable primitives. New code must follow.
 *
 * Allowed exceptions (any new exception MUST be justified inline below):
 *
 *   1. packages/shared/src/atomic-write.ts — the primitive implementation
 *      itself. It is the SOURCE of the durable sequence; it has to call the
 *      bare fs operations internally.
 *
 *   2. packages/hep-mcp/src/data/papersCacheFetch.ts:179 —
 *      cross-parent dir-rename (arxivSubdir → finalLatexDir, different
 *      parents under the same tmpContentDir). `commitStagedDurable`
 *      requires same-parent, so this site cannot be migrated directly. The
 *      enclosing tmpContentDir is durably committed at a higher level via
 *      papersCache.ts (`commitStagedDurable(tmpRoot, paths.root)`), which
 *      subsumes this intermediate rename's local durability.
 *
 * Scanned packages (production code only — tests excluded):
 *   packages/orchestrator/src
 *   packages/hep-mcp/src
 *   packages/arxiv-mcp/src
 *   packages/hepdata-mcp/src
 *   packages/openalex-mcp/src
 *   packages/pdg-mcp/src
 *   packages/zotero-mcp/src
 *   packages/idea-mcp/src
 *   packages/shared/src (with atomic-write.ts allowlisted)
 *
 * Excluded from scanning:
 *   - **\/__tests__\/**
 *   - **\/tests\/**
 *   - **\/*.test.ts, **\/*.spec.ts
 *   - **\/dist\/**, **\/node_modules\/**
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCANNED_ROOTS = [
  'packages/orchestrator/src',
  'packages/hep-mcp/src',
  'packages/arxiv-mcp/src',
  'packages/hepdata-mcp/src',
  'packages/openalex-mcp/src',
  'packages/pdg-mcp/src',
  'packages/zotero-mcp/src',
  'packages/idea-mcp/src',
  'packages/shared/src',
];

const FORBIDDEN_PATTERNS = [
  // sync namespaced
  /\bfs\.writeFileSync\b/,
  /\bfs\.renameSync\b/,
  /\bfs\.appendFileSync\b/,
  // promises namespaced
  /\bfs\.promises\.writeFile\b/,
  /\bfs\.promises\.rename\b/,
  /\bfs\.promises\.appendFile\b/,
  // destructured promises (less common but valid TS)
  /\bpromises\.writeFile\b/,
  /\bpromises\.rename\b/,
  /\bpromises\.appendFile\b/,
];

// Repo-relative paths that are allowed to keep bare fs writes/renames. Every
// entry MUST be justified in the file-level docstring above.
const ALLOWLIST = new Set([
  'packages/shared/src/atomic-write.ts',
  'packages/hep-mcp/src/data/papersCacheFetch.ts',
]);

function* walkProductionFiles(rootRel) {
  const rootAbs = path.join(repoRoot, rootRel);
  if (!existsSync(rootAbs)) return;
  const stack = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__' || entry.name === 'tests') {
        continue;
      }
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(childAbs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(entry.name)) continue;
      yield childAbs;
    }
  }
}

function stripCommentsAndStrings(line) {
  // Conservative: remove `//`-style trailing comments and standalone string
  // literals so that comments documenting the prior `fs.writeFileSync(...)`
  // call (as we have in several migrated files) don't trigger false hits.
  // Block comments are handled at line granularity — multi-line block
  // comments containing `fs.writeFileSync` would still trigger; in that case
  // the author should rephrase the comment.
  let stripped = line;
  // Remove line comments
  const lineCommentIdx = stripped.indexOf('//');
  if (lineCommentIdx !== -1) {
    stripped = stripped.slice(0, lineCommentIdx);
  }
  // Remove single-line block comment fragments
  stripped = stripped.replace(/\/\*[^*]*\*\//g, '');
  // Remove string contents (rough — drops everything between balanced quotes
  // on a single line). This eliminates docstrings and string-literal
  // diagnostics that mention these tokens.
  stripped = stripped.replace(/"(?:\\.|[^"\\])*"/g, '""');
  stripped = stripped.replace(/'(?:\\.|[^'\\])*'/g, "''");
  stripped = stripped.replace(/`(?:\\.|[^`\\])*`/g, '``');
  return stripped;
}

function scanFile(absPath) {
  const relPath = path.relative(repoRoot, absPath).split(path.sep).join('/');
  if (ALLOWLIST.has(relPath)) return [];

  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');
  const hits = [];
  let inBlockComment = false;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    let line = lines[lineIdx];
    // Track multi-line block comments crudely.
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) continue;
      line = line.slice(endIdx + 2);
      inBlockComment = false;
    }
    const openIdx = line.indexOf('/*');
    if (openIdx !== -1 && line.indexOf('*/', openIdx) === -1) {
      line = line.slice(0, openIdx);
      inBlockComment = true;
    }
    const code = stripCommentsAndStrings(line);
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(code)) {
        hits.push({ line: lineIdx + 1, match: pattern.source, text: line.trim() });
        break;
      }
    }
  }
  return hits.map(hit => ({ relPath, ...hit }));
}

function main() {
  const errors = [];
  for (const rootRel of SCANNED_ROOTS) {
    for (const absPath of walkProductionFiles(rootRel)) {
      const hits = scanFile(absPath);
      for (const hit of hits) {
        errors.push(
          `${hit.relPath}:${hit.line} — forbidden \`${hit.match}\`: ${hit.text}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write('[atomic-write-drift] forbidden bare fs write/rename/append calls in production code:\n\n');
    for (const error of errors) {
      process.stderr.write(`  ${error}\n`);
    }
    process.stderr.write(
      '\nUse one of the durable primitives from @autoresearch/shared instead:\n' +
      '  - writeBytesAtomicDurable(filePath, bytes, mode?)\n' +
      '  - writeJsonAtomicDurable(filePath, payload, stringify?)\n' +
      '  - appendJsonlDurable(filePath, lineObject)\n' +
      '  - writeExecutableAtomicDurable(filePath, script)\n' +
      '  - commitStagedDurable(stagedPath, finalPath)\n' +
      '\nIf the new call site genuinely cannot use a primitive (e.g. cross-parent\n' +
      'rename inside an outer durably-committed staging area), add it to the\n' +
      'ALLOWLIST in scripts/check-atomic-write-anti-drift.mjs with a justification.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[ok] no bare fs.writeFileSync/renameSync/appendFileSync (or fs.promises.* variants) in production code paths.\n');
}

main();
