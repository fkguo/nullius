import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

vi.mock('@autoresearch/arxiv-mcp/tooling', async () => {
  const actual = await vi.importActual('@autoresearch/arxiv-mcp/tooling');
  return {
    ...actual,
    arxivFetch: vi.fn(),
  };
});

const downloader = await import('../../src/corpora/style/downloader.js');
const paths = await import('../../src/corpora/style/paths.js');
const paperKeyMod = await import('../../src/corpora/style/paperKey.js');
const arxivTooling = await import('@autoresearch/arxiv-mcp/tooling');

function webBodyFromBytes(bytes: Uint8Array): ReadableStream {
  // Node >=18 supports Readable.toWeb(); cast to avoid TS DOM lib assumptions.
  return Readable.toWeb(Readable.from([bytes])) as unknown as ReadableStream;
}

describe('StyleCorpus downloader', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-downloader-'));
    process.env.HEP_DATA_DIR = dataDir;
    vi.mocked(arxivTooling.arxivFetch).mockReset();
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not leave empty extracted/ dir when LaTeX fails but PDF succeeds', async () => {
    const arxivFetch = vi.mocked(arxivTooling.arxivFetch);
    arxivFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = (options?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url.includes('/src/')) {
        return { ok: true, headers: { get: () => 'application/x-eprint-tar' } } as any;
      }
      if (method === 'GET' && url.includes('/src/')) {
        return { ok: false, status: 404, statusText: 'Not Found' } as any;
      }
      if (method === 'GET' && url.includes('/pdf/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: webBodyFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46])), // "%PDF"
          headers: { get: () => 'application/pdf' },
        } as any;
      }
      return { ok: false, status: 500, statusText: 'Unexpected' } as any;
    });

    const entry = {
      version: 1,
      style_id: 'rmp',
      recid: '1',
      title: 'T1',
      arxiv_id: '1234.5678',
      status: 'planned',
    } as const;

    const res = await downloader.downloadCorpusPapers({ style_id: 'rmp', entries: [entry], concurrency: 1 });
    expect(res.updated[0]?.status).toBe('downloaded');
    expect(res.updated[0]?.source?.source_type).toBe('pdf');

    const sourcesDir = paths.getCorpusSourcesDir('rmp');
    const pdfDir = paths.getCorpusPdfDir('rmp');
    const paperKey = paperKeyMod.paperKeyForRecid('1');

    expect(fs.existsSync(path.join(pdfDir, `${paperKey}.pdf`))).toBe(true);
    expect(fs.existsSync(path.join(sourcesDir, paperKey, 'extracted'))).toBe(false);
  });

  it('treats zero-byte PDF downloads as errors (and avoids marking downloaded)', async () => {
    const arxivFetch = vi.mocked(arxivTooling.arxivFetch);
    arxivFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      const method = (options?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url.includes('/src/')) {
        return { ok: true, headers: { get: () => 'application/pdf' } } as any;
      }
      if (method === 'GET' && url.includes('/pdf/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          body: webBodyFromBytes(new Uint8Array([])),
          headers: { get: () => 'application/pdf' },
        } as any;
      }
      return { ok: false, status: 500, statusText: 'Unexpected' } as any;
    });

    const entry = {
      version: 1,
      style_id: 'rmp',
      recid: '2',
      title: 'T2',
      arxiv_id: '9999.0000',
      status: 'planned',
    } as const;

    const res = await downloader.downloadCorpusPapers({ style_id: 'rmp', entries: [entry], concurrency: 1 });
    expect(res.updated[0]?.status).toBe('error');

    const sourcesDir = paths.getCorpusSourcesDir('rmp');
    const pdfDir = paths.getCorpusPdfDir('rmp');
    const paperKey = paperKeyMod.paperKeyForRecid('2');

    expect(fs.existsSync(path.join(pdfDir, `${paperKey}.pdf`))).toBe(false);
    expect(fs.existsSync(path.join(sourcesDir, paperKey, 'extracted'))).toBe(false);
  });
});
