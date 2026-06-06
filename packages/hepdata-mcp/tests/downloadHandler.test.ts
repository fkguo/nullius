import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock the fetch layer (parallel lane owns rateLimiter/transport); the handler
// reaches HEPData only through `hepdataFetch`, so stubbing it lets us exercise
// the real download handler — getRecord + downloadSubmission + the on-disk
// per-format filename/URI mapping — without any network.
const { hepdataFetchMock } = vi.hoisted(() => ({
  hepdataFetchMock: vi.fn(),
}));

vi.mock('../src/api/rateLimiter.js', () => ({
  hepdataFetch: hepdataFetchMock,
}));

import { handleToolCall } from '../src/tools/index.js';
import { HEPDATA_DATA_DIR_ENV } from '../src/data/dataDir.js';

let dataDir: string;
let prevDataDir: string | undefined;

beforeAll(() => {
  prevDataDir = process.env[HEPDATA_DATA_DIR_ENV];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hepdata-dl-test-'));
  process.env[HEPDATA_DATA_DIR_ENV] = dataDir;
});

afterAll(() => {
  if (prevDataDir === undefined) delete process.env[HEPDATA_DATA_DIR_ENV];
  else process.env[HEPDATA_DATA_DIR_ENV] = prevDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  hepdataFetchMock.mockReset();
});

/** Mock the record-metadata fetch (getRecord) the handler issues first. */
function recordResponse(hepdataId: number, tableCount: number): Response {
  return new Response(
    JSON.stringify({
      recid: hepdataId,
      record: {
        title: 'T',
        inspire_id: null,
        arxiv_id: null,
        doi: null,
        hepdata_doi: null,
        collaborations: [],
        abstract: '',
      },
      data_tables: Array.from({ length: tableCount }, (_, i) => ({
        id: i + 1,
        name: `Table ${i + 1}`,
        doi: null,
      })),
    }),
    { status: 200 },
  );
}

/** Mock the binary submission download (downloadSubmission). */
function submissionResponse(byteLength: number): Response {
  return new Response(new ArrayBuffer(byteLength), { status: 200 });
}

async function runDownload(
  hepdataId: number,
  format: string | undefined,
  tableCount: number,
  byteLength: number,
): Promise<{ uri: string; file_path: string; size_bytes: number; tables_count: number }> {
  // First fetch = getRecord (JSON), second = downloadSubmission (bytes).
  hepdataFetchMock
    .mockResolvedValueOnce(recordResponse(hepdataId, tableCount))
    .mockResolvedValueOnce(submissionResponse(byteLength));

  const args: Record<string, unknown> = { hepdata_id: hepdataId, _confirm: true };
  if (format !== undefined) args.format = format;

  const res = await handleToolCall('hepdata_download', args);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content[0]?.text ?? '{}') as {
    uri: string;
    file_path: string;
    size_bytes: number;
    tables_count: number;
  };
}

describe('hepdata_download handler — per-format filename / URI mapping', () => {
  it('original (default) -> hepdata_submission.zip', async () => {
    const out = await runDownload(123, undefined, 15, 48);
    expect(out.uri).toBe('hepdata://artifacts/submissions/123/hepdata_submission.zip');
    expect(out.file_path.endsWith(`${path.sep}hepdata_submission.zip`)).toBe(true);
    expect(out.file_path.startsWith(dataDir)).toBe(true);
    // The submission endpoint is reached with the resolved format.
    expect(hepdataFetchMock).toHaveBeenLastCalledWith('/download/submission/123/original');
    // Contract carries through the record table count and downloaded byte size.
    expect(out.tables_count).toBe(15);
    expect(out.size_bytes).toBe(48);
    // File was actually written.
    expect(fs.existsSync(out.file_path)).toBe(true);
  });

  it('json -> hepdata_submission.json', async () => {
    const out = await runDownload(123, 'json', 3, 8);
    expect(out.uri).toBe('hepdata://artifacts/submissions/123/hepdata_submission.json');
    expect(out.file_path.endsWith(`${path.sep}hepdata_submission.json`)).toBe(true);
    expect(hepdataFetchMock).toHaveBeenLastCalledWith('/download/submission/123/json');
  });

  it('yoda.h5 -> hepdata_submission_yoda_h5.tar.gz (dot sanitized to underscore)', async () => {
    const out = await runDownload(123, 'yoda.h5', 3, 8);
    expect(out.uri).toBe('hepdata://artifacts/submissions/123/hepdata_submission_yoda_h5.tar.gz');
    expect(out.file_path.endsWith(`${path.sep}hepdata_submission_yoda_h5.tar.gz`)).toBe(true);
    expect(hepdataFetchMock).toHaveBeenLastCalledWith('/download/submission/123/yoda.h5');
  });

  it('science formats each map to a distinct hepdata_submission_<fmt>.tar.gz file (no collision)', async () => {
    const expected: Record<string, string> = {
      csv: 'hepdata_submission_csv.tar.gz',
      root: 'hepdata_submission_root.tar.gz',
      yaml: 'hepdata_submission_yaml.tar.gz',
      yoda: 'hepdata_submission_yoda.tar.gz',
      yoda1: 'hepdata_submission_yoda1.tar.gz',
    };
    const seen = new Set<string>();
    for (const [format, fileName] of Object.entries(expected)) {
      const out = await runDownload(456, format, 1, 4);
      expect(out.uri).toBe(`hepdata://artifacts/submissions/456/${fileName}`);
      expect(out.file_path.endsWith(`${path.sep}${fileName}`)).toBe(true);
      seen.add(out.file_path);
      hepdataFetchMock.mockReset();
    }
    // Every science format produced its own on-disk path.
    expect(seen.size).toBe(Object.keys(expected).length);
  });
});
