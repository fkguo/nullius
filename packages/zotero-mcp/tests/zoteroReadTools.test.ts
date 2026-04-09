import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleToolCall } from '../src/tools/index.js';

describe('zotero-mcp: read tools (tags/export)', () => {
  let originalZoteroBaseUrl: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalZoteroBaseUrl = process.env.ZOTERO_BASE_URL;
    originalFetch = globalThis.fetch;
    process.env.ZOTERO_BASE_URL = 'http://127.0.0.1:23119';
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }

    if (originalZoteroBaseUrl !== undefined) {
      process.env.ZOTERO_BASE_URL = originalZoteroBaseUrl;
    } else {
      delete process.env.ZOTERO_BASE_URL;
    }
  });

  it('zotero_local(list_tags) returns summarized tags', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/tags') {
        return new Response(JSON.stringify([{ tag: 'hep', type: 0, numItems: 2 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_local', { mode: 'list_tags' });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as { tags?: Array<{ tag: string }>; summary?: { returned: number } };
    expect(payload.tags?.[0]?.tag).toBe('hep');
    expect(payload.summary?.returned).toBe(1);
  });

  it('zotero_export_items returns export content (truncation aware)', async () => {
    const raw = '@article{key, title={Test}}\\n' + 'x'.repeat(2500);
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/items') {
        return new Response(raw, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_export_items', {
      scope: { kind: 'item_keys', item_keys: ['ITEM12345'] },
      format: 'bibtex',
      max_chars: 1000,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as { format: string; truncated: boolean; content: string; total_chars: number };
    expect(payload.format).toBe('bibtex');
    expect(payload.total_chars).toBeGreaterThan(1000);
    expect(payload.truncated).toBe(true);
    expect(payload.content.length).toBe(1000);
  });

  it('zotero_search_items returns summarized items', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/items/top') {
        expect(u.searchParams.get('q')).toBe('higgs');
        expect(u.searchParams.get('qmode')).toBe('everything');
        expect(u.searchParams.get('tag')).toBe('hep');
        expect(u.searchParams.get('itemType')).toBe('journalArticle');
        expect(u.searchParams.get('includeTrashed')).toBe('1');
        expect(u.searchParams.get('sort')).toBe('dateModified');
        expect(u.searchParams.get('direction')).toBe('desc');
        expect(u.searchParams.get('limit')).toBe('2');
        expect(u.searchParams.get('start')).toBe('5');

        return new Response(
          JSON.stringify([
            {
              key: 'ITEM1',
              data: {
                itemType: 'journalArticle',
                title: 'Higgs boson',
                creators: [{ creatorType: 'author', firstName: 'A', lastName: 'Smith' }],
                date: '2012',
                DOI: '10.1234/abcd',
                publicationTitle: 'PRL',
              },
            },
            {
              key: 'ITEM2',
              data: {
                itemType: 'preprint',
                title: 'Search',
                creators: [{ creatorType: 'author', name: 'Doe' }],
                date: '2010-01-01',
                extra: 'arXiv:1234.5678\nINSPIRE: 123456\n',
              },
            },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/json', 'Total-Results': '100' },
          }
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_search_items', {
      q: 'higgs',
      qmode: 'everything',
      tag: 'hep',
      item_type: 'journalArticle',
      include_trashed: true,
      sort: 'dateModified',
      direction: 'desc',
      limit: 2,
      start: 5,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      items?: Array<{ item_key: string; identifiers?: { doi?: string; arxiv_id?: string; inspire_recid?: string }; select_uri?: string }>;
      summary?: { returned: number; total_results_header?: number };
    };
    expect(payload.summary?.returned).toBe(2);
    expect(payload.summary?.total_results_header).toBe(100);

    expect(payload.items?.[0]?.item_key).toBe('ITEM1');
    expect((payload.items?.[0] as any)?.item_type).toBe('journalArticle');
    expect(payload.items?.[0]?.identifiers?.doi).toBe('10.1234/abcd');
    expect(payload.items?.[0]?.select_uri).toBe('zotero://select/library/items/ITEM1');

    expect(payload.items?.[1]?.item_key).toBe('ITEM2');
    expect((payload.items?.[1] as any)?.item_type).toBe('preprint');
    expect(payload.items?.[1]?.identifiers?.arxiv_id).toBe('1234.5678');
    expect(payload.items?.[1]?.identifiers?.inspire_recid).toBe('123456');
  });

  it('zotero_find_items can scope candidate search to a collection', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/collections/COLL1/items') {
        expect(u.searchParams.get('q')).toBe('10.1234/abcd');
        expect(u.searchParams.get('itemType')).toBe('-attachment');
        expect(u.searchParams.get('limit')).toBe('2');
        expect(u.searchParams.get('start')).toBe('0');

        return new Response(
          JSON.stringify([
            { key: 'ITEM1', data: { itemType: 'journalArticle', title: 'T1', DOI: '10.1234/abcd' } },
            { key: 'ITEM2', data: { itemType: 'journalArticle', title: 'T2', DOI: '10.9999/nope' } },
          ]),
          { status: 200, headers: { 'content-type': 'application/json', 'Total-Results': '10' } }
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_find_items', {
      collection_key: 'COLL1',
      identifiers: { doi: '10.1234/abcd' },
      limit: 2,
      match: 'exact',
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      query?: { collection_key?: string };
      items?: Array<{ item_key: string }>;
      summary?: { matched: number; scanned?: number; total_results_header?: number };
    };
    expect(payload.query?.collection_key).toBe('COLL1');
    expect(payload.items?.map(m => m.item_key)).toEqual(['ITEM1']);
    expect((payload.items?.[0] as any)?.item_type).toBe('journalArticle');
    expect(payload.summary?.matched).toBe(1);
    expect(payload.summary?.scanned).toBe(2);
    expect(payload.summary?.total_results_header).toBe(10);
  });

  it('zotero_find_items rejects item_key outside scoped collection', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/items/ITEM1') {
        return new Response(JSON.stringify({ key: 'ITEM1', data: { itemType: 'journalArticle', title: 'T1', collections: ['COLL2'] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_find_items', {
      collection_key: 'COLL1',
      identifiers: { item_key: 'ITEM1' },
      match: 'exact',
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      items?: Array<{ item_key: string }>;
      summary?: { matched: number; scanned?: number };
    };
    expect(payload.items?.length).toBe(0);
    expect(payload.summary?.matched).toBe(0);
    expect(payload.summary?.scanned).toBe(1);
  });

  it('zotero_find_items can include descendant collections', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);

      if (u.pathname === '/api/users/0/collections') {
        return new Response(
          JSON.stringify([
            { key: 'PARENT1', data: { name: 'Root' } },
            { key: 'CHILD1', data: { name: 'Child', parentCollection: 'PARENT1' } },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (u.pathname === '/api/users/0/collections/PARENT1/items') {
        expect(u.searchParams.get('q')).toBe('10.1234/abcd');
        return new Response(JSON.stringify([{ key: 'MISS1', data: { itemType: 'journalArticle', title: 'X', DOI: '10.9999/nope' } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (u.pathname === '/api/users/0/collections/CHILD1/items') {
        expect(u.searchParams.get('q')).toBe('10.1234/abcd');
        return new Response(JSON.stringify([{ key: 'HIT1', data: { itemType: 'journalArticle', title: 'Hit', DOI: '10.1234/abcd' } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_find_items', {
      collection_key: 'PARENT1',
      include_children: true,
      identifiers: { doi: '10.1234/abcd' },
      limit: 5,
      match: 'exact',
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      query?: { collection_key?: string; include_children?: boolean };
      items?: Array<{ item_key: string }>;
      summary?: { matched: number };
    };
    expect(payload.query?.collection_key).toBe('PARENT1');
    expect(payload.query?.include_children).toBe(true);
    expect(payload.items?.map(m => m.item_key)).toEqual(['HIT1']);
    expect(payload.summary?.matched).toBe(1);
  });
});
