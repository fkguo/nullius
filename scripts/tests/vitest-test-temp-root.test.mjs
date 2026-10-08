import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import setup, {
  RETENTION_DAYS,
  removeTree,
  runPassed,
  sweepStaleRoots,
} from '../lib/vitest-test-temp-root.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY_MS = 24 * 60 * 60 * 1000;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-root-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeProject({ files, failedTests = 0, failedPaths = [], errors = [] }, root = '/x/demo-pkg') {
  return {
    config: { root },
    vitest: {
      state: {
        getFiles: () => files,
        getCountOfFailedTests: () => failedTests,
        getFailedFilepaths: () => failedPaths,
        getUnhandledErrors: () => errors,
      },
    },
  };
}

test('runPassed is true only for a positively clean run', () => {
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }] })), true);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }, { mode: 'skip' }] })), true);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'fail' } }] })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }], failedTests: 1 })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }], failedPaths: ['a'] })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }], errors: [new Error('x')] })), false);
  // interrupted run: a file that never finished
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'run' } }] })), false);
  assert.equal(runPassed(fakeProject({ files: [] })), false);
  // unknown API shape: never treated as a pass
  assert.equal(runPassed({ vitest: {} }), false);
  assert.equal(runPassed(undefined), false);
});

test('sweepStaleRoots removes only old directories with the module naming pattern', t => {
  const parent = scratch(t);
  const now = Date.now();
  const old = path.join(parent, 'orchestrator-20260101T000000Z-123-AbCdEf');
  const fresh = path.join(parent, 'orchestrator-20261001T000000Z-124-GhIjKl');
  const foreign = path.join(parent, 'someone-elses-dir');
  for (const dir of [old, fresh, foreign]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(old, 'evidence.txt'), 'x');
  const oldTime = new Date(now - (RETENTION_DAYS + 1) * DAY_MS);
  fs.utimesSync(old, oldTime, oldTime);
  fs.utimesSync(foreign, oldTime, oldTime);

  const removed = sweepStaleRoots(parent, { now });
  assert.deepEqual(removed, [old]);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
});

test('removeTree restores write permission on read-only directories', t => {
  const parent = scratch(t);
  const tree = path.join(parent, 'tree');
  const locked = path.join(tree, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'f'), 'x');
  fs.chmodSync(locked, 0o500);
  assert.equal(removeTree(tree), true);
  assert.equal(fs.existsSync(tree), false);
});

test('setup points TMPDIR at a fresh root and teardown removes it only after a pass', t => {
  const parent = scratch(t);
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, KEEP: process.env.NULLIUS_KEEP_TEST_TMP };
  t.after(() => {
    for (const [key, value] of [['TMPDIR', saved.TMPDIR], ['TMP', saved.TMP], ['TEMP', saved.TEMP], ['NULLIUS_KEEP_TEST_TMP', saved.KEEP]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.NULLIUS_KEEP_TEST_TMP;

  const runOnce = project => {
    process.env.TMPDIR = parent;
    const teardown = setup(project);
    const root = os.tmpdir();
    assert.ok(root.startsWith(path.join(parent, 'nullius-test-runs') + path.sep), root);
    fs.writeFileSync(path.join(root, 'leftover'), 'x');
    teardown();
    assert.equal(process.env.TMPDIR, parent, 'teardown restores the previous TMPDIR');
    return root;
  };

  const passed = runOnce(fakeProject({ files: [{ result: { state: 'pass' } }] }));
  assert.equal(fs.existsSync(passed), false, 'passing run root is removed');

  const failed = runOnce(fakeProject({ files: [{ result: { state: 'fail' } }], failedTests: 1 }));
  assert.equal(fs.existsSync(failed), true, 'failing run root is kept');

  process.env.NULLIUS_KEEP_TEST_TMP = '1';
  const kept = runOnce(fakeProject({ files: [{ result: { state: 'pass' } }] }));
  assert.equal(fs.existsSync(kept), true, 'explicit keep flag keeps a passing run root');
});

test('every package whose tests run under vitest wires the per-run temporary root', () => {
  const packagesDir = path.join(repoRoot, 'packages');
  const missing = [];
  for (const name of fs.readdirSync(packagesDir).sort()) {
    const pkgPath = path.join(packagesDir, name, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (!/\bvitest\b/.test(pkg.scripts?.test ?? '')) continue;
    const configPath = path.join(packagesDir, name, 'vitest.config.ts');
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
    if (!config.includes("globalSetup: ['../../scripts/lib/vitest-test-temp-root.mjs']")) missing.push(name);
  }
  assert.deepEqual(missing, [], `packages without the per-run temporary root: ${missing.join(', ')}`);
});
