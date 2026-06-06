import { describe, expect, it } from 'vitest';
import { type CachedResponse, UrlCache } from '../src/api/transport/urlCache.js';

function payload(body: string): CachedResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, body };
}

describe('UrlCache', () => {
  it('miss returns undefined; set then get returns the payload', () => {
    const cache = new UrlCache(4);
    expect(cache.get('https://www.hepdata.net/record/1?format=json')).toBeUndefined();

    cache.set('https://www.hepdata.net/record/1?format=json', payload('one'));
    expect(cache.get('https://www.hepdata.net/record/1?format=json')).toEqual(payload('one'));
    expect(cache.has('https://www.hepdata.net/record/1?format=json')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('distinct URLs are distinct keys (query string is part of the key)', () => {
    const cache = new UrlCache(4);
    cache.set('https://www.hepdata.net/search/?q=a', payload('A'));
    cache.set('https://www.hepdata.net/search/?q=b', payload('B'));
    expect(cache.get('https://www.hepdata.net/search/?q=a')?.body).toBe('A');
    expect(cache.get('https://www.hepdata.net/search/?q=b')?.body).toBe('B');
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const cache = new UrlCache(2);
    cache.set('u1', payload('1'));
    cache.set('u2', payload('2'));
    cache.set('u3', payload('3')); // u1 (oldest) should be evicted

    expect(cache.has('u1')).toBe(false);
    expect(cache.has('u2')).toBe(true);
    expect(cache.has('u3')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('get() marks an entry most-recently-used (protects it from eviction)', () => {
    const cache = new UrlCache(2);
    cache.set('u1', payload('1'));
    cache.set('u2', payload('2'));

    // Touch u1 so u2 becomes the LRU.
    expect(cache.get('u1')?.body).toBe('1');

    cache.set('u3', payload('3')); // u2 should be evicted, u1 retained
    expect(cache.has('u1')).toBe(true);
    expect(cache.has('u2')).toBe(false);
    expect(cache.has('u3')).toBe(true);
  });

  it('re-setting an existing key updates the value and refreshes recency', () => {
    const cache = new UrlCache(2);
    cache.set('u1', payload('old'));
    cache.set('u2', payload('2'));
    cache.set('u1', payload('new')); // u1 refreshed → u2 is now LRU

    expect(cache.get('u1')?.body).toBe('new');
    expect(cache.size).toBe(2);

    cache.set('u3', payload('3')); // evicts u2
    expect(cache.has('u2')).toBe(false);
    expect(cache.has('u1')).toBe(true);
  });

  it('clear() empties the cache', () => {
    const cache = new UrlCache(4);
    cache.set('u1', payload('1'));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('u1')).toBe(false);
  });

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new UrlCache(0)).toThrow(/positive integer/);
    expect(() => new UrlCache(-1)).toThrow(/positive integer/);
    expect(() => new UrlCache(2.5)).toThrow(/positive integer/);
  });
});
