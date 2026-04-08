import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSqliteMemoryGraphStore } from '../memory-graph/store-sqlite.js';
import { normalizeSignals } from '../memory-graph/hash.js';

function withTempDb<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'memory-graph-store-'));
  const dbPath = join(dir, 'memory-graph.sqlite');
  return run(dbPath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('memory-graph sqlite store', () => {
  it('tracks top and high-frequency signals across the rolling window', async () => {
    await withTempDb(async dbPath => {
      const store = createSqliteMemoryGraphStore(dbPath);
      await store.incrementSignalFrequency('sig-1', 'type error in <path>', '2026-03-24T00:00:00.000Z');
      await store.incrementSignalFrequency('sig-1', 'type error in <path>', '2026-03-24T01:00:00.000Z');
      await store.incrementSignalFrequency('sig-2', 'missing import after <N> retries', '2026-03-24T02:00:00.000Z');

      expect(await store.topSignals(30, 5)).toEqual([
        { signal: 'type error in <path>', count: 2 },
        { signal: 'missing import after <N> retries', count: 1 },
      ]);
      expect(await store.highFrequencySignals(2, 30)).toEqual(['type error in <path>']);
    });
  });

  it('returns archival candidates after decay updates', async () => {
    await withTempDb(async dbPath => {
      const store = createSqliteMemoryGraphStore(dbPath);
      const nodeId = await store.addNode({
        node_type: 'signal',
        track: 'shared',
        payload: { signal_key: 'sig-1', signals: normalizeSignals(['Type error in /tmp/foo.ts:1']) },
        decay_ts: null,
        weight: 1,
      });

      await store.applyNodeDecayUpdates([{ id: nodeId, weight: 0.05, decayTs: '2026-03-24T00:00:00.000Z' }]);
      await expect(store.archivalCandidates(0.1)).resolves.toEqual([
        { id: nodeId, nodeType: 'signal', track: 'shared', weight: 0.05, updatedAt: expect.any(String) },
      ]);
    });
  });

  it('finds similar capsules by normalized trigger overlap', async () => {
    await withTempDb(async dbPath => {
      const store = createSqliteMemoryGraphStore(dbPath);
      await store.addNode({
        node_type: 'capsule',
        track: 'b',
        payload: {
          capsule_id: 'cap-1',
          gene_id: 'gene-fix',
          trigger: ['Type error in /tmp/foo.ts:1'],
        },
        decay_ts: null,
        weight: 1,
      });

      const matches = await store.findSimilarCapsules(normalizeSignals(['Type error in /Users/example/project/bar.ts:99']), 0.3);
      expect(matches).toHaveLength(1);
      expect((matches[0]?.node.payload as { capsule_id?: string }).capsule_id).toBe('cap-1');
    });
  });
});
