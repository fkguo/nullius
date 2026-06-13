import { describe, expect, it } from 'vitest';
import {
  appendFailedApproach,
  blockedApproaches,
  createFailedApproachesLog,
  parseFailedApproachesV1,
  safeParseFailedApproachesV1,
  type FailedApproachesV1,
  type FailedApproachInput,
} from '../failed-approaches.js';

const AT = '2026-06-13T00:00:00Z';

function entry(overrides: Partial<FailedApproachInput> = {}): FailedApproachInput {
  return {
    approach: 'brute-force grid scan over (m, g)',
    why_failed: 'exceeded 24h on a 1000x1000 grid; needs a coarser pre-scan',
    signal: 'too_expensive',
    at: AT,
    ...overrides,
  };
}

describe('createFailedApproachesLog', () => {
  it('creates an empty v1 log; carries run_id/topic when given', () => {
    expect(createFailedApproachesLog()).toEqual({ version: 1, approaches: [] });
    expect(createFailedApproachesLog({ run_id: 'r1', topic: 'rare decays' })).toEqual({
      version: 1, run_id: 'r1', topic: 'rare decays', approaches: [],
    });
  });
});

describe('appendFailedApproach', () => {
  it('appends and defaults do_not_retry to true; is pure (does not mutate input)', () => {
    const log = createFailedApproachesLog();
    const next = appendFailedApproach(log, entry());
    expect(log.approaches).toHaveLength(0); // input untouched
    expect(next.approaches).toHaveLength(1);
    expect(next.approaches[0]!.do_not_retry).toBe(true);
    expect(next.approaches[0]!.signal).toBe('too_expensive');
  });

  it('honours an explicit do_not_retry=false (e.g. retry once env is fixed)', () => {
    const next = appendFailedApproach(createFailedApproachesLog(), entry({ signal: 'error', do_not_retry: false }));
    expect(next.approaches[0]!.do_not_retry).toBe(false);
  });

  // Anti-noise invariant: a dead-end with no lesson is not loggable.
  it('THROWS on empty why_failed', () => {
    expect(() => appendFailedApproach(createFailedApproachesLog(), entry({ why_failed: '   ' }))).toThrow(/why_failed/);
  });
  it('THROWS on empty approach', () => {
    expect(() => appendFailedApproach(createFailedApproachesLog(), entry({ approach: '' }))).toThrow(/approach/);
  });
  it('THROWS on an unknown signal', () => {
    expect(() => appendFailedApproach(createFailedApproachesLog(), entry({ signal: 'gave_up' as never }))).toThrow(/signal/);
  });
  it('THROWS on empty timestamp', () => {
    expect(() => appendFailedApproach(createFailedApproachesLog(), entry({ at: '' }))).toThrow(/at/);
  });
});

describe('blockedApproaches', () => {
  it('returns only the do_not_retry approaches (the read-before-retry list)', () => {
    let log = createFailedApproachesLog();
    log = appendFailedApproach(log, entry({ approach: 'A', do_not_retry: true }));
    log = appendFailedApproach(log, entry({ approach: 'B', do_not_retry: false }));
    log = appendFailedApproach(log, entry({ approach: 'C' })); // defaults true
    expect(blockedApproaches(log).sort()).toEqual(['A', 'C']);
  });

  it('does not throw on malformed / null approaches', () => {
    const junk = { approaches: [null, 42, { approach: 'X', do_not_retry: true }, { approach: 7, do_not_retry: true }] } as never;
    expect(() => blockedApproaches(junk)).not.toThrow();
    expect(blockedApproaches(junk)).toEqual(['X']);
    expect(() => blockedApproaches({ approaches: 'nope' } as never)).not.toThrow();
  });
});

describe('safeParseFailedApproachesV1', () => {
  function valid(): FailedApproachesV1 {
    return appendFailedApproach(createFailedApproachesLog({ run_id: 'r1' }), entry());
  }

  it('accepts a well-formed log', () => {
    expect(safeParseFailedApproachesV1(valid()).ok).toBe(true);
    expect(() => parseFailedApproachesV1(valid())).not.toThrow();
  });

  it('rejects an entry with empty why_failed (boundary re-assert of the anti-noise rule)', () => {
    const bad = { ...valid(), approaches: [{ ...valid().approaches[0], why_failed: '' }] };
    const parsed = safeParseFailedApproachesV1(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.some(i => i.path === 'approaches[0].why_failed')).toBe(true);
  });

  it('rejects an unknown signal and a non-boolean do_not_retry', () => {
    expect(safeParseFailedApproachesV1({ ...valid(), approaches: [{ ...valid().approaches[0], signal: 'meh' }] }).ok).toBe(false);
    expect(safeParseFailedApproachesV1({ ...valid(), approaches: [{ ...valid().approaches[0], do_not_retry: 'yes' }] }).ok).toBe(false);
  });

  it('rejects wrong version / non-object / non-array approaches', () => {
    expect(safeParseFailedApproachesV1(null).ok).toBe(false);
    expect(safeParseFailedApproachesV1({ ...valid(), version: 2 }).ok).toBe(false);
    expect(safeParseFailedApproachesV1({ version: 1, approaches: 'x' }).ok).toBe(false);
  });

  it('does NOT throw on null / malformed entries (returns {ok:false})', () => {
    const bad = { version: 1, approaches: [null, 42, {}] } as unknown;
    expect(() => safeParseFailedApproachesV1(bad)).not.toThrow();
    expect(safeParseFailedApproachesV1(bad).ok).toBe(false);
  });
});
