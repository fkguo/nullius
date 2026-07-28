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
