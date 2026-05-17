import { describe, expect, it } from 'vitest';

import {
  CacheMissError,
  parseCacheableIdentifier,
} from '../../src/data/papersCacheFetch.js';

describe('parseCacheableIdentifier', () => {
  it('parses versioned arxiv ids', () => {
    const r = parseCacheableIdentifier('arxiv:2401.09012v3');
    expect(r).toEqual({ scheme: 'arxiv', arxiv_id: '2401.09012', version: 'v3', raw: 'arxiv:2401.09012v3' });
  });

  it('parses unversioned arxiv ids', () => {
    const r = parseCacheableIdentifier('arxiv:2401.09012');
    expect(r).toEqual({ scheme: 'arxiv', arxiv_id: '2401.09012', version: null, raw: 'arxiv:2401.09012' });
  });

  it('parses legacy hep-ph/9501234v2 style', () => {
    const r = parseCacheableIdentifier('arxiv:hep-ph/9501234v2');
    expect(r).toMatchObject({ scheme: 'arxiv', arxiv_id: 'hep-ph/9501234', version: 'v2' });
  });

  it('parses doi identifiers', () => {
    const r = parseCacheableIdentifier('doi:10.1103/PhysRevD.108.052006');
    expect(r).toEqual({ scheme: 'doi', doi: '10.1103/PhysRevD.108.052006', raw: 'doi:10.1103/PhysRevD.108.052006' });
  });

  it('parses inspire recids', () => {
    const r = parseCacheableIdentifier('inspire:recid:1234567');
    expect(r).toEqual({ scheme: 'inspire', recid: '1234567', raw: 'inspire:recid:1234567' });
  });

  it('parses zotero refs', () => {
    const r = parseCacheableIdentifier('zotero:9999/ABCDEFGH');
    expect(r).toEqual({ scheme: 'zotero', library: '9999', key: 'ABCDEFGH', raw: 'zotero:9999/ABCDEFGH' });
  });

  it('trims whitespace', () => {
    const r = parseCacheableIdentifier('  arxiv:2401.09012v3  ');
    expect(r.scheme).toBe('arxiv');
    expect(r.raw).toBe('arxiv:2401.09012v3');
  });

  it('rejects missing scheme prefix', () => {
    expect(() => parseCacheableIdentifier('2401.09012')).toThrow(/missing scheme prefix/);
    expect(() => parseCacheableIdentifier('')).toThrow();
  });

  it('rejects unknown schemes', () => {
    expect(() => parseCacheableIdentifier('pubmed:12345')).toThrow(/unknown scheme/);
  });

  it('rejects malformed arxiv ids', () => {
    expect(() => parseCacheableIdentifier('arxiv:not-an-id')).toThrow(/unrecognized arxiv id/);
    expect(() => parseCacheableIdentifier('arxiv:2401.0')).toThrow(/unrecognized arxiv id/);
  });

  it('rejects malformed doi', () => {
    expect(() => parseCacheableIdentifier('doi:not.a.doi')).toThrow(/unrecognized doi/);
  });

  it('rejects inspire without recid: sub-prefix', () => {
    expect(() => parseCacheableIdentifier('inspire:1234567')).toThrow(/requires "recid:" sub-prefix/);
  });

  it('rejects inspire with non-numeric recid', () => {
    expect(() => parseCacheableIdentifier('inspire:recid:abc')).toThrow(/recid must be numeric/);
  });

  it('rejects malformed zotero refs', () => {
    expect(() => parseCacheableIdentifier('zotero:abc')).toThrow(/must be "<libraryID>\/<itemKey>"/);
    expect(() => parseCacheableIdentifier('zotero:lib/')).toThrow();
  });
});

describe('CacheMissError', () => {
  it('carries canonical_id, reason, and suggestion', () => {
    const err = new CacheMissError('doi:10.1/X', 'no INSPIRE record', 'Use hep_admin_import_paper.');
    expect(err.name).toBe('CacheMissError');
    expect(err.canonical_id).toBe('doi:10.1/X');
    expect(err.reason).toContain('INSPIRE');
    expect(err.suggestion).toContain('hep_admin_import_paper');
    expect(err.message).toContain('doi:10.1/X');
    expect(err.message).toContain('hep_admin_import_paper');
  });
});
