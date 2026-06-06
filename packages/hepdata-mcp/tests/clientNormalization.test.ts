import { afterEach, describe, expect, it, vi } from 'vitest';

const { hepdataFetchMock } = vi.hoisted(() => ({
  hepdataFetchMock: vi.fn(),
}));

vi.mock('../src/api/rateLimiter.js', () => ({
  hepdataFetch: hepdataFetchMock,
}));

import {
  downloadSubmission,
  getRecord,
  getTable,
  searchRecords,
  type HepDataTableData,
} from '../src/api/client.js';

afterEach(() => {
  hepdataFetchMock.mockReset();
});

function searchPage(ids: number[], total: number): Response {
  return new Response(
    JSON.stringify({
      total,
      results: ids.map(id => ({
        id,
        title: `record ${id}`,
        inspire_id: null,
        arxiv_id: null,
        collaborations: [],
        total_tables: 0,
        doi: null,
      })),
    }),
    { status: 200 },
  );
}

describe('HEPData client normalization', () => {
  it('normalizes search inspire_id strings to numeric inspire_recid', async () => {
    hepdataFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          results: [
            {
              id: 105881,
              title: 'Precise determination',
              inspire_id: '1857623',
              arxiv_id: 'arXiv:2104.04421',
              collaborations: ['LHCb'],
              total_tables: 1,
              doi: '10.1038/s41567-021-01394-x',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await searchRecords({ query: 'LHCb', size: 1 });
    expect(result.results[0]?.inspire_recid).toBe(1857623);
    expect(typeof result.results[0]?.inspire_recid).toBe('number');
  });

  it('normalizes record inspire_id strings to numeric inspire_recid', async () => {
    hepdataFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          recid: 105881,
          record: {
            title: 'Precise determination',
            inspire_id: '1857623',
            arxiv_id: 'arXiv:2104.04421',
            doi: '10.1038/s41567-021-01394-x',
            hepdata_doi: '10.17182/hepdata.105881.v1',
            collaborations: ['LHCb'],
            abstract: '...'
          },
          data_tables: [{ id: 1140582, name: 'Figure 3', doi: null }],
        }),
        { status: 200 },
      ),
    );

    const record = await getRecord(105881);
    expect(record.inspire_recid).toBe(1857623);
    expect(typeof record.inspire_recid).toBe('number');
  });

  it('maps non-numeric inspire_id to null', async () => {
    hepdataFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          results: [
            {
              id: 1,
              title: 'Bad record',
              inspire_id: 'not-a-number',
              arxiv_id: null,
              collaborations: [],
              total_tables: 0,
              doi: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await searchRecords({ query: 'bad', size: 1 });
    expect(result.results[0]?.inspire_recid).toBeNull();
  });
});

describe('HEPData getTable formats', () => {
  it('returns parsed object for json', async () => {
    hepdataFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ name: 'Table 1', description: 'd', doi: null, headers: [], values: [] }),
        { status: 200 },
      ),
    );

    const out = await getTable(42, 'json');
    expect(hepdataFetchMock).toHaveBeenCalledWith('/download/table/42/json');
    expect(typeof out).toBe('object');
    expect((out as HepDataTableData).name).toBe('Table 1');
  });

  it('returns raw text for yaml', async () => {
    hepdataFetchMock.mockResolvedValue(new Response('name: Table\nvalues: []\n', { status: 200 }));

    const out = await getTable(42, 'yaml');
    expect(hepdataFetchMock).toHaveBeenCalledWith('/download/table/42/yaml');
    expect(out).toBe('name: Table\nvalues: []\n');
  });

  it('returns raw text for csv (not JSON-parsed)', async () => {
    hepdataFetchMock.mockResolvedValue(new Response('x,y\n1,2\n', { status: 200 }));

    const out = await getTable(42, 'csv');
    expect(hepdataFetchMock).toHaveBeenCalledWith('/download/table/42/csv');
    expect(out).toBe('x,y\n1,2\n');
    expect(typeof out).toBe('string');
  });
});

describe('HEPData downloadSubmission formats', () => {
  it('defaults to the original submission path', async () => {
    hepdataFetchMock.mockResolvedValue(new Response(new ArrayBuffer(8), { status: 200 }));

    await downloadSubmission(123);
    expect(hepdataFetchMock).toHaveBeenCalledWith('/download/submission/123/original');
  });

  it('builds the format-specific submission path for each format', async () => {
    for (const format of ['json', 'csv', 'root', 'yaml', 'yoda', 'yoda1', 'yoda.h5'] as const) {
      hepdataFetchMock.mockReset();
      hepdataFetchMock.mockResolvedValue(new Response(new ArrayBuffer(4), { status: 200 }));
      await downloadSubmission(123, format);
      expect(hepdataFetchMock).toHaveBeenCalledWith(`/download/submission/123/${format}`);
    }
  });
});

describe('HEPData searchRecords bounded auto-pagination', () => {
  it('single page when max_results is omitted (effective default = size)', async () => {
    hepdataFetchMock.mockResolvedValue(searchPage([1, 2, 3], 99));

    const result = await searchRecords({ query: 'x', size: 3 });
    expect(hepdataFetchMock).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(99);
    expect(result.results.map(r => r.hepdata_id)).toEqual([1, 2, 3]);
  });

  it('accumulates across pages until max_results is reached', async () => {
    hepdataFetchMock
      .mockResolvedValueOnce(searchPage([1, 2, 3], 99))
      .mockResolvedValueOnce(searchPage([4, 5, 6], 99))
      .mockResolvedValueOnce(searchPage([7, 8, 9], 99));

    const result = await searchRecords({ query: 'x', size: 3, max_results: 7 });
    // 3 pages of 3 = 9 fetched, sliced to 7.
    expect(hepdataFetchMock).toHaveBeenCalledTimes(3);
    expect(result.results.map(r => r.hepdata_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.total).toBe(99);
    // Page numbers increment from the start page.
    expect(hepdataFetchMock.mock.calls[0]?.[0]).toContain('page=1');
    expect(hepdataFetchMock.mock.calls[1]?.[0]).toContain('page=2');
    expect(hepdataFetchMock.mock.calls[2]?.[0]).toContain('page=3');
  });

  it('stops early when a short page signals no more results', async () => {
    hepdataFetchMock
      .mockResolvedValueOnce(searchPage([1, 2, 3], 5))
      .mockResolvedValueOnce(searchPage([4, 5], 5)); // short page -> stop

    const result = await searchRecords({ query: 'x', size: 3, max_results: 50 });
    expect(hepdataFetchMock).toHaveBeenCalledTimes(2);
    expect(result.results.map(r => r.hepdata_id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('clamps max_results to the 200 hard cap (no unbounded crawl)', async () => {
    // Always-full pages of 25 would loop forever without the cap; with the cap
    // the loop performs at most ceil(200/25)=8 fetches and yields exactly 200.
    hepdataFetchMock.mockImplementation(() =>
      Promise.resolve(searchPage(Array.from({ length: 25 }, (_, i) => i + 1), 100000)),
    );

    const result = await searchRecords({ query: 'x', size: 25, max_results: 100000 });
    expect(result.results.length).toBe(200);
    expect(hepdataFetchMock).toHaveBeenCalledTimes(8);
  });
});
