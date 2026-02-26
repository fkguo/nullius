import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/api/client.js', () => ({
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
  getPaper: vi.fn(),
}));

const api = await import('../../src/api/client.js');

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';

function readFixtureJson<T>(fileName: string): T {
  const fixtureDir = new URL('../fixtures/core/m8/', import.meta.url);
  const p = new URL(fileName, fixtureDir);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

describe('vNext: Zotero integration', () => {
  let dataDir: string;
  let zoteroDataDir: string;
  let originalDataDirEnv: string | undefined;
  let originalZoteroBaseUrl: string | undefined;
  let originalZoteroDataDir: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.clearAllMocks();

    originalDataDirEnv = process.env.HEP_DATA_DIR;
    originalZoteroBaseUrl = process.env.ZOTERO_BASE_URL;
    originalZoteroDataDir = process.env.ZOTERO_DATA_DIR;
    originalFetch = globalThis.fetch;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
    process.env.ZOTERO_BASE_URL = 'http://127.0.0.1:23119';
    zoteroDataDir = path.join(dataDir, 'zotero-data');
    fs.mkdirSync(zoteroDataDir, { recursive: true });
    process.env.ZOTERO_DATA_DIR = zoteroDataDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (originalFetch) globalThis.fetch = originalFetch;

    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;

    if (originalZoteroBaseUrl !== undefined) process.env.ZOTERO_BASE_URL = originalZoteroBaseUrl;
    else delete process.env.ZOTERO_BASE_URL;

    if (originalZoteroDataDir !== undefined) process.env.ZOTERO_DATA_DIR = originalZoteroDataDir;
    else delete process.env.ZOTERO_DATA_DIR;

    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('hep_import_from_zotero parses identifiers and resolves recid deterministically (mocked INSPIRE)', async () => {
    const item = readFixtureJson<any>('zotero_item.min.json');
    const children = readFixtureJson<any>('zotero_children.min.json');

    vi.mocked(api.getByDoi).mockResolvedValueOnce({ recid: '999' } as any);

    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/items/ITEM1234') {
        return new Response(JSON.stringify(item), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.pathname === '/api/users/0/items/ITEM1234/children') {
        return new Response(JSON.stringify(children), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const projectRes = await handleToolCall('hep_project_create', { name: 'M8 Zotero', description: 'm8' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_import_from_zotero', {
      run_id: run.run_id,
      item_keys: ['ITEM1234'],
      concurrency: 2,
    });

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(res.content[0].text) as {
      artifacts: Array<{ name: string; uri: string }>;
      summary: { resolved_recids: number };
    };
    expect(payload.summary.resolved_recids).toBe(1);

    const mapUri = payload.artifacts.find(a => a.name === 'zotero_map_v1.json')?.uri;
    expect(mapUri).toBeTruthy();

    const map = JSON.parse((readHepResource(mapUri!) as any).text) as any;
    expect(map.items).toHaveLength(1);
    expect(map.source.concurrency).toBe(2);
    expect(map.items[0].zotero_item_key).toBe('ITEM1234');
    expect(map.items[0].identifiers.doi).toBe('10.1000/xyz');
    expect(map.items[0].identifiers.arxiv_id).toBe('2001.00001');
    expect(map.items[0].resolve.recid).toBe('999');
    expect(map.items[0].resolve.method).toBe('doi');
    expect(map.items[0].attachments.some((a: any) => a.attachment_key === 'ATTACH123')).toBe(true);

    expect(vi.mocked(api.getByDoi)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.getByArxiv)).toHaveBeenCalledTimes(0);
  });

  it('zotero_local(list_collections) is available (aggregated from zotero-mcp)', async () => {
    const fetchStub = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      const u = new URL(url);
      if (u.pathname === '/api/users/0/collections') {
        return new Response(JSON.stringify([{ key: 'C1', data: { name: 'Test' } }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchStub as any);

    const res = await handleToolCall('zotero_local', { mode: 'list_collections', limit: 1, start: 0 });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as { meta: { status: number }; collections: unknown[] };
    expect(payload.meta.status).toBe(200);
    expect(Array.isArray(payload.collections)).toBe(true);
    expect(payload.collections).toHaveLength(1);
  });
});
