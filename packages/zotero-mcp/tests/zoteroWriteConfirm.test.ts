import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleToolCall } from '../src/tools/index.js';

describe('zotero-mcp: write confirmation', () => {
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

  it('zotero_add returns confirm_token and does not write during preview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called during zotero_add preview');
      }) as any
    );

    const preview = await handleToolCall('zotero_add', {
      source: { type: 'item', item: { itemType: 'journalArticle', title: 'Test Item' } },
      collection_keys: ['COLL1234'],
      tags: ['hep'],
      open_in_zotero: false,
    });
    expect(preview.isError).not.toBe(true);

    const previewPayload = JSON.parse(preview.content[0].text) as {
      status: string;
      confirm_token?: string;
    };
    expect(previewPayload.status).toBe('needs_confirm');
    expect(typeof previewPayload.confirm_token).toBe('string');

    const token = String(previewPayload.confirm_token);

    const fetchStub = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);

      if (u.pathname === '/api/users/0/items' && (init?.method || 'GET') === 'POST') {
        return new Response(JSON.stringify({ successful: { '0': { key: 'ITEM12345', version: 1 } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const confirmed = await handleToolCall('zotero_confirm', { confirm_token: token });
    expect(confirmed.isError).not.toBe(true);

    const confirmedPayload = JSON.parse(confirmed.content[0].text) as {
      status: string;
      tool: string;
      result: { status: string; item_key: string };
    };
    expect(confirmedPayload.status).toBe('executed');
    expect(confirmedPayload.tool).toBe('zotero_add');
    expect(confirmedPayload.result.status).toBe('created');
    expect(confirmedPayload.result.item_key).toBe('ITEM12345');

    const second = await handleToolCall('zotero_confirm', { confirm_token: token });
    expect(second.isError).toBe(true);
    const secondPayload = JSON.parse(second.content[0].text) as { error?: { code?: string } };
    expect(secondPayload.error?.code).toBe('INVALID_PARAMS');
  });
});

