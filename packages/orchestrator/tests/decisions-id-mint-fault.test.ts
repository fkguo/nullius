import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const randomState = vi.hoisted(() => ({ byte: 0, outputs: [] as number[][] }));

// Fault-injection seam for the randomness a decision handle is built from. Every
// other node:crypto export passes through, so the rest of the runtime (hashing
// in particular) behaves normally; randomFillSync returns a selected constant
// byte, which makes the six-character handle deterministic and lets the
// reservation check be exercised without waiting for a 30-bit coincidence.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomFillSync: ((buffer: NodeJS.ArrayBufferView) => {
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const output = randomState.outputs.shift();
      if (output) view.set(output);
      else view.fill(randomState.byte);
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

const ZERO_HANDLE = '000000';

describe('decision handle minting under a constant random source', () => {
  beforeEach(() => {
    randomState.byte = 0;
    randomState.outputs = [];
  });

  it('mints six random Crockford characters without embedding the clock', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);

    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const record = makeIo(projectRoot);
      expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'minted at the epoch'], record.io)).toBe(0);
      expect(record.stdout.join('')).toContain(`recorded: ${ZERO_HANDLE}`);
    } finally {
      clock.mockRestore();
    }
    const line = JSON.parse(fs.readFileSync(path.join(projectRoot, '.nullius', 'decisions.jsonl'), 'utf-8').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ id: ZERO_HANDLE, ts: '1970-01-01T00:00:00.000Z' });
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
    expect(after.stdout.join('')).toMatch(/recorded: [0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}/);
  });

  it('redraws a six-character candidate that also spells a durable D<n> id', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);
    // These 30 bits encode D12345. The next draw is all zeros.
    randomState.outputs = [[26, 17, 12, 133], [0, 0, 0, 0]];
    const record = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'namespace boundary'], record.io)).toBe(0);
    expect(record.stdout.join('')).toContain(`recorded: ${ZERO_HANDLE}`);
    expect(record.stdout.join('')).not.toContain('D12345');
  });

  it('catches the residual cross-branch collision at the merge instead of resolving it silently', async () => {
    // Uniqueness without coordination is probabilistic. A constant random
    // source stages a 30-bit handle coincidence — each
    // branch mints into its own file, so neither can see the other's id and
    // both succeed. What must NOT happen is the merged ledger quietly
    // resolving one of them, and that is what the duplicate check is for.
    const roots = [
      fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-branch-')),
      fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-branch-')),
    ];
    const clock = vi.spyOn(Date, 'now');
    try {
      for (const root of roots) {
        expect(await runCli([`--project-root=${root}`, 'init', '--runtime-only'], makeIo(root).io)).toBe(0);
      }
      clock.mockReturnValue(0);
      for (const root of roots) {
        const record = makeIo(root);
        expect(await runCli([`--project-root=${root}`, 'decision', 'pending', `question raised in ${path.basename(root)}`], record.io)).toBe(0);
        expect(record.stdout.join('')).toContain(`pending: ${ZERO_HANDLE}`);
      }
      // One branch resolves its local copy before the other branch's colliding
      // pending line is merged after it. A one-pass replay used to accept this
      // resolution before discovering the later duplicate.
      clock.mockReturnValue(1);
      randomState.byte = 1;
      const answer = makeIo(roots[0]!);
      expect(
        await runCli(
          [`--project-root=${roots[0]}`, 'decision', 'record', 'answer recorded on branch one', '--resolves', ZERO_HANDLE],
          answer.io,
        ),
      ).toBe(0);
      expect(answer.stdout.join('')).toContain(`resolved: ${ZERO_HANDLE}`);
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
    expect(await runCli([`--project-root=${mergedRoot}`, 'decision', 'list', '--json'], list.io)).toBe(1);
    const parsed = JSON.parse(list.stdout.join('')) as {
      duplicate_ids: Array<{ id: string; lines: number[] }>;
      invalid_lines: number;
      open_ids: string[];
      records: Array<{ id: string; kind: string }>;
    };
    expect(parsed.duplicate_ids).toEqual([{ id: ZERO_HANDLE, lines: [1, 3] }]);
    expect(parsed.invalid_lines).toBe(2);
    expect(parsed.open_ids).toEqual([ZERO_HANDLE]);
    expect(parsed.records).toEqual([
      expect.objectContaining({ id: ZERO_HANDLE, kind: 'pending' }),
    ]);

    const status = makeIo(mergedRoot);
    expect(await runCli([`--project-root=${mergedRoot}`, 'status', '--json'], status.io)).toBe(0);
    expect((JSON.parse(status.stdout.join('')) as { decision_ledger: Record<string, unknown> }).decision_ledger)
      .toMatchObject({ open_count: 1, decided_count: 0, invalid_lines: 2, duplicate_id_count: 1 });
    await expect(
      runCli([`--project-root=${mergedRoot}`, 'decision', 'record', 'an answer', '--resolves', ZERO_HANDLE], makeIo(mergedRoot).io),
    ).rejects.toThrow('is ambiguous');
  });

  it('refuses to reissue an id the ledger already carries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const existing = { id: ZERO_HANDLE, ts: '1970-01-01T00:00:00Z', kind: 'pending', text: 'already wearing that id', by: 'user', resolves: null };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(existing)}\n`, 'utf-8');

    // Every redraw returns the same bytes, so the reserved id can never be
    // escaped: the command fails loudly instead of appending a second entry
    // with a name that is already taken.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'would collide'], makeIo(projectRoot).io),
      ).rejects.toThrow('could not mint a provisional decision handle distinct from the 1 ids already in the ledger after 8 attempts');
    } finally {
      clock.mockRestore();
    }
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(`${JSON.stringify(existing)}\n`);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  it('refuses to mint a handle still retained as a landed-entry alias', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mint-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);
    const ledgerPath = path.join(projectRoot, '.nullius', 'decisions.jsonl');
    const landed = {
      id: 'D1',
      provisional_id: ZERO_HANDLE,
      ts: '1970-01-01T00:00:00Z',
      kind: 'decided',
      text: 'already landed from that handle',
      by: 'user',
      resolves: null,
    };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(landed)}\n`, 'utf-8');

    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await expect(
        runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'would reuse a live alias'], makeIo(projectRoot).io),
      ).rejects.toThrow('could not mint a provisional decision handle distinct from the 2 ids already in the ledger after 8 attempts');
    } finally {
      clock.mockRestore();
    }
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(`${JSON.stringify(landed)}\n`);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });
});
