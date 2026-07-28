import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Fault-injection seam for the randomness a decision id is built from. Every
// other node:crypto export passes through, so the rest of the runtime (hashing
// in particular) behaves normally; randomFillSync returns zeros, which makes
// the minted id fully determined by the clock and lets the reservation check
// be exercised without waiting for an 80-bit coincidence.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomFillSync: ((buffer: NodeJS.ArrayBufferView) => {
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).fill(0);
      return buffer;
    }) as typeof actual.randomFillSync,
  };
});

const fs = await import('node:fs');
const { runCli } = await import('../src/cli.js');

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stderr,
    stdout,
  };
}

// The epoch instant encodes to ten '0' characters, and zeroed randomness to
// sixteen more, so the whole minted id is known in advance.
const EPOCH_ID = '0'.repeat(26);

describe('decision id minting under a constant random source', () => {
  it('lays the id out as ten timestamp characters then sixteen random ones', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const record = makeIo(projectRoot);
      expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'minted at the epoch'], record.io)).toBe(0);
      expect(record.stdout.join('')).toContain(`recorded: ${EPOCH_ID}`);
    } finally {
      clock.mockRestore();
    }
    const line = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), 'utf-8').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ id: EPOCH_ID, ts: '1970-01-01T00:00:00Z' });
  });

  it('refuses to append a line its own reader would quarantine', async () => {
    // The pre-append self-check is unreachable through the CLI by design: the
    // clock bound rules out the one field that could drift, and every other
    // field is either a literal or validated by the predicate the reader uses.
    // An unreachable guard is indistinguishable from a no-op unless something
    // forces the condition, so inject the drift it exists for — a timestamp
    // formatter that stops producing the shape the reader accepts — and
    // require the recording to fail loudly with nothing written. Without this,
    // deleting the check would leave the suite green.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');

    const drift = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('9999-99-99T99:99:99.999Z');
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'written under a drifted timestamp'], makeIo(projectRoot).io),
      ).rejects.toThrow(/refusing to append a decision entry this ledger's own reader would quarantine/);
    } finally {
      drift.mockRestore();
    }
    // Nothing written, no lock left behind, and the ledger still records after
    // the drift is gone.
    expect(fs.existsSync(ledgerPath)).toBe(false);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
    const after = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'recorded once the formatter is sane again'], after.io)).toBe(0);
    expect(after.stdout.join('')).toMatch(/recorded: [0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}/);
  });

  it('catches the residual cross-branch collision at the merge instead of resolving it silently', async () => {
    // Uniqueness without coordination is probabilistic: two branches collide
    // only if the same millisecond AND all 80 random bits coincide. A constant
    // random source plus a pinned clock stages exactly that coincidence — each
    // branch mints into its own file, so neither can see the other's id and
    // both succeed. What must NOT happen is the merged ledger quietly
    // resolving one of them, and that is what the duplicate check is for.
    const roots = [
      fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-branch-')),
      fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-branch-')),
    ];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      for (const root of roots) {
        expect(await runCli([`--project-root=${root}`, 'init', '--runtime-only'], makeIo(root).io)).toBe(0);
        const record = makeIo(root);
        expect(await runCli([`--project-root=${root}`, 'decision', 'pending', `question raised in ${path.basename(root)}`], record.io)).toBe(0);
        expect(record.stdout.join('')).toContain(`pending: ${EPOCH_ID}`);
      }
    } finally {
      clock.mockRestore();
    }

    // Merge the two branches' ledgers, as a union merge of an append-only log
    // would.
    const mergedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-merged-'));
    expect(await runCli([`--project-root=${mergedRoot}`, 'init', '--runtime-only'], makeIo(mergedRoot).io)).toBe(0);
    const merged = roots
      .map(root => fs.readFileSync(path.join(root, '.nullius', 'decisions.jsonl'), 'utf-8'))
      .join('');
    fs.writeFileSync(path.join(mergedRoot, '.nullius', 'decisions.jsonl'), merged, 'utf-8');

    const list = makeIo(mergedRoot);
    expect(await runCli([`--project-root=${mergedRoot}`, 'decision', 'list'], list.io)).toBe(1);
    expect(list.stdout.join('')).toContain(`- "${EPOCH_ID}" on lines 1, 2`);
    await expect(
      runCli([`--project-root=${mergedRoot}`, 'decision', 'record', 'an answer', '--resolves', EPOCH_ID], makeIo(mergedRoot).io),
    ).rejects.toThrow('is ambiguous');
  });

  it('refuses to reissue an id the ledger already carries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const existing = { id: EPOCH_ID, ts: '1970-01-01T00:00:00Z', kind: 'pending', text: 'already wearing that id', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(existing)}\n`, 'utf-8');

    // Every redraw returns the same bytes, so the reserved id can never be
    // escaped: the command fails loudly instead of appending a second entry
    // with a name that is already taken.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'would collide'], makeIo(projectRoot).io),
      ).rejects.toThrow('could not mint a decision id distinct from the 1 already in the ledger after 8 attempts');
    } finally {
      clock.mockRestore();
    }
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(`${JSON.stringify(existing)}\n`);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });
});
