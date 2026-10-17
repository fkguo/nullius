#!/usr/bin/env node

/**
 * PLUG-01: publishable-package dependency anti-drift.
 *
 * Three packages are meant to be installable on their own, without pulling in
 * the rest of the monorepo (orchestrator, hep-mcp, project-contracts, ...):
 *
 *   - @nullius/rep-sdk      protocol core: no @nullius/* dependency at all
 *   - @nullius/pdg-mcp      MCP server: may depend on @nullius/shared only
 *   - @nullius/zotero-mcp   MCP server: may depend on @nullius/shared only
 *
 * @nullius/shared is allowed because it is a leaf: it has no @nullius/*
 * dependency of its own, is not private, and ships at the same version as
 * everything else (scripts/check-version-consistency.mjs). This script locks
 * all of that, so a new `@nullius/orchestrator` line in pdg-mcp, or a new
 * internal dependency inside shared, fails CI instead of silently making the
 * "independent" packages depend on the whole workspace.
 *
 * `dependencies` and `optionalDependencies` count (consumers install both);
 * devDependencies do not. `peerDependencies` on @nullius/* are rejected too —
 * they move the install burden to the user without removing the coupling.
 * An alias such as `"x": "npm:@nullius/orchestrator@*"` counts as the
 * internal package it points at.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** package dir (under packages/) -> set of @nullius/* names it may list in dependencies. */
export const PUBLISHABLE_PACKAGES = Object.freeze({
  'rep-sdk': Object.freeze([]),
  'pdg-mcp': Object.freeze(['@nullius/shared']),
  'zotero-mcp': Object.freeze(['@nullius/shared']),
});

/** Packages that the allowed set above relies on being leaves. */
export const LEAF_PACKAGES = Object.freeze(['shared']);

const INTERNAL_SCOPE = '@nullius/';

function readPackageJson(repoRoot, dir) {
  const file = path.join(repoRoot, 'packages', dir, 'package.json');
  if (!existsSync(file)) return { file, pkg: null };
  return { file, pkg: JSON.parse(readFileSync(file, 'utf8')) };
}

/** @nullius/* entries of a dependency record, by key or by `npm:@nullius/...` alias value. */
function internalNames(record) {
  const names = [];
  for (const [name, spec] of Object.entries(record ?? {})) {
    // "npm:<target>[@<range>]": the range separator is the first "@" after position 0.
    const aliasTarget = typeof spec === 'string' && spec.startsWith('npm:')
      ? spec.slice('npm:'.length).replace(/(?!^)@.*$/, '')
      : null;
    if (aliasTarget && aliasTarget.startsWith(INTERNAL_SCOPE)) {
      // The alias target decides, even when the key itself is an allowed name.
      names.push(aliasTarget === name ? name : `${name} (alias of ${aliasTarget})`);
    } else if (name.startsWith(INTERNAL_SCOPE)) {
      names.push(name);
    }
  }
  return names.sort();
}

function installedInternalNames(pkg) {
  return [...internalNames(pkg.dependencies), ...internalNames(pkg.optionalDependencies)].sort();
}

/**
 * Returns the list of problems (empty when the contract holds).
 * Pure: reads package.json files under `repoRoot/packages/` and nothing else.
 */
export function checkPublishablePackages({
  repoRoot = scriptRepoRoot,
  publishable = PUBLISHABLE_PACKAGES,
  leaves = LEAF_PACKAGES,
} = {}) {
  const problems = [];
  const rel = file => path.relative(repoRoot, file);

  for (const [dir, allowedList] of Object.entries(publishable)) {
    const { file, pkg } = readPackageJson(repoRoot, dir);
    if (!pkg) { problems.push(`${rel(file)}: missing (publishable package listed in PLUG-01)`); continue; }
    const allowed = new Set(allowedList);
    for (const name of installedInternalNames(pkg)) {
      if (!allowed.has(name)) {
        problems.push(`${rel(file)}: dependencies/optionalDependencies lists ${name}; PLUG-01 allows only ${allowedList.length ? allowedList.join(', ') : 'no @nullius/* dependency'}`);
      }
    }
    for (const name of internalNames(pkg.peerDependencies)) {
      problems.push(`${rel(file)}: peerDependencies lists ${name}; PLUG-01 forbids @nullius/* peer dependencies (they keep the coupling and move the install burden to the user)`);
    }
    if (pkg.private === true) problems.push(`${rel(file)}: "private": true but PLUG-01 requires the package to be publishable`);
  }

  for (const dir of leaves) {
    const { file, pkg } = readPackageJson(repoRoot, dir);
    if (!pkg) { problems.push(`${rel(file)}: missing (leaf package that publishable packages depend on)`); continue; }
    for (const name of installedInternalNames(pkg)) {
      problems.push(`${rel(file)}: dependencies/optionalDependencies lists ${name}; ${pkg.name ?? dir} must stay a leaf (no @nullius/* dependency) because publishable packages depend on it`);
    }
    for (const name of internalNames(pkg.peerDependencies)) {
      problems.push(`${rel(file)}: peerDependencies lists ${name}; ${pkg.name ?? dir} must stay a leaf`);
    }
    if (pkg.private === true) problems.push(`${rel(file)}: "private": true but publishable packages depend on it, so it must be publishable too`);
  }

  return problems;
}

function isMain() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}

if (isMain()) {
  const problems = checkPublishablePackages();
  if (problems.length) {
    console.error('[publishable-package-deps] FAIL (PLUG-01):');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const checked = [...Object.keys(PUBLISHABLE_PACKAGES), ...LEAF_PACKAGES];
  console.log(`[publishable-package-deps] ok — ${checked.join(', ')} satisfy PLUG-01`);
}
