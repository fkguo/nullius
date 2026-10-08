// Per-run temporary root for the vitest suites (wired as `globalSetup` in
// every package's vitest config).
//
// Before any worker starts, TMPDIR/TMP/TEMP are pointed at one fresh
// directory <original tmpdir>/nullius-test-runs/<package>-<utc>-<pid>-XXXXXX,
// so every os.tmpdir() call in tests (and in child processes they spawn)
// lands inside it. At teardown the root is removed only when the run is
// known to have passed; a failing, interrupted, or unreadable run keeps it
// for inspection. Kept roots older than the retention window are swept when
// a later run starts. NULLIUS_KEEP_TEST_TMP=1 keeps the root regardless.
//
// Cleanup problems never fail a test run: they are reported on stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_RUNS_PARENT_NAME = 'nullius-test-runs';
export const RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Only directories this module created are ever swept.
const ROOT_NAME_PATTERN = /^[A-Za-z0-9._-]+-\d{8}T\d{6}Z-\d+-[A-Za-z0-9]{6}$/;

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

/** Delete kept run roots under `parent` whose modification time is older
 *  than the retention window. Returns the removed paths. */
export function sweepStaleRoots(parent, { now = Date.now(), retentionDays = RETENTION_DAYS } = {}) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !ROOT_NAME_PATTERN.test(entry.name)) continue;
    const full = path.join(parent, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > retentionDays * DAY_MS && removeTree(full)) removed.push(full);
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

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export default function setup(project) {
  const originalTmp = os.tmpdir();
  const parent = path.join(originalTmp, TEST_RUNS_PARENT_NAME);
  fs.mkdirSync(parent, { recursive: true });
  sweepStaleRoots(parent);

  const label = path.basename(project?.config?.root ?? process.cwd()).replace(/[^A-Za-z0-9._-]/g, '-') || 'tests';
  const root = fs.mkdtempSync(path.join(parent, `${label}-${utcStamp()}-${process.pid}-`));
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
      let empty = false;
      try {
        empty = fs.readdirSync(root).length === 0;
      } catch {
        empty = false;
      }
      if (empty) {
        removeTree(root);
        return;
      }
      warn(`run did not pass; kept ${root} (swept after ${RETENTION_DAYS} days)`);
      return;
    }
    removeTree(root);
  };
}
