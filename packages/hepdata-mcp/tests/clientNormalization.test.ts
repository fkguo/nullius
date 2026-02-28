import { afterEach, describe, expect, it, vi } from 'vitest';

const { hepdataFetchMock } = vi.hoisted(() => ({
  hepdataFetchMock: vi.fn(),
}));

vi.mock('../src/api/rateLimiter.js', () => ({
  hepdataFetch: hepdataFetchMock,
}));

import { getRecord, searchRecords } from '../src/api/client.js';

afterEach(() => {
  hepdataFetchMock.mockReset();
});

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
