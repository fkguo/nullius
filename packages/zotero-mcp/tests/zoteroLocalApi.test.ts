import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';

import { handleToolCall } from '../src/tools/index.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('zotero-mcp: Zotero Local API', () => {
  let zoteroDataDir: string;
  let originalZoteroBaseUrl: string | undefined;
  let originalZoteroDataDir: string | undefined;
  let originalFileRedirectGuard: string | undefined;
  let originalFileRedirectAllowedRoots: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    originalZoteroBaseUrl = process.env.ZOTERO_BASE_URL;
    originalZoteroDataDir = process.env.ZOTERO_DATA_DIR;
    originalFileRedirectGuard = process.env.ZOTERO_FILE_REDIRECT_GUARD;
    originalFileRedirectAllowedRoots = process.env.ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS;
    originalFetch = globalThis.fetch;

    process.env.ZOTERO_BASE_URL = 'http://127.0.0.1:23119';
    zoteroDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-mcp-data-'));
    process.env.ZOTERO_DATA_DIR = zoteroDataDir;
    delete process.env.ZOTERO_FILE_REDIRECT_GUARD;
    delete process.env.ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS;
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

    if (originalZoteroDataDir !== undefined) {
      process.env.ZOTERO_DATA_DIR = originalZoteroDataDir;
    } else {
      delete process.env.ZOTERO_DATA_DIR;
    }

    if (originalFileRedirectGuard !== undefined) {
      process.env.ZOTERO_FILE_REDIRECT_GUARD = originalFileRedirectGuard;
    } else {
      delete process.env.ZOTERO_FILE_REDIRECT_GUARD;
    }

    if (originalFileRedirectAllowedRoots !== undefined) {
      process.env.ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS = originalFileRedirectAllowedRoots;
    } else {
      delete process.env.ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS;
    }

    if (fs.existsSync(zoteroDataDir)) {
      fs.rmSync(zoteroDataDir, { recursive: true, force: true });
    }
  });

  it('zotero_local(get_attachment_fulltext) resolves .zotero-ft-cache path (no HTTP)', async () => {
    const attachmentKey = 'ATTACH123';
    const cacheDir = path.join(zoteroDataDir, 'storage', attachmentKey);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, '.zotero-ft-cache'), 'page1\\fpage2\\n', 'utf-8');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('fetch should not be called');
      }) as any
    );

    const res = await handleToolCall('zotero_local', {
      mode: 'get_attachment_fulltext',
      attachment_key: attachmentKey,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      status: string;
      file_path?: string;
      expected_cache_path: string;
    };
    expect(payload.status).toBe('ok');
    expect(payload.file_path).toContain('.zotero-ft-cache');
    expect(payload.expected_cache_path).toContain('.zotero-ft-cache');
  });

  it('zotero_local(download_attachment) returns file_path + sha256 via redirect', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n
    const expectedSha = sha256Hex(pdfBytes);
    const pdfPath = path.join(zoteroDataDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));
    const pdfUrl = pathToFileURL(pdfPath).toString();

    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/items/ATTACH123') {
        return new Response(
          JSON.stringify({
            key: 'ATTACH123',
            data: { itemType: 'attachment', filename: 'paper.pdf', contentType: 'application/pdf' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.pathname === '/api/users/0/items/ATTACH123/file') {
        return new Response('', { status: 302, headers: { location: pdfUrl } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_local', {
      mode: 'download_attachment',
      attachment_key: 'ATTACH123',
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as {
      file_path: string;
      sha256: string;
      size: number;
      source: string;
    };
    expect(payload.source).toBe('file_redirect');
    expect(payload.sha256).toBe(expectedSha);
    expect(payload.size).toBeGreaterThan(0);
    expect(fs.existsSync(payload.file_path)).toBe(true);
  });

  it('zotero_local(list_collections) rejects unexpected redirects (SSRF hardening)', async () => {
    const fetchStub = vi.fn(async (_input: any, init?: any) => {
      expect(init?.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { location: 'https://example.com/evil' } });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_local', { mode: 'list_collections' });
    expect(res.isError).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(res.content[0].text) as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe('UPSTREAM_ERROR');
    expect(payload.error?.message || '').toContain('redirect');
  });

  it('zotero_local(download_attachment) blocks linked file redirects outside allowed roots when guard enabled', async () => {
    process.env.ZOTERO_FILE_REDIRECT_GUARD = '1';

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-mcp-outside-'));
    const pdfPath = path.join(outsideDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));
    const pdfUrl = pathToFileURL(pdfPath).toString();

    try {
      const fetchStub = vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url;
        const u = new URL(url);
        if (u.pathname === '/api/users/0/items/ATTACH123') {
          return new Response(
            JSON.stringify({
              key: 'ATTACH123',
              data: { itemType: 'attachment', filename: 'paper.pdf', contentType: 'application/pdf' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (u.pathname === '/api/users/0/items/ATTACH123/file') {
          return new Response('', { status: 302, headers: { location: pdfUrl } });
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchStub as any);

      const res = await handleToolCall('zotero_local', {
        mode: 'download_attachment',
        attachment_key: 'ATTACH123',
      });
      expect(res.isError).toBe(true);

      const payload = JSON.parse(res.content[0].text) as { error?: { code?: string; message?: string } };
      expect(payload.error?.code).toBe('UPSTREAM_ERROR');
      expect(payload.error?.message || '').toContain('outside allowed roots');
    } finally {
      if (fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('zotero_local(download_attachment) allows linked file redirects when allowlist includes the file root', async () => {
    process.env.ZOTERO_FILE_REDIRECT_GUARD = '1';

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n
    const expectedSha = sha256Hex(pdfBytes);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-mcp-allowed-'));
    const pdfPath = path.join(outsideDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));
    const pdfUrl = pathToFileURL(pdfPath).toString();

    process.env.ZOTERO_FILE_REDIRECT_ALLOWED_ROOTS = outsideDir;

    try {
      const fetchStub = vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input?.url;
        const u = new URL(url);
        if (u.pathname === '/api/users/0/items/ATTACH123') {
          return new Response(
            JSON.stringify({
              key: 'ATTACH123',
              data: { itemType: 'attachment', filename: 'paper.pdf', contentType: 'application/pdf' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (u.pathname === '/api/users/0/items/ATTACH123/file') {
          return new Response('', { status: 302, headers: { location: pdfUrl } });
        }
        return new Response('not found', { status: 404 });
      });
      vi.stubGlobal('fetch', fetchStub as any);

      const res = await handleToolCall('zotero_local', {
        mode: 'download_attachment',
        attachment_key: 'ATTACH123',
      });
      expect(res.isError).not.toBe(true);

      const payload = JSON.parse(res.content[0].text) as {
        file_path: string;
        sha256: string;
        size: number;
        source: string;
      };
      expect(payload.source).toBe('file_redirect');
      expect(payload.sha256).toBe(expectedSha);
      expect(payload.size).toBeGreaterThan(0);
      expect(payload.file_path).toBe(pdfPath);
    } finally {
      if (fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
