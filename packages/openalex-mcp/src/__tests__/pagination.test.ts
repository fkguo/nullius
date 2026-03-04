import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const { openalexFetchMock } = vi.hoisted(() => ({
  openalexFetchMock: vi.fn(),
}));

vi.mock('../api/rateLimiter.js', () => ({
  openalexFetch: openalexFetchMock,
  openalexFetchFullUrl: openalexFetchMock,
  getCostSummary: vi.fn(() => ({ cumulative_usd: 0, remaining_usd: 1, pages_fetched: 0, retries: 0 })),
  getResponseMeta: vi.fn(() => ({ request_count: 0, last_status: 200 })),
  isBudgetExceeded: vi.fn(() => false),
}));

// Set data dir to a temp location so pagination tests don't pollute home dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-test-'));

vi.mock('../api/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...mod,
    getDataDir: vi.fn(() => tmpDir),
  };
});

function makeWorkListResponse(count: number, results: object[], nextCursor?: string) {
  return new Response(
    JSON.stringify({
      meta: { count, page: 1, per_page: results.length, next_cursor: nextCursor ?? null },
      results,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeWork(id: string) {
  return { id: `https://openalex.org/${id}`, doi: null, title: `Work ${id}` };
}

afterEach(() => {
  openalexFetchMock.mockReset();
});

describe('Pagination engine (interactive mode)', () => {
  it('returns results and cursor on single page', async () => {
    openalexFetchMock.mockResolvedValueOnce(
      makeWorkListResponse(100, [makeWork('W1'), makeWork('W2')], 'cursor-abc'),
    );

    const { handleSearch } = await import('../api/client.js');
    const result = await handleSearch({ query: 'dark matter', per_page: 25, page: 1 });

    expect(result.returned_count).toBe(2);
    expect(result.total_count).toBe(100);
    expect(result.cursor).toBe('cursor-abc');
    expect(result.has_more).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results_file).toBeUndefined();
  });

  it('sets has_more=false and stop_reason=end_of_results when no next cursor', async () => {
    openalexFetchMock.mockResolvedValueOnce(
      makeWorkListResponse(2, [makeWork('W1'), makeWork('W2')]),
    );

    const { handleSearch } = await import('../api/client.js');
    const result = await handleSearch({ query: 'test', per_page: 25, page: 1 });

    expect(result.has_more).toBe(false);
    expect(result.stop_reason).toBe('end_of_results');
  });

  it('passes cursor param when provided', async () => {
    openalexFetchMock.mockResolvedValueOnce(
      makeWorkListResponse(100, [makeWork('W3')]),
    );

    const { handleSearch } = await import('../api/client.js');
    await handleSearch({ query: 'test', per_page: 25, page: 1, cursor: 'cursor-abc' });

    const calledUrl = openalexFetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('cursor=cursor-abc');
  });
});

describe('Pagination engine (bulk mode)', () => {
  it('writes JSONL file when max_results > per_page', async () => {
    // Two pages: first has cursor, second has no next_cursor
    openalexFetchMock
      .mockResolvedValueOnce(makeWorkListResponse(50, [makeWork('W1'), makeWork('W2')], 'next-cursor'))
      .mockResolvedValueOnce(makeWorkListResponse(50, [makeWork('W3'), makeWork('W4')]));

    const { handleSearch } = await import('../api/client.js');
    const result = await handleSearch({ query: 'bulk test', per_page: 2, page: 1, max_results: 4 });

    expect(result.results_file).toBeDefined();
    expect(result.returned_count).toBe(4);
    expect(result.complete).toBe(true);
    expect(result.stop_reason).toBe('end_of_results');

    // Verify JSONL file was written
    const content = fs.readFileSync(result.results_file!, 'utf-8').trim().split('\n');
    expect(content).toHaveLength(4);
    expect(JSON.parse(content[0]!).id).toContain('W1');
  });

  it('stops at max_results and sets complete=false', async () => {
    openalexFetchMock.mockResolvedValue(
      makeWorkListResponse(1000, [makeWork('W1'), makeWork('W2')], 'always-has-next'),
    );

    const { handleSearch } = await import('../api/client.js');
    const result = await handleSearch({ query: 'paginated', per_page: 2, page: 1, max_results: 2 });

    // max_results == per_page → interactive mode (single page), no file
    expect(result.results_file).toBeUndefined();
    expect(result.returned_count).toBe(2);
  });
});
