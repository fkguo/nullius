import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/client.js', () => ({
  search: vi.fn(),
}));

vi.mock('../src/api/rateLimiter.js', () => ({
  arxivFetch: vi.fn(),
  inspireFetch: vi.fn(),
}));

const rateLimiter = await import('../src/api/rateLimiter.js');
const { getDownloadUrls } = await import('../src/tools/research/downloadUrls.js');

describe('getDownloadUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns source_available=null when check_availability=false', async () => {
    const result = await getDownloadUrls({ identifier: '2301.12345', check_availability: false });
    expect(result.source_available).toBeNull();
    expect(result.has_source).toBe(false);
    expect(vi.mocked(rateLimiter.arxivFetch)).not.toHaveBeenCalled();
  });

  it('returns source_available=true when check_availability=true and HEAD ok', async () => {
    vi.mocked(rateLimiter.arxivFetch).mockResolvedValueOnce({ ok: true } as any);

    const result = await getDownloadUrls({ identifier: '2301.12345', check_availability: true });
    expect(result.source_available).toBe(true);
    expect(result.has_source).toBe(true);
    expect(vi.mocked(rateLimiter.arxivFetch)).toHaveBeenCalledTimes(1);
  });

  it('returns source_available=false when check_availability=true and HEAD not ok', async () => {
    vi.mocked(rateLimiter.arxivFetch).mockResolvedValueOnce({ ok: false } as any);

    const result = await getDownloadUrls({ identifier: '2301.12345', check_availability: true });
    expect(result.source_available).toBe(false);
    expect(result.has_source).toBe(false);
    expect(vi.mocked(rateLimiter.arxivFetch)).toHaveBeenCalledTimes(1);
  });
});

