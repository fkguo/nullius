import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _setAtomicWriteAuditHook } from '@nullius/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decisionsLedgerPath,
  landDecisionIds,
  readDecisionsLedger,
} from '../src/decisions-ledger.js';

const roots: string[] = [];

function makeProject(): { root: string; ledgerPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-decision-land-fault-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.nullius'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nullius', 'state.json'), '{}\n', 'utf-8');
  return { root, ledgerPath: decisionsLedgerPath(root) };
}

function provisionalLine(): string {
  return JSON.stringify({
    id: 'ABC123',
    ts: '2026-07-28T00:00:00.000Z',
    kind: 'pending',
    text: 'branch question',
    by: 'user',
    resolves: null,
  }) + '\n';
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('decision landing fault boundaries', () => {
  it('rechecks the source after staging and preserves a foreign edit made during preparation', () => {
    const { root, ledgerPath } = makeProject();
    fs.writeFileSync(ledgerPath, provisionalLine(), 'utf-8');
    const foreign = JSON.stringify({
      id: 'D99',
      ts: '2026-07-28T00:00:01.000Z',
      kind: 'pending',
      text: 'foreign writer won',
      by: 'user',
      resolves: null,
    }) + '\n';
    let injected = false;
    const restore = _setAtomicWriteAuditHook((event) => {
      if (
        !injected
        && event.kind === 'open'
        && event.flags === 'w'
        && event.path.startsWith(`${ledgerPath}.tmp.`)
      ) {
        injected = true;
        fs.writeFileSync(ledgerPath, foreign, 'utf-8');
      }
    });
    try {
      expect(() => landDecisionIds(root)).toThrow('ledger changed while preparing the rewrite');
    } finally {
      restore();
    }

    expect(injected).toBe(true);
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(foreign);
    expect(fs.readdirSync(path.dirname(ledgerPath)).filter(name => name.includes('.tmp.'))).toEqual([]);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  it('refuses to replace a read-only ledger even when its parent directory is writable', () => {
    const { root, ledgerPath } = makeProject();
    fs.writeFileSync(ledgerPath, provisionalLine(), 'utf-8');
    fs.chmodSync(ledgerPath, 0o444);
    const before = fs.readFileSync(ledgerPath);

    expect(() => landDecisionIds(root)).toThrow('mode 0444 has no write bit');

    expect(fs.readFileSync(ledgerPath)).toEqual(before);
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  it('reports a post-rename durability failure as commit-uncertain and supports inspection plus retry', () => {
    const { root, ledgerPath } = makeProject();
    fs.writeFileSync(ledgerPath, provisionalLine(), { encoding: 'utf-8', mode: 0o640 });
    let injected = false;
    const restore = _setAtomicWriteAuditHook((event) => {
      if (!injected && event.kind === 'rename' && event.to === ledgerPath) {
        injected = true;
        throw new Error('injected failure after rename');
      }
    });
    let failure: Error | undefined;
    try {
      landDecisionIds(root);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      restore();
    }

    expect(failure?.message).toMatch(
      /target bytes.*commit status is uncertain.*decision list.*decision land/s,
    );
    expect(failure?.message).toContain(`--project-root '${root}'`);
    expect(injected).toBe(true);
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o640);
    expect(readDecisionsLedger(root)).toMatchObject({
      invalid_lines: 0,
      unlanded_ids: [],
      records: [expect.objectContaining({ id: 'D1', provisional_id: 'ABC123' })],
    });
    const retryEvents: string[] = [];
    const restoreRetry = _setAtomicWriteAuditHook(event => retryEvents.push(event.kind));
    try {
      expect(landDecisionIds(root)).toEqual({
        path: '.nullius/decisions.jsonl',
        landed: [],
        rewritten_resolutions: 0,
        rewritten_related_links: 0,
      });
    } finally {
      restoreRetry();
    }
    expect(retryEvents).toEqual(['open', 'fsync', 'close']);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  it('refuses a canonical no-op when a foreign writer changes the ledger during durability confirmation', () => {
    const { root, ledgerPath } = makeProject();
    const canonical = JSON.stringify({
      id: 'D1',
      ts: '2026-07-28T00:00:00.000Z',
      kind: 'pending',
      text: 'already landed',
      by: 'user',
      resolves: null,
    }) + '\n';
    const foreign = JSON.stringify({
      id: 'D2',
      ts: '2026-07-28T00:00:01.000Z',
      kind: 'pending',
      text: 'foreign writer won',
      by: 'user',
      resolves: null,
    }) + '\n';
    fs.writeFileSync(ledgerPath, canonical, 'utf-8');
    let injected = false;
    const restore = _setAtomicWriteAuditHook((event) => {
      if (!injected && event.kind === 'fsync') {
        injected = true;
        fs.writeFileSync(ledgerPath, foreign, 'utf-8');
      }
    });
    try {
      expect(() => landDecisionIds(root)).toThrow('ledger changed while preparing the rewrite');
    } finally {
      restore();
    }

    expect(injected).toBe(true);
    expect(fs.readFileSync(ledgerPath, 'utf-8')).toBe(foreign);
    expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
  });
});
