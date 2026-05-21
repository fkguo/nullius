/**
 * Sequence-locking tests for the five durable atomic-write primitives (P1).
 *
 * The point of these tests is NOT just to check "did it write the file" —
 * that's covered by end-to-end tests at the bottom. The point IS to lock
 * the EXACT syscall sequence so a future "optimization" cannot drop the
 * file or directory fsync and produce silently-corrupt behavior on power
 * loss.
 *
 * Each primitive registers an audit hook via `_setAtomicWriteAuditHook`
 * (test-only export) that records every fs syscall as it happens. Tests
 * then assert the recorded event list matches the expected sequence.
 *
 * Expected sequence (matching `run-manifest.ts:82-97`):
 *
 *   writeBytesAtomicDurable / writeJsonAtomicDurable / writeExecutableAtomicDurable:
 *     mkdir (dirname) → open (tmp, 'w', mode?) → write → [fchmod (mode)]
 *     → fsync (fd) → close (fd) → rename (tmp → final)
 *     → open (dirname, 'r') → fsync (dirFd) → close (dirFd)
 *
 *   appendJsonlDurable:
 *     mkdir (dirname) → open (final, 'a') → write → fsync (fd) → close (fd)
 *     → open (dirname, 'r') → fsync (dirFd) → close (dirFd)
 *
 *   commitStagedDurable:
 *     rename (staged → final) → open (dirname, 'r') → fsync (dirFd) → close (dirFd)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setAtomicWriteAuditHook,
  appendJsonlDurable,
  commitStagedDurable,
  type AtomicWriteAuditEvent,
  writeBytesAtomicDurable,
  writeExecutableAtomicDurable,
  writeJsonAtomicDurable,
} from '../atomic-write.js';

function setupRecorder(): { log: AtomicWriteAuditEvent[]; restore: () => void } {
  const log: AtomicWriteAuditEvent[] = [];
  const restore = _setAtomicWriteAuditHook(event => log.push(event));
  return { log, restore };
}

function kinds(log: AtomicWriteAuditEvent[]): string[] {
  return log.map(e => e.kind);
}

describe('writeBytesAtomicDurable — sequence lock', () => {
  let tmp: string;
  let rec: { log: AtomicWriteAuditEvent[]; restore: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-seq-bytes-'));
    rec = setupRecorder();
  });
  afterEach(() => {
    rec.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('default (no mode): mkdir → open(w) → write → fsync(fd) → close → rename → open(r) → fsync(dir) → close', () => {
    writeBytesAtomicDurable(path.join(tmp, 'a/b/state.json'), 'payload');
    expect(kinds(rec.log)).toEqual([
      'mkdir',
      'open',     // tmp 'w'
      'write',
      'fsync',    // file fd
      'close',    // file fd
      'rename',
      'open',     // dir 'r'
      'fsync',    // dir fd
      'close',    // dir fd
    ]);
  });

  it('with mode: inserts fchmod BEFORE fsync(fd) and passes mode to openSync', () => {
    writeBytesAtomicDurable(path.join(tmp, 'launcher'), 'script', 0o700);
    expect(kinds(rec.log)).toEqual([
      'mkdir',
      'open',
      'write',
      'fchmod',   // mode enforced before fsync
      'fsync',
      'close',
      'rename',
      'open',
      'fsync',
      'close',
    ]);
    const openTmp = rec.log.find(e => e.kind === 'open') as Extract<AtomicWriteAuditEvent, { kind: 'open' }>;
    expect(openTmp.mode).toBe(0o700);
    expect(openTmp.flags).toBe('w');
  });

  it('directory fsync uses "r" flag (not "w")', () => {
    writeBytesAtomicDurable(path.join(tmp, 'state.json'), 'payload');
    const opens = rec.log.filter((e): e is Extract<AtomicWriteAuditEvent, { kind: 'open' }> => e.kind === 'open');
    expect(opens[0].flags).toBe('w');  // tmp file
    expect(opens[1].flags).toBe('r');  // dir fsync
  });
});

describe('writeJsonAtomicDurable — wraps bytes-write with stringification', () => {
  let tmp: string;
  let rec: { log: AtomicWriteAuditEvent[]; restore: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-seq-json-'));
    rec = setupRecorder();
  });
  afterEach(() => {
    rec.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('inherits the bytes-write sequence', () => {
    writeJsonAtomicDurable(path.join(tmp, 'x.json'), { ok: true });
    expect(kinds(rec.log)).toEqual([
      'mkdir', 'open', 'write', 'fsync', 'close',
      'rename', 'open', 'fsync', 'close',
    ]);
  });

  it('default stringify produces indent=2 + trailing newline', () => {
    const file = path.join(tmp, 'x.json');
    writeJsonAtomicDurable(file, { z: 1, a: 2 });
    expect(fs.readFileSync(file, 'utf-8')).toBe(JSON.stringify({ z: 1, a: 2 }, null, 2) + '\n');
  });

  it('respects custom stringify (for sort-keys parity callers)', () => {
    const file = path.join(tmp, 'x.json');
    writeJsonAtomicDurable(file, { z: 1, a: 2 }, p => JSON.stringify(p) /* compact */);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"z":1,"a":2}');
  });
});

describe('appendJsonlDurable — sequence lock', () => {
  let tmp: string;
  let rec: { log: AtomicWriteAuditEvent[]; restore: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-seq-append-'));
    rec = setupRecorder();
  });
  afterEach(() => {
    rec.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits sequence: mkdir → open(a) → write → fsync(fd) → close → open(dir,r) → fsync(dir) → close', () => {
    appendJsonlDurable(path.join(tmp, 'ledger.jsonl'), { event: 'created' });
    expect(kinds(rec.log)).toEqual([
      'mkdir',
      'open',     // 'a' on the ledger
      'write',
      'fsync',    // file fd
      'close',    // file fd
      'open',     // 'r' on dir
      'fsync',    // dir fd
      'close',    // dir fd
    ]);
    const opens = rec.log.filter((e): e is Extract<AtomicWriteAuditEvent, { kind: 'open' }> => e.kind === 'open');
    expect(opens[0].flags).toBe('a');
    expect(opens[1].flags).toBe('r');
  });

  it('writes JSON + trailing newline', () => {
    const file = path.join(tmp, 'ledger.jsonl');
    appendJsonlDurable(file, { event: 'x' });
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"event":"x"}\n');
  });
});

describe('writeExecutableAtomicDurable — sequence + 0o700 at create', () => {
  let tmp: string;
  let rec: { log: AtomicWriteAuditEvent[]; restore: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-seq-exec-'));
    rec = setupRecorder();
  });
  afterEach(() => {
    rec.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('passes 0o700 to openSync at create AND enforces via fchmod', () => {
    writeExecutableAtomicDurable(path.join(tmp, 'bin/launcher'), '#!/bin/sh\necho hi\n');
    expect(kinds(rec.log)).toEqual([
      'mkdir',
      'open',
      'write',
      'fchmod',
      'fsync',
      'close',
      'rename',
      'open',
      'fsync',
      'close',
    ]);
    const openTmp = rec.log.find(e => e.kind === 'open') as Extract<AtomicWriteAuditEvent, { kind: 'open' }>;
    expect(openTmp.mode).toBe(0o700);
    const chmod = rec.log.find(e => e.kind === 'fchmod') as Extract<AtomicWriteAuditEvent, { kind: 'fchmod' }>;
    expect(chmod.mode).toBe(0o700);
  });
});

describe('commitStagedDurable — rename-only with parent-dir fsync', () => {
  let tmp: string;
  let rec: { log: AtomicWriteAuditEvent[]; restore: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-seq-commit-'));
    rec = setupRecorder();
  });
  afterEach(() => {
    rec.restore();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('emits sequence: rename → open(dir,r) → fsync(dir) → close', () => {
    const staged = path.join(tmp, 'state.json.next');
    const final = path.join(tmp, 'state.json');
    fs.writeFileSync(staged, '{}'); // staged file must exist
    commitStagedDurable(staged, final);
    expect(kinds(rec.log)).toEqual([
      'rename',
      'open',     // dir 'r'
      'fsync',    // dir fd
      'close',
    ]);
  });

  it('throws on cross-parent rename (precondition)', () => {
    expect(() =>
      commitStagedDurable('/a/state.next', '/b/state'),
    ).toThrow(/share the same parent directory/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end behavioral tests — confirm the primitives actually
// write the right bytes to disk. Complements the sequence locks above.
// ─────────────────────────────────────────────────────────────────────────────
describe('end-to-end behavior', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-e2e-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('writeBytesAtomicDurable writes the correct bytes', () => {
    const file = path.join(tmp, 'a/b/c.bin');
    writeBytesAtomicDurable(file, Buffer.from([0x01, 0x02, 0x03]));
    expect(fs.readFileSync(file)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  it('writeBytesAtomicDurable respects mode (0o600)', () => {
    const file = path.join(tmp, 'mode.bin');
    writeBytesAtomicDurable(file, 'private', 0o600);
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writeBytesAtomicDurable cleans up tmp on rename failure', () => {
    const file = path.join(tmp, 'readonly', 'target.bin');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.chmodSync(path.dirname(file), 0o500);
    try {
      try {
        writeBytesAtomicDurable(file, 'payload');
      } catch { /* expected on most systems */ }
      const stragglers = fs.readdirSync(path.dirname(file)).filter(n => n.includes('.tmp.'));
      expect(stragglers).toEqual([]);
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
  });

  it('appendJsonlDurable appends multiple lines preserving order', () => {
    const file = path.join(tmp, 'ledger.jsonl');
    appendJsonlDurable(file, { i: 1 });
    appendJsonlDurable(file, { i: 2 });
    appendJsonlDurable(file, { i: 3 });
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"i":1}\n{"i":2}\n{"i":3}\n');
  });

  it('writeExecutableAtomicDurable creates 0o700 file with script content', () => {
    const file = path.join(tmp, 'bin/launcher');
    writeExecutableAtomicDurable(file, '#!/bin/sh\necho hi\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('#!/bin/sh\necho hi\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o700);
  });

  it('commitStagedDurable promotes staged file to final', () => {
    const staged = path.join(tmp, 'state.json.next');
    const final = path.join(tmp, 'state.json');
    writeBytesAtomicDurable(staged, JSON.stringify({ x: 1 }));
    commitStagedDurable(staged, final);
    expect(fs.existsSync(staged)).toBe(false);
    expect(JSON.parse(fs.readFileSync(final, 'utf-8'))).toEqual({ x: 1 });
  });

  it('audit hook restore() correctly removes the hook', () => {
    const log: AtomicWriteAuditEvent[] = [];
    const restore = _setAtomicWriteAuditHook(e => log.push(e));
    writeBytesAtomicDurable(path.join(tmp, 'f1.txt'), 'a');
    expect(log.length).toBeGreaterThan(0);
    restore();
    log.length = 0;
    writeBytesAtomicDurable(path.join(tmp, 'f2.txt'), 'b');
    expect(log.length).toBe(0); // hook removed
  });
});
