// Per-run temporary root for the vitest suites (wired as `globalSetup` in
// every package's vitest config).
//
// Before any worker starts, TMPDIR/TMP/TEMP are pointed at one fresh
// directory <original tmpdir>/ntest-<uid>/<package[:6]>-<pid>-XXXXXX (per
// user, so a shared /tmp never mixes owners), so every os.tmpdir() call in
// tests (and in child processes they spawn) lands inside it. The names are
// deliberately short: tools create Unix-domain sockets under TMPDIR, and a
// socket path longer than about 104 bytes (macOS) cannot be bound. At teardown
// the root is removed only when the run is known to have passed; a failing,
// interrupted, or unreadable run keeps it for inspection, even when empty.
// Kept roots whose newest entry is older than the retention window, and whose
// creating process is no longer alive, are swept when a later run starts.
// NULLIUS_KEEP_TEST_TMP=1 keeps every root: the run's own and, since no sweep
// runs in that mode, every earlier one.
//
// Cleanup problems never fail a test run: they are reported on stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_RUNS_PARENT_PREFIX = 'ntest';
const PARENT_README = 'Per-run temporary roots of the nullius test suites '
  + '(scripts/lib/vitest-test-temp-root.mjs). A passing run removes its root; a failing run keeps it, '
  + 'and roots unchanged for 7 days whose creating process has exited are removed by a later run. '
  + 'NULLIUS_KEEP_TEST_TMP=1 keeps every root.\n';

/** Create (or accept) the per-user parent only as a real directory owned by
 *  this user with mode 0700; a planted symlink or someone else's directory
 *  in a shared /tmp is refused rather than used. */
export function ensurePrivateParent(parent) {
  try {
    fs.mkdirSync(parent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(parent);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    throw new Error(`[test-temp-root] ${parent} is not a directory owned by this user; refusing to use it`);
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(parent, 0o700);
  return parent;
}

export function testRunsParent(baseTmp = os.tmpdir()) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(baseTmp, `${TEST_RUNS_PARENT_PREFIX}-${uid}`);
}
export const RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Only directories this module created are ever swept; the pid of the run
// that created a root is part of its name.
const ROOT_NAME_PATTERN = /^[A-Za-z0-9._]{1,6}-(\d+)-[A-Za-z0-9]{6}$/;

/** True when a process with this pid exists (a live watch session keeps its
 *  root however long it idles; a reused pid only delays the sweep). */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function warn(message) {
  process.stderr.write(`[test-temp-root] ${message}\n`);
}

/** Remove a tree; on permission errors (tests that chmod directories
 *  read-only for fault injection) restore owner write bits and retry once. */
export function removeTree(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    try {
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop();
        let stat;
        try {
          stat = fs.lstatSync(dir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        try {
          fs.chmodSync(dir, 0o700);
        } catch {
          // keep going; the retry below reports what could not be removed
        }
        for (const entry of fs.readdirSync(dir)) stack.push(path.join(dir, entry));
      }
      fs.rmSync(root, { recursive: true, force: true });
      return true;
    } catch (error) {
      warn(`could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

/** Newest modification time anywhere in a tree (the tree itself included).
 *  Anything that cannot be read counts as just modified (Infinity), so a
 *  tree that cannot be fully inspected is never judged old. */
export function newestMtime(root) {
  let newest = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return Infinity;  // vanished or unreadable meanwhile: something is still happening here
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return Infinity;
    }
    for (const entry of entries) stack.push(path.join(current, entry));
  }
  return newest;
}

/** Delete kept run roots under `parent` in which nothing has been modified
 *  for longer than the retention window. Returns the removed paths. */
export function sweepStaleRoots(parent, { now = Date.now(), retentionDays = RETENTION_DAYS, isAlive = processAlive } = {}) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const match = entry.isDirectory() ? ROOT_NAME_PATTERN.exec(entry.name) : null;
    if (!match) continue;
    if (isAlive(Number(match[1]))) continue;
    const full = path.join(parent, entry.name);
    if (now - newestMtime(full) > retentionDays * DAY_MS && removeTree(full)) removed.push(full);
  }
  return removed;
}

/** True only when the vitest state positively reports a clean run. Any
 *  missing accessor (an API change) counts as "not known to have passed",
 *  so the root is kept rather than deleted. */
export function runPassed(project) {
  try {
    const state = project?.vitest?.state;
    if (!state
      || typeof state.getCountOfFailedTests !== 'function'
      || typeof state.getFailedFilepaths !== 'function'
      || typeof state.getUnhandledErrors !== 'function'
      || typeof state.getFiles !== 'function') {
      return false;
    }
    const files = state.getFiles();
    if (files.length === 0) return false;
    const everyFileFinished = files.every(file => ['pass', 'skip', 'todo'].includes(file?.result?.state)
      || file?.mode === 'skip' || file?.mode === 'todo');
    return everyFileFinished
      && state.getCountOfFailedTests() === 0
      && state.getFailedFilepaths().length === 0
      && state.getUnhandledErrors().length === 0;
  } catch {
    return false;
  }
}

export default function setup(project) {
  const parent = ensurePrivateParent(testRunsParent());
  try {
    fs.writeFileSync(path.join(parent, 'README.txt'), PARENT_README, { flag: 'wx' });
  } catch {
    // already present
  }
  if (process.env.NULLIUS_KEEP_TEST_TMP !== '1') sweepStaleRoots(parent);

  const label = path.basename(project?.config?.root ?? process.cwd()).replace(/[^A-Za-z0-9._]/g, '').slice(0, 6) || 'tests';
  const root = fs.mkdtempSync(path.join(parent, `${label}-${process.pid}-`));
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (process.env.NULLIUS_KEEP_TEST_TMP === '1') {
      warn(`kept ${root} (NULLIUS_KEEP_TEST_TMP=1)`);
      return;
    }
    if (!runPassed(project)) {
      warn(`run did not pass; kept ${root} (swept after ${RETENTION_DAYS} days without changes)`);
      return;
    }
    removeTree(root);
  };
}
