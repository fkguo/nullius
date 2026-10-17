import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEAF_PACKAGES, PUBLISHABLE_PACKAGES, checkPublishablePackages } from '../check-publishable-package-deps-anti-drift.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-publishable-package-deps-anti-drift.mjs');

/** A temporary repo root holding copies of the real package.json files, for negative controls. */
function fixtureRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-publishable-deps-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const dir of [...Object.keys(PUBLISHABLE_PACKAGES), ...LEAF_PACKAGES]) {
    const src = path.join(repoRoot, 'packages', dir, 'package.json');
    const dst = path.join(base, 'packages', dir, 'package.json');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  const edit = (dir, mutate) => {
    const file = path.join(base, 'packages', dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(pkg);
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  };
  return { base, edit };
}

test('the real repository satisfies PLUG-01', () => {
  assert.deepEqual(checkPublishablePackages({ repoRoot }), []);
});

test('CLI entry exits 0 on the real repository', () => {
  const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /satisfy PLUG-01/);
});

test('rep-sdk may not depend on any @nullius/* package, shared included', t => {
  const { base, edit } = fixtureRoot(t);
  edit('rep-sdk', pkg => { pkg.dependencies = { ...pkg.dependencies, '@nullius/shared': 'workspace:*' }; });
  const problems = checkPublishablePackages({ repoRoot: base });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /rep-sdk\/package\.json: dependencies lists @nullius\/shared/);
});

test('an MCP server may depend on @nullius/shared but on no other internal package', t => {
  const { base, edit } = fixtureRoot(t);
  edit('pdg-mcp', pkg => { pkg.dependencies = { ...pkg.dependencies, '@nullius/orchestrator': 'workspace:*' }; });
  const problems = checkPublishablePackages({ repoRoot: base });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pdg-mcp\/package\.json: dependencies lists @nullius\/orchestrator/);
  assert.match(problems[0], /allows only @nullius\/shared/);
});

test('@nullius/* peer dependencies are rejected as well', t => {
  const { base, edit } = fixtureRoot(t);
  edit('zotero-mcp', pkg => { pkg.peerDependencies = { '@nullius/shared': '*' }; });
  const problems = checkPublishablePackages({ repoRoot: base });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zotero-mcp\/package\.json: peerDependencies lists @nullius\/shared/);
});

test('shared must stay a leaf and publishable', t => {
  const { base, edit } = fixtureRoot(t);
  edit('shared', pkg => { pkg.dependencies = { ...pkg.dependencies, '@nullius/project-contracts': 'workspace:*' }; pkg.private = true; });
  const problems = checkPublishablePackages({ repoRoot: base });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /shared\/package\.json: dependencies lists @nullius\/project-contracts/);
  assert.match(problems[1], /shared\/package\.json: "private": true/);
});

test('a publishable package marked private is reported', t => {
  const { base, edit } = fixtureRoot(t);
  edit('pdg-mcp', pkg => { pkg.private = true; });
  const problems = checkPublishablePackages({ repoRoot: base });
  assert.deepEqual(problems.map(p => /"private": true/.test(p)), [true]);
});

test('a missing package.json is a problem, not a silent pass', t => {
  const { base } = fixtureRoot(t);
  fs.rmSync(path.join(base, 'packages', 'rep-sdk'), { recursive: true });
  const problems = checkPublishablePackages({ repoRoot: base });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /rep-sdk\/package\.json: missing/);
});

test('CLI entry exits 1 and names the offender on a violating tree', t => {
  const { base, edit } = fixtureRoot(t);
  edit('zotero-mcp', pkg => { pkg.dependencies = { ...pkg.dependencies, '@nullius/hep-mcp': 'workspace:*' }; });
  // The CLI reads its own repo root; drive the library on the fixture and the CLI on a copy of the script instead.
  const scriptCopyDir = path.join(base, 'scripts');
  fs.mkdirSync(scriptCopyDir, { recursive: true });
  fs.copyFileSync(scriptPath, path.join(scriptCopyDir, 'check.mjs'));
  const result = spawnSync(process.execPath, [path.join(scriptCopyDir, 'check.mjs')], { cwd: base, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL \(PLUG-01\)/);
  assert.match(result.stderr, /zotero-mcp\/package\.json: dependencies lists @nullius\/hep-mcp/);
});
