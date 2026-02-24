import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleToolCall } from '../src/tools/index.js';

describe('zotero-mcp: zotero_local(list_collection_paths)', () => {
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

  it('returns key → path mapping', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/collections') {
        return new Response(
          JSON.stringify([
            { key: 'PARENT1', data: { name: 'Physics' } },
            { key: 'CHILD1', data: { name: 'HEP', parentCollection: 'PARENT1' } },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_local', { mode: 'list_collection_paths', query: 'physics', match: 'contains' });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      collection_paths: Array<{ collection_key: string; path: string }>;
      summary: { returned: number; total: number };
    };
    expect(payload.summary.total).toBe(2);
    expect(payload.summary.returned).toBe(2);
    expect(payload.collection_paths.map(p => p.path)).toEqual(['Physics', 'Physics / HEP']);
  });
});
