/**
 * Durable atomic file writes (P1).
 *
 * Provides five primitives that guarantee POSIX-correct durability against
 * crash / power-loss between syscalls — the gold-standard pattern already
 * proven in `packages/orchestrator/src/run-manifest.ts:82-97` (Batch 8 R2
 * fix). Lifted into `@autoresearch/shared` so every package that writes
 * artifacts can converge on one byte-accurate, sequence-verified
 * implementation rather than the half-fsync'd helpers that previously
 * lived in `orchestrator/computation/io.ts` and
 * `hep-mcp/core/atomicWrite.ts`.
 *
 * ## The sequence (matches `run-manifest.ts:82-97`)
 *
 *   1. mkdirSync(dirname, recursive)
 *   2. fd = openSync(tmp, 'w', mode ?? 0o644)
 *   3. writeFileSync(fd, bytes)          // full-write guarantee via fd path
 *   4. fchmodSync(fd, mode) if mode supplied   // close the umask-clip gap
 *   5. fsyncSync(fd)                     // file contents to disk
 *   6. closeSync(fd)
 *   7. renameSync(tmp, final)            // atomic rename
 *   8. dirFd = openSync(dirname, 'r')
 *   9. fsyncSync(dirFd)                  // directory entry persisted
 *   10. closeSync(dirFd)
 *
 * On any error: partial tmp file is unlinked best-effort. The unlink is
 * intentionally best-effort because the caller has bigger problems if it
 * fires (the throw propagates up).
 *
 * ## Why ALL five primitives?
 *
 * - {@link writeBytesAtomicDurable}: the generic byte / string write. Used
 *   for binary artifacts, executable scripts, text rollback restores.
 * - {@link writeJsonAtomicDurable}: typed wrapper that handles JSON
 *   stringification. The default stringify is non-sorting; callers needing
 *   Python-`sort_keys=True` byte-equality pass `sortKeysRecursive`
 *   themselves via the `stringify` argument.
 * - {@link appendJsonlDurable}: append-only with file+dir fsync. Designed
 *   for ledgers and other append-only logs where each append must survive
 *   crash before the next syscall.
 * - {@link writeExecutableAtomicDurable}: mode-at-create wrapper for
 *   executable scripts. Closes the chmod-after-write race that allowed
 *   another process to exec a half-written launcher.
 * - {@link commitStagedDurable}: rename-only commit for callers that have
 *   already written and fsync'd the staged file themselves and only need
 *   the rename to be persisted to the directory entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Instrumentation hook used by tests to lock the EXACT syscall sequence
 * of each primitive (mkdir → open → write → fsync(fd) → close → rename →
 * open(dir,r) → fsync(dirFd) → close). Production code never sets this.
 *
 * The audit hook is opt-in and fires AFTER each operation completes — it
 * cannot alter behavior, only record. Sequence-locking tests register a
 * recorder, run a primitive, then assert the recorded event list matches
 * the expected order.
 *
 * `vi.spyOn(fs, ...)` doesn't work reliably on Node's ESM `node:fs`
 * namespace export in vitest, hence this explicit instrumentation point.
 */
export type AtomicWriteAuditEvent =
  | { kind: 'mkdir'; path: string }
  | { kind: 'open'; path: string; flags: string; mode?: number; fd: number }
  | { kind: 'write'; fd: number; bytes: number }
  | { kind: 'fchmod'; fd: number; mode: number }
  | { kind: 'fsync'; fd: number }
  | { kind: 'close'; fd: number }
  | { kind: 'rename'; from: string; to: string };

export type AtomicWriteAudit = (event: AtomicWriteAuditEvent) => void;

let _audit: AtomicWriteAudit | undefined;

/**
 * Test-only: install an audit hook that records every fs syscall the
 * primitives make. Returns a `restore` callback that removes the hook.
 * Calling this from production code is a contract violation.
 */
export function _setAtomicWriteAuditHook(hook: AtomicWriteAudit | undefined): () => void {
  const prev = _audit;
  _audit = hook;
  return () => { _audit = prev; };
}

function audit(event: AtomicWriteAuditEvent): void {
  if (_audit) _audit(event);
}

/**
 * Generate a tmp-file path adjacent to the final path. Uses the process
 * PID so two concurrent processes don't collide on the same tmp slot.
 *
 * The tmp file lives in the SAME directory as the final path so the
 * subsequent `renameSync` is guaranteed-atomic (POSIX same-fs).
 */
function makeTmpPath(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${Date.now()}`;
}

/**
 * fsync the parent directory of `filePath`. Required after `renameSync`
 * to guarantee the new directory entry survives a crash on POSIX
 * filesystems (ext4/xfs/btrfs/APFS).
 *
 * Opens with `'r'` because directory-fsync only needs read access on
 * Linux/macOS; `'w'` would fail with EISDIR on most systems.
 */
/**
 * fsync the parent directory of `filePath`. Required after `renameSync`
 * to guarantee the new directory entry survives a crash on POSIX
 * filesystems (ext4/xfs/btrfs/APFS).
 *
 * Opens with `'r'` because directory-fsync only needs read access on
 * Linux/macOS; `'w'` would fail with EISDIR on most systems.
 *
 * **Windows note**: opening a directory + `FlushFileBuffers` is
 * undefined on NTFS and returns ERROR_ACCESS_DENIED. This codebase
 * targets macOS + Linux (the autoresearch project's CI matrix), and
 * Node.js itself documents `fsync` on a directory fd as
 * platform-dependent. If a Windows port is ever added, gate this on
 * `process.platform`.
 */
function fsyncParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  const dirFd = fs.openSync(dir, 'r');
  audit({ kind: 'open', path: dir, flags: 'r', fd: dirFd });
  try {
    fs.fsyncSync(dirFd);
    audit({ kind: 'fsync', fd: dirFd });
  } finally {
    fs.closeSync(dirFd);
    audit({ kind: 'close', fd: dirFd });
  }
}

/**
 * Primitive 1: durable atomic byte/string write.
 *
 * Writes `bytes` to `filePath` with full POSIX durability:
 * write tmp → fsync(fd) → rename → fsync(dirFd). Caller-supplied `mode`
 * is set at file create AND enforced via `fchmodSync` before fsync
 * (defends against umask clipping AND closes the post-rename chmod race
 * that would let another process exec a partial file with the wrong mode).
 *
 * On error, the tmp file is unlinked best-effort.
 *
 * @example
 * writeBytesAtomicDurable('/p/state.json', Buffer.from(json), 0o600);
 */
export function writeBytesAtomicDurable(
  filePath: string,
  bytes: Buffer | string,
  mode?: number,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  audit({ kind: 'mkdir', path: dir });
  const tmpPath = makeTmpPath(filePath);
  const flags = 'w';
  // Pass mode to openSync so the file is created with the target mode
  // bits AT CREATE TIME, eliminating the window where another process
  // could observe a more-permissive file before chmod.
  const fd = mode !== undefined
    ? fs.openSync(tmpPath, flags, mode)
    : fs.openSync(tmpPath, flags);
  audit({ kind: 'open', path: tmpPath, flags, mode, fd });
  const byteLen = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  try {
    fs.writeFileSync(fd, bytes);
    audit({ kind: 'write', fd, bytes: byteLen });
    if (mode !== undefined) {
      // Belt-and-suspenders: even though openSync(mode) sets bits at
      // create, umask may clip them. fchmodSync forces the exact mode.
      fs.fchmodSync(fd, mode);
      audit({ kind: 'fchmod', fd, mode });
    }
    fs.fsyncSync(fd);
    audit({ kind: 'fsync', fd });
  } catch (err) {
    try { fs.closeSync(fd); audit({ kind: 'close', fd }); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
  try {
    fs.closeSync(fd);
    audit({ kind: 'close', fd });
  } catch (closeErr) {
    // Extremely rare (EIO on flush-during-close). Best-effort cleanup of
    // the tmp file so it doesn't accumulate on disk, then surface the
    // original error.
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw closeErr;
  }
  try {
    fs.renameSync(tmpPath, filePath);
    audit({ kind: 'rename', from: tmpPath, to: filePath });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
  fsyncParentDir(filePath);
}

/**
 * Primitive 2: durable atomic JSON write.
 *
 * Wraps {@link writeBytesAtomicDurable} with JSON stringification. The
 * default stringify emits `JSON.stringify(payload, null, 2) + '\n'`
 * (pretty-printed, trailing newline). Callers that need a stable
 * sort-keys representation (e.g. Python parity) pass their own
 * `stringify` such as:
 *
 *     writeJsonAtomicDurable(
 *       path,
 *       payload,
 *       p => JSON.stringify(sortKeysRecursive(p), null, 2) + '\n',
 *     )
 *
 * `sortKeysRecursive` is exported from `@autoresearch/shared/utils`.
 */
export function writeJsonAtomicDurable(
  filePath: string,
  payload: unknown,
  stringify?: (payload: unknown) => string,
): void {
  const content = stringify
    ? stringify(payload)
    : JSON.stringify(payload, null, 2) + '\n';
  writeBytesAtomicDurable(filePath, content);
}

/**
 * Primitive 3: durable JSON-Lines append.
 *
 * Appends one line (JSON-stringified, then `\n`) to `filePath`. Each
 * append is durable: write → fsync(fd) → close → fsync(dirFd). Designed
 * for ledgers and other append-only logs that must survive crash
 * between syscalls.
 *
 * Unlike the write primitives, this never uses a tmp+rename — append is
 * inherently in-place. The directory fsync is still required because a
 * newly-created file's directory entry must be persisted (and is cheap
 * for already-existing files).
 *
 * @example
 * appendJsonlDurable('/p/ledger.jsonl', { ts: now, event: 'created' });
 */
export function appendJsonlDurable(
  filePath: string,
  lineObject: unknown,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  audit({ kind: 'mkdir', path: dir });
  const line = JSON.stringify(lineObject) + '\n';
  const fd = fs.openSync(filePath, 'a');
  audit({ kind: 'open', path: filePath, flags: 'a', fd });
  try {
    fs.writeFileSync(fd, line);
    audit({ kind: 'write', fd, bytes: Buffer.byteLength(line) });
    fs.fsyncSync(fd);
    audit({ kind: 'fsync', fd });
  } catch (err) {
    try { fs.closeSync(fd); audit({ kind: 'close', fd }); } catch { /* best-effort */ }
    throw err;
  }
  fs.closeSync(fd);
  audit({ kind: 'close', fd });
  fsyncParentDir(filePath);
}

/**
 * Primitive 4: durable atomic executable-script write.
 *
 * Convenience wrapper over {@link writeBytesAtomicDurable} with
 * `mode = 0o700` enforced at create. Used for project-local launcher
 * scripts and similar; closes the chmod-after-write race that allowed
 * a peer process to `exec` a partial file with wrong mode bits.
 *
 * `0o700` (owner read/write/execute, no group/other) is the safe default
 * — these scripts are user-local and have no scenario requiring
 * other-execute access. Override only if a documented multi-user case
 * justifies it.
 */
export function writeExecutableAtomicDurable(
  filePath: string,
  script: string,
): void {
  writeBytesAtomicDurable(filePath, script, 0o700);
}

/**
 * Primitive 5: durable commit of a previously-written staged file.
 *
 * Used when the caller has already written `stagedPath` durably (via
 * one of the write primitives above) and only needs to rename it to
 * `finalPath` with parent-dir fsync. This separates "write the staged
 * file" from "commit the rename" so callers can interleave additional
 * work (e.g. append a ledger event for the state change) BETWEEN the
 * staged write and the final commit while preserving durability of each.
 *
 * Precondition (caller contract): `stagedPath` must already exist on
 * disk, must be fsync'd, and must share the same parent directory as
 * `finalPath` (so the rename is same-fs and atomic).
 *
 * Runtime guard: throws if `dirname(stagedPath) !== dirname(finalPath)`.
 *
 * @example
 * writeJsonAtomicDurable(stagedPath, state);  // staged write
 * appendJsonlDurable(ledgerPath, event);       // ledger event
 * commitStagedDurable(stagedPath, finalPath); // commit the rename
 */
export function commitStagedDurable(
  stagedPath: string,
  finalPath: string,
): void {
  const stagedDir = path.dirname(stagedPath);
  const finalDir = path.dirname(finalPath);
  if (stagedDir !== finalDir) {
    throw new Error(
      `commitStagedDurable: stagedPath and finalPath must share the same parent directory; staged=${stagedDir} final=${finalDir}`,
    );
  }
  fs.renameSync(stagedPath, finalPath);
  audit({ kind: 'rename', from: stagedPath, to: finalPath });
  fsyncParentDir(finalPath);
}
