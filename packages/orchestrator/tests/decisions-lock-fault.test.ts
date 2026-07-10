import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Fault-injection seam: pass every node:fs call through so the suite behaves
// normally, but let one test make writeSync fail exactly once to prove the
// freshly created lock is not orphaned when its metadata write dies.
let failNextLockWrite = false;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      if (failNextLockWrite) {
        failNextLockWrite = false;
        throw new Error('injected lock metadata write failure');
      }
      return actual.writeSync(...args);
    }) as typeof actual.writeSync,
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

describe('decision lock fault injection', () => {
  it('removes its own fresh lock when the metadata write fails', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-lock-fault-'));
    expect(await runCli([`--project-root=${projectRoot}`, 'init', '--runtime-only'], makeIo(projectRoot).io)).toBe(0);

    failNextLockWrite = true;
    await expect(
      runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'dies during lock setup'], makeIo(projectRoot).io),
    ).rejects.toThrow('injected lock metadata write failure');
    // The half-initialized lock must not survive to block the next recording.
    expect(fs.existsSync(path.join(projectRoot, '.nullius', 'decisions.jsonl.lock'))).toBe(false);

    const retry = makeIo(projectRoot);
    expect(await runCli([`--project-root=${projectRoot}`, 'decision', 'record', 'recovers immediately'], retry.io)).toBe(0);
    expect(retry.stdout.join('')).toContain('recorded: D1');
  });
});
