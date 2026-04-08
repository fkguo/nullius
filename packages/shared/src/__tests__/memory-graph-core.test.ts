import { describe, expect, it } from 'vitest';

import { decayWeight } from '../memory-graph/decay.js';
import { getMemoryAdvice } from '../memory-graph/advice.js';
import { computeSignalKey, normalizeSignals } from '../memory-graph/hash.js';

describe('memory-graph core helpers', () => {
  it('computeSignalKey is stable across order, path, and number normalization', () => {
    const first = computeSignalKey([
      'Type error in /tmp/foo.ts:123',
      'Missing import after 9 retries',
    ]);
    const second = computeSignalKey([
      'Missing import after 42 retries',
      'Type error in /Users/example/project/bar.ts:7',
    ]);

    expect(first).toBe(second);
  });

  it('decayWeight matches the 30-day half-life schedule at 90 days', () => {
    const now = new Date('2026-03-24T00:00:00.000Z');
    const ninetyDaysAgo = new Date('2025-12-24T00:00:00.000Z');

    expect(decayWeight(ninetyDaysAgo, now, 30)).toBeCloseTo(0.125, 3);
  });

  it('getMemoryAdvice prefers strong historical genes and bans repeated low-score genes', async () => {
    const winningSignals = normalizeSignals(['Type error in /tmp/foo.ts:123']);
    const losingSignals = normalizeSignals(['Type error in /tmp/foo.ts:123', 'Missing import after 9 retries']);
    const advice = await getMemoryAdvice(
      ['Type error in /Users/example/project/bar.ts:7'],
      {
        async getCandidateEdgeStats() {
          return [
            {
              signal_key: 'sig-a',
              gene_id: 'gene-fix',
              success: 5,
              fail: 0,
              total: 5,
              last_ts: '2026-03-23T00:00:00.000Z',
              laplace_p: 0.857,
              decay_w: 1,
              normalized_signals: JSON.stringify(winningSignals),
            },
            {
              signal_key: 'sig-b',
              gene_id: 'gene-bad',
              success: 0,
              fail: 3,
              total: 3,
              last_ts: '2026-03-23T00:00:00.000Z',
              laplace_p: 0.2,
              decay_w: 1,
              normalized_signals: JSON.stringify(losingSignals),
            },
          ];
        },
        async getGenePriorsBatch() {
          return new Map([
            ['gene-fix', 0.9],
            ['gene-bad', 0.05],
          ]);
        },
      },
      new Date('2026-03-24T00:00:00.000Z'),
      30,
    );

    expect(advice.preferredGeneId).toBe('gene-fix');
    expect(advice.bannedGeneIds).toContain('gene-bad');
    expect(advice.scores.get('gene-fix')).toBeGreaterThan(advice.scores.get('gene-bad') ?? 0);
  });
});
