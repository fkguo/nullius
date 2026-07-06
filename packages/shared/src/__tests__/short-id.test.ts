import { describe, it, expect } from 'vitest';
import {
  shortId,
  uniqueShortId,
  isShortId,
  SHORT_ID_ALPHABET,
  SHORT_ID_LENGTH,
  SHORT_ID_JSON_PATTERN,
} from '../short-id.js';

describe('shortId', () => {
  const re = new RegExp(SHORT_ID_JSON_PATTERN);

  it('generates ids that match the length, alphabet, and JSON pattern', () => {
    const ids = Array.from({ length: 2000 }, () => shortId());
    for (const id of ids) {
      expect(id).toHaveLength(SHORT_ID_LENGTH);
      expect(re.test(id)).toBe(true);
      expect(isShortId(id)).toBe(true);
    }
  });

  it('excludes visually ambiguous characters (i, l, o, u)', () => {
    expect(SHORT_ID_ALPHABET).not.toMatch(/[ilou]/);
    const blob = Array.from({ length: 2000 }, () => shortId()).join('');
    expect(blob).not.toMatch(/[ilou]/);
  });

  it('is collision-free at portfolio scale (5000 ids)', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => shortId()));
    expect(ids.size).toBe(5000);
  });

  it('isShortId rejects UUIDs, wrong length, and non-strings', () => {
    expect(isShortId('90b4ea10-ccfa-4ba8-96aa-3a4f0ec92ea4')).toBe(false);
    expect(isShortId('short')).toBe(false); // too short
    expect(isShortId('toolongtoolong')).toBe(false); // too long
    expect(isShortId('abcio1uz')).toBe(false); // contains excluded chars i/o/u
    expect(isShortId(123 as unknown as string)).toBe(false);
  });

  it('uniqueShortId avoids ids the store already holds', () => {
    const used = new Set([shortId(), shortId()]);
    const fresh = uniqueShortId((id) => used.has(id));
    expect(used.has(fresh)).toBe(false);
    expect(isShortId(fresh)).toBe(true);
  });

  it('uniqueShortId throws when the id space is exhausted', () => {
    expect(() => uniqueShortId(() => true, { maxTries: 4 })).toThrow(/no free id/);
  });
});
