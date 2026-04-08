import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpError } from '../errors.js';
import { computeSignalKey, createMemoryGraph, normalizeSignals } from '../index.js';

function withTempDb<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'memory-graph-service-'));
  const dbPath = join(dir, 'memory-graph.sqlite');
  return run(dbPath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('memory-graph service', () => {
  it('persists cross-run signal frequency, edge aggregation, and advice scoring', async () => {
    await withTempDb(async dbPath => {
      const graph = createMemoryGraph({ dbPath, halfLifeDays: 30 });
      const sharedSignal = 'Type error in /tmp/foo.ts:123';
      const sharedSignalKey = computeSignalKey([sharedSignal]);

      await graph.recordSignalSnapshot('run-a', [sharedSignal, 'Missing import after 9 retries']);
      await graph.recordSignalSnapshot('run-b', ['Type error in /Users/example/project/bar.ts:7']);
      await graph.recordOutcome('run-a', 'gene-fix', { signal_key: sharedSignalKey, success: true, quality_score: 0.9 });
      await graph.recordOutcome('run-b', 'gene-fix', { signal_key: sharedSignalKey, success: true, quality_score: 0.8 });
      await graph.recordOutcome('run-c', 'gene-bad', { signal_key: sharedSignalKey, success: false, reason: 'validation_failed' });
      await graph.recordOutcome('run-d', 'gene-bad', { signal_key: sharedSignalKey, success: false, reason: 'validation_failed' });
      await graph.aggregateEdges();

      const topSignals = await graph.topSignals(30, 5);
      expect(topSignals[0]).toEqual({ signal: 'type error in <path>', count: 2 });

      const advice = await graph.getMemoryAdvice(['Type error in /Users/example/project/baz.ts:999']);
      expect(advice.preferredGeneId).toBe('gene-fix');
      expect(advice.bannedGeneIds).toContain('gene-bad');
      expect(await graph.highFrequencySignals(2, 30)).toEqual(['type error in <path>']);
      expect(await graph.getRecentEvents(2)).toHaveLength(2);
    });
  });

  it('does not probe sqlite3 until the first store operation and then fails closed if sqlite3 is missing', async () => {
    await withTempDb(async dbPath => {
      const originalPath = process.env.PATH;
      const emptyDir = mkdtempSync(join(tmpdir(), 'memory-graph-empty-path-'));
      mkdirSync(emptyDir, { recursive: true });
      process.env.PATH = emptyDir;

      try {
        const graph = createMemoryGraph({ dbPath });
        await expect(graph.getRecentEvents(1)).rejects.toBeInstanceOf(McpError);
        await expect(graph.getRecentEvents(1)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      } finally {
        process.env.PATH = originalPath;
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  it('exposes capsule search and decay maintenance through the public service', async () => {
    await withTempDb(async dbPath => {
      const graph = createMemoryGraph({ dbPath });
      await graph.addNode({
        node_type: 'capsule',
        track: 'b',
        payload: {
          capsule_id: 'cap-public',
          gene_id: 'gene-fix',
          trigger: ['Type error in /tmp/foo.ts:1'],
        },
        decay_ts: null,
        weight: 1,
      });

      const matches = await graph.findSimilarCapsules(normalizeSignals(['Type error in /Users/example/project/bar.ts:5']), 0.3);
      expect(matches).toHaveLength(1);

      await graph.addNode({
        node_type: 'signal',
        track: 'shared',
        payload: { signal_key: 'sig-archive', signals: ['archival candidate'] },
        decay_ts: null,
        weight: 1,
      });

      const decayResult = await graph.recalculateDecay(30);
      expect(decayResult.updated).toBeGreaterThanOrEqual(2);
    });
  });
});
