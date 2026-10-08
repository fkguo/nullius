import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import setup, {
  RETENTION_DAYS,
  ensurePrivateParent,
  removeTree,
  runPassed,
  sweepStaleRoots,
  testRunsParent,
} from '../lib/vitest-test-temp-root.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'lib', 'vitest-test-temp-root.mjs');
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

function withEnv(t, values) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function age(target, days) {
  const past = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(target, past, past);
}

test('runPassed is true only for a positively clean run', () => {
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }] })), true);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }, { mode: 'skip' }] })), true);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'fail' } }] })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }], failedTests: 1 })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }], failedPaths: ['a'] })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'pass' } }], errors: [new Error('x')] })), false);
  assert.equal(runPassed(fakeProject({ files: [{ result: { state: 'run' } }] })), false, 'interrupted');
  assert.equal(runPassed(fakeProject({ files: [] })), false);
  assert.equal(runPassed({ vitest: {} }), false, 'unknown API shape is never a pass');
  assert.equal(runPassed(undefined), false);
});

test('sweep removes only old, finished roots created by this module', t => {
  const parent = scratch(t);
  const dead = 999_999_999;
  const old = path.join(parent, `orches-${dead}-AbCdEf`);
  const recentInside = path.join(parent, `orches-${dead}-GhIjKl`);
  const live = path.join(parent, `orches-${process.ppid}-MnOpQr`);
  const foreign = path.join(parent, 'someone-elses-dir');
  for (const dir of [old, recentInside, live, foreign]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(old, 'evidence.txt'), 'x');
  age(path.join(old, 'evidence.txt'), RETENTION_DAYS + 1);
  age(old, RETENTION_DAYS + 1);
  // a root whose own mtime is old but which holds a recent file is not stale
  fs.mkdirSync(path.join(recentInside, 'sub'));
  fs.writeFileSync(path.join(recentInside, 'sub', 'new.txt'), 'x');
  age(path.join(recentInside, 'sub'), RETENTION_DAYS + 1);
  age(recentInside, RETENTION_DAYS + 1);
  age(live, RETENTION_DAYS + 1);
  age(foreign, RETENTION_DAYS + 1);

  const removed = sweepStaleRoots(parent, { isAlive: pid => pid === process.ppid });
  assert.deepEqual(removed, [old]);
  for (const dir of [recentInside, live, foreign]) assert.equal(fs.existsSync(dir), true, dir);
});

test('a root that cannot be fully inspected is never judged old', t => {
  const parent = scratch(t);
  const root = path.join(parent, 'orches-999999999-UnReAd');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'recent.txt'), 'modified just now');
  age(locked, RETENTION_DAYS + 1);
  age(root, RETENTION_DAYS + 1);
  fs.chmodSync(locked, 0o000);
  try {
    assert.deepEqual(sweepStaleRoots(parent, { isAlive: () => false }), []);
    assert.equal(fs.existsSync(root), true);
  } finally {
    fs.chmodSync(locked, 0o700);  // before the scratch directory is removed
  }
});

test('a child that vanishes during inspection keeps the root', t => {
  const parent = scratch(t);
  const root = path.join(parent, 'orches-999999999-VaNiSh');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  age(path.join(root, 'sub'), RETENTION_DAYS + 1);
  age(root, RETENTION_DAYS + 1);
  const real = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', target => {
    if (target === path.join(root, 'sub')) {
      const error = new Error('gone');
      error.code = 'ENOENT';
      throw error;
    }
    return real(target);
  });
  assert.deepEqual(sweepStaleRoots(parent, { isAlive: () => false }), []);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(root), true);
});

test('a root of a live process (this one included) is never swept', t => {
  const parent = scratch(t);
  const own = path.join(parent, `orches-${process.pid}-StUvWx`);
  fs.mkdirSync(own);
  age(own, RETENTION_DAYS + 1);
  assert.deepEqual(sweepStaleRoots(parent), []);
  assert.equal(fs.existsSync(own), true);
});

test('keep mode sweeps nothing, not even old finished roots', t => {
  const base = scratch(t);
  withEnv(t, { TMPDIR: base, TMP: undefined, TEMP: undefined, NULLIUS_KEEP_TEST_TMP: '1' });
  const parent = testRunsParent(base);
  fs.mkdirSync(parent, { recursive: true });
  const old = path.join(parent, 'orches-999999999-YzAbCd');
  fs.mkdirSync(old);
  age(old, RETENTION_DAYS + 30);
  const teardown = setup(fakeProject({ files: [{ result: { state: 'pass' } }] }));
  teardown();
  assert.equal(fs.existsSync(old), true);
});

test('the per-user parent must be a private directory of this user', t => {
  const base = scratch(t);
  const planted = path.join(base, 'elsewhere');
  fs.mkdirSync(planted);
  const parent = testRunsParent(base);
  fs.symlinkSync(planted, parent);  // a planted symlink is refused, never followed
  assert.throws(() => ensurePrivateParent(parent), /not a directory owned by this user/);
  fs.unlinkSync(parent);
  fs.mkdirSync(parent, { mode: 0o777 });
  fs.chmodSync(parent, 0o777);
  ensurePrivateParent(parent);  // an existing permissive directory of ours is tightened
  assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
  const real = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', target => {  // the same directory, owned by someone else
    const stat = real(target);
    return target === parent ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 }) : stat;
  });
  assert.throws(() => ensurePrivateParent(parent), /not a directory owned by this user/);
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

test('setup gives a fresh short root; teardown removes it only after a pass', t => {
  const base = scratch(t);
  withEnv(t, { TMPDIR: base, TMP: undefined, TEMP: undefined, NULLIUS_KEEP_TEST_TMP: undefined });

  const runOnce = (project, leaveFile = true) => {
    process.env.TMPDIR = base;
    const teardown = setup(project);
    const root = os.tmpdir();
    assert.ok(root.startsWith(testRunsParent(base) + path.sep), root);
    // Unix-domain sockets under TMPDIR must stay bindable (about 104 bytes on macOS): the
    // suffix is exactly /ntest-<uid>/<label<=6>-<pid>-XXXXXX (22 fixed characters at most), nothing longer.
    const uidDigits = String(process.getuid?.() ?? 'user').length;
    assert.ok(root.length - base.length <= 22 + uidDigits + String(process.pid).length, `root suffix too long: ${root}`);
    assert.equal(fs.statSync(testRunsParent(base)).mode & 0o777, 0o700, 'per-user parent is private');
    if (leaveFile) fs.writeFileSync(path.join(root, 'leftover'), 'x');
    teardown();
    assert.equal(process.env.TMPDIR, base, 'teardown restores the previous TMPDIR');
    return root;
  };

  assert.equal(fs.existsSync(runOnce(fakeProject({ files: [{ result: { state: 'pass' } }] }))), false);
  const failed = fakeProject({ files: [{ result: { state: 'fail' } }], failedTests: 1 });
  assert.equal(fs.existsSync(runOnce(failed)), true, 'failing run root is kept');
  assert.equal(fs.existsSync(runOnce(failed, false)), true, 'an empty failing run root is kept too');
  process.env.NULLIUS_KEEP_TEST_TMP = '1';
  assert.equal(fs.existsSync(runOnce(fakeProject({ files: [{ result: { state: 'pass' } }] }))), true);
});

// Real vitest runs (both majors used in this repository) through the module.
const VITEST_HOSTS = [
  ['vitest 3', path.join(repoRoot, 'packages', 'orchestrator', 'node_modules', 'vitest', 'vitest.mjs')],
  ['vitest 4', path.join(repoRoot, 'packages', 'shared', 'node_modules', 'vitest', 'vitest.mjs')],
];

function runVitest(t, bin, body) {
  const base = scratch(t);
  const project = path.join(base, 'proj');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(project);
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(project, 'vitest.config.mjs'),
    `export default { test: { globals: true, include: ['*.test.mjs'], globalSetup: [${JSON.stringify(modulePath)}] } };\n`);
  fs.writeFileSync(path.join(project, 'probe.test.mjs'), `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('probe', () => {
  fs.writeFileSync(path.join(os.tmpdir(), 'probe-root.txt'), os.tmpdir());
  ${body}
});
`);
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  delete env.NULLIUS_KEEP_TEST_TMP;
  const result = spawnSync(process.execPath, [bin, 'run', '--root', project], { env, encoding: 'utf-8' });
  const parent = testRunsParent(tmp);
  const roots = fs.existsSync(parent) ? fs.readdirSync(parent).filter(name => name !== 'README.txt') : [];
  return { result, parent, roots };
}

for (const [label, bin] of VITEST_HOSTS) {
  test(`${label}: a passing run removes its root`, { skip: !fs.existsSync(bin) && `${bin} not installed` }, t => {
    const { result, roots } = runVitest(t, bin, 'expect(1).toBe(1);');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(roots, []);
  });
  test(`${label}: a failing run keeps its root`, { skip: !fs.existsSync(bin) && `${bin} not installed` }, t => {
    const { result, parent, roots } = runVitest(t, bin, 'expect(1).toBe(2);');
    assert.notEqual(result.status, 0);
    assert.equal(roots.length, 1);
    const recorded = fs.readFileSync(path.join(parent, roots[0], 'probe-root.txt'), 'utf-8');
    assert.equal(fs.realpathSync(recorded), fs.realpathSync(path.join(parent, roots[0])),
      'tests saw the per-run root as their temporary directory');
  });
}

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
