import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { handleToolCall } from '../src/tools/index.js';
import { resolveZoteroWriteToken, resetZoteroWriteTokenCache } from '../src/shared/zotero/writeApi.js';

const BASE = 'http://127.0.0.1:23119';

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function parsePreview(result: { content: { text: string }[]; isError?: boolean }) {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

describe('zotero-mcp: write endpoint (attach via zotero-inspire + delete)', () => {
  let originalBaseUrl: string | undefined;
  let originalToken: string | undefined;
  let originalFetch: typeof fetch | undefined;
  let tmpFile: string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalBaseUrl = process.env.ZOTERO_BASE_URL;
    originalToken = process.env.ZOTERO_WRITE_TOKEN;
    originalFetch = globalThis.fetch;
    process.env.ZOTERO_BASE_URL = BASE;
    process.env.ZOTERO_WRITE_TOKEN = 'test-token-123';
    resetZoteroWriteTokenCache();
    tmpFile = path.join(os.tmpdir(), `zotero-mcp-write-test-${process.pid}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, '%PDF-1.7\n% test\n');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFetch) globalThis.fetch = originalFetch;
    if (originalBaseUrl !== undefined) process.env.ZOTERO_BASE_URL = originalBaseUrl;
    else delete process.env.ZOTERO_BASE_URL;
    if (originalToken !== undefined) process.env.ZOTERO_WRITE_TOKEN = originalToken;
    else delete process.env.ZOTERO_WRITE_TOKEN;
    resetZoteroWriteTokenCache();
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('resolveZoteroWriteToken prefers the ZOTERO_WRITE_TOKEN env var', () => {
    expect(resolveZoteroWriteToken()).toBe('test-token-123');
  });

  it('zotero_add with file_path attaches via the write endpoint (import default) and reports it', async () => {
    const seen: { attachBody?: any; attachToken?: string } = {};
    const fetchStub = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      const method = init?.method || 'GET';

      if (u.pathname === '/api/users/0/items' && method === 'POST') {
        return jsonResponse({ successful: { '0': { key: 'ITEMAAAA', version: 1 } } });
      }
      if (u.pathname === '/connector/zinspireWrite' && method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.op === 'ping') {
          return jsonResponse({ ok: true, version: '3.0.3', capabilities: ['ping', 'attach_file', 'trash_item', 'erase_item'] });
        }
        if (body.op === 'attach_file') {
          seen.attachBody = body;
          seen.attachToken = init.headers?.['x-zinspire-token'];
          return jsonResponse({
            ok: true,
            op: 'attach_file',
            mode: body.mode,
            attachment_key: 'ATTBBBB',
            link_mode_label: body.mode === 'import' ? 'imported_file' : 'linked_file',
          });
        }
        return jsonResponse({ ok: false, error: `unexpected op ${body.op}` }, 400);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const preview = parsePreview(
      await handleToolCall('zotero_add', {
        source: { type: 'item', item: { itemType: 'journalArticle', title: 'Attach Test' } },
        collection_keys: ['COLL0001'],
        file_path: tmpFile,
        open_in_zotero: false,
      })
    );
    expect(preview.status).toBe('needs_confirm');
    // endpoint pinged available during preview -> no "unavailable" warning
    expect((preview.warnings as string[]).some(w => w.includes('unavailable'))).toBe(false);

    const confirmed = parsePreview(await handleToolCall('zotero_confirm', { confirm_token: preview.confirm_token }));
    expect(confirmed.status).toBe('executed');
    expect(confirmed.result.status).toBe('created');
    expect(confirmed.result.item_key).toBe('ITEMAAAA');
    expect(confirmed.result.summary.file_attached).toBe(true);
    expect(confirmed.result.summary.attach_mode).toBe('import');
    expect(confirmed.result.summary.attachment_key).toBe('ATTBBBB');
    expect(confirmed.result.summary.attach_error).toBeUndefined();

    // import mode + token header propagated to the endpoint
    expect(seen.attachBody.op).toBe('attach_file');
    expect(seen.attachBody.mode).toBe('import');
    expect(seen.attachBody.parent_item_key).toBe('ITEMAAAA');
    expect(seen.attachBody.file_path).toBe(tmpFile);
    expect(seen.attachToken).toBe('test-token-123');
  });

  it('attach failure (endpoint missing) is non-fatal: item created, attach_error reported, not silent', async () => {
    const fetchStub = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      const method = init?.method || 'GET';
      if (u.pathname === '/api/users/0/items' && method === 'POST') {
        return jsonResponse({ successful: { '0': { key: 'ITEMCCCC', version: 1 } } });
      }
      // write endpoint absent -> 404 for every op (plugin not installed)
      if (u.pathname === '/connector/zinspireWrite' && method === 'POST') {
        return new Response('No endpoint found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const preview = parsePreview(
      await handleToolCall('zotero_add', {
        source: { type: 'item', item: { itemType: 'journalArticle', title: 'Attach Fail Test' } },
        collection_keys: ['COLL0001'],
        file_path: tmpFile,
        open_in_zotero: false,
      })
    );
    // preview pinged the endpoint and found it unavailable -> warns
    expect((preview.warnings as string[]).some(w => w.includes('unavailable'))).toBe(true);

    const confirmed = parsePreview(await handleToolCall('zotero_confirm', { confirm_token: preview.confirm_token }));
    expect(confirmed.result.status).toBe('created');
    expect(confirmed.result.item_key).toBe('ITEMCCCC');
    expect(confirmed.result.summary.file_attached).toBeUndefined();
    expect(confirmed.result.summary.attach_error).toBeDefined();
    expect(String(confirmed.result.summary.attach_error.message)).toMatch(/endpoint not found|404/i);
  });

  it('zotero_add with attach_mode=link warns about file-management plugins', async () => {
    const fetchStub = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      const method = init?.method || 'GET';
      if (u.pathname === '/connector/zinspireWrite' && method === 'POST') {
        return jsonResponse({ ok: true, version: '3.0.3', capabilities: ['ping'] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const preview = parsePreview(
      await handleToolCall('zotero_add', {
        source: { type: 'item', item: { itemType: 'journalArticle', title: 'Link Mode' } },
        collection_keys: ['COLL0001'],
        file_path: tmpFile,
        attach_mode: 'link',
        open_in_zotero: false,
      })
    );
    expect((preview.warnings as string[]).some(w => w.includes('link') && w.includes('rename'))).toBe(true);
  });

  it('zotero_delete previews then trashes items via the write endpoint', async () => {
    const trashed: string[] = [];
    const fetchStub = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      const method = init?.method || 'GET';

      if (u.pathname === '/api/users/0/items/KEYAAAAA' && method === 'GET') {
        return jsonResponse({ key: 'KEYAAAAA', data: { title: 'Item A', itemType: 'journalArticle' } });
      }
      if (u.pathname === '/api/users/0/items/KEYBBBBB' && method === 'GET') {
        return jsonResponse({ key: 'KEYBBBBB', data: { title: 'Item B', itemType: 'journalArticle' } });
      }
      if (u.pathname === '/connector/zinspireWrite' && method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.op === 'trash_item') {
          trashed.push(body.item_key);
          return jsonResponse({ ok: true, op: 'trash_item', item_key: body.item_key, trashed: true });
        }
        return jsonResponse({ ok: false, error: `unexpected op ${body.op}` }, 400);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const preview = parsePreview(
      await handleToolCall('zotero_delete', { item_keys: ['KEYAAAAA', 'KEYBBBBB'], mode: 'trash' })
    );
    expect(preview.status).toBe('needs_confirm');
    expect(preview.plan.will).toBe('trash');
    expect(preview.plan.count).toBe(2);
    expect(preview.plan.items.map((i: any) => i.title)).toEqual(['Item A', 'Item B']);

    const confirmed = parsePreview(await handleToolCall('zotero_confirm', { confirm_token: preview.confirm_token }));
    expect(confirmed.status).toBe('executed');
    expect(confirmed.result.status).toBe('deleted');
    expect(confirmed.result.summary).toEqual({ requested: 2, succeeded: 2, skipped: 0, failed: 0 });
    expect(trashed.sort()).toEqual(['KEYAAAAA', 'KEYBBBBB']);
  });

  it('zotero_delete mode=erase warns about permanence and skips missing keys', async () => {
    const fetchStub = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      const method = init?.method || 'GET';
      if (u.pathname === '/api/users/0/items/GONE0001' && method === 'GET') {
        return new Response('Zotero resource not found', { status: 404 });
      }
      if (u.pathname === '/connector/zinspireWrite' && method === 'POST') {
        return jsonResponse({ ok: false, error: 'should not be called for missing key' }, 400);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const preview = parsePreview(await handleToolCall('zotero_delete', { item_keys: ['GONE0001'], mode: 'erase' }));
    expect((preview.warnings as string[]).some(w => w.toLowerCase().includes('permanent'))).toBe(true);
    expect((preview.warnings as string[]).some(w => w.includes('not found'))).toBe(true);
    expect(preview.plan.missing_count).toBe(1);

    const confirmed = parsePreview(await handleToolCall('zotero_confirm', { confirm_token: preview.confirm_token }));
    expect(confirmed.result.summary).toEqual({ requested: 1, succeeded: 0, skipped: 1, failed: 0 });
  });
});
