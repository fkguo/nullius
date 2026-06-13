#!/usr/bin/env node
// Version-consistency anti-drift.
//
// The repo ships as a single unit (the `autoresearch` front door + its workspace
// packages) and is pre-1.0, so all workspace package versions move in LOCKSTEP. This
// check fails CI if they drift — the historical failure was an ad-hoc spread of
// 0.0.1 / 0.1.0 / 0.3.0 with the front-door orchestrator stuck at 0.0.1, looking
// "earlier" than the libraries it owns. Authoritative version = every package.json's
// top-level `version` (must all be equal) + the exported `VERSION` constants (must match).
//
// Scope note: MCP server/client identity `version` strings are unified by hand at release
// time but are not locked here — package.json is the authoritative version surface.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`[version-consistency] FAIL: ${msg}`);
  process.exit(1);
}

// 1. Collect every workspace package.json version (+ the root).
const pkgFiles = [join(repoRoot, 'package.json')];
const pkgsDir = join(repoRoot, 'packages');
for (const name of readdirSync(pkgsDir)) {
  const p = join(pkgsDir, name, 'package.json');
  if (existsSync(p)) pkgFiles.push(p);
}

const versions = new Map(); // version -> [files]
for (const f of pkgFiles) {
  const v = JSON.parse(readFileSync(f, 'utf8')).version;
  if (typeof v !== 'string') fail(`${f} has no string "version"`);
  if (!versions.has(v)) versions.set(v, []);
  versions.get(v).push(f.replace(`${repoRoot}/`, ''));
}

if (versions.size !== 1) {
  const lines = [...versions.entries()].map(([v, fs]) => `  ${v}: ${fs.join(', ')}`).join('\n');
  fail(`package.json versions are not in lockstep:\n${lines}`);
}
const canonical = [...versions.keys()][0];

// 2. Every exported `VERSION` constant in packages/*/src/index.ts must match.
const constRe = /export const VERSION\s*=\s*['"]([^'"]+)['"]/;
for (const name of readdirSync(pkgsDir)) {
  const idx = join(pkgsDir, name, 'src', 'index.ts');
  if (!existsSync(idx)) continue;
  const m = readFileSync(idx, 'utf8').match(constRe);
  if (m && m[1] !== canonical) {
    fail(`packages/${name}/src/index.ts VERSION='${m[1]}' != package version '${canonical}'`);
  }
}

console.log(`[version-consistency] ok — all ${pkgFiles.length} packages + VERSION constants at ${canonical}`);
