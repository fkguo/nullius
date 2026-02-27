import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/source/arxivSource.js', () => ({
  normalizeArxivId: vi.fn((id: string) => (id.match(/^\d{4}\.\d{4,5}/) ? id : null)),
  checkSourceAvailability: vi.fn(),
}));

const arxivSource = await import('../src/source/arxivSource.js');
const { getDownloadUrls } = await import('../src/source/downloadUrls.js');

describe('getDownloadUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(arxivSource.normalizeArxivId).mockImplementation(
      (id: string) => (id.match(/^\d{4}\.\d{4,5}/) ? id : null)
    );
  });

  it('returns source_available=null when check_availability=false', async () => {
    const result = await getDownloadUrls({ identifier: '2301.12345', check_availability: false });
    expect(result.source_available).toBeNull();
    expect(result.has_source).toBe(false);
    expect(vi.mocked(arxivSource.checkSourceAvailability)).not.toHaveBeenCalled();
  });

  it('returns source_available=true when check_availability=true and source ok', async () => {
    vi.mocked(arxivSource.checkSourceAvailability).mockResolvedValueOnce(true);
    const result = await getDownloadUrls({ identifier: '2301.12345', check_availability: true });
    expect(result.source_available).toBe(true);
    expect(result.has_source).toBe(true);
    expect(vi.mocked(arxivSource.checkSourceAvailability)).toHaveBeenCalledTimes(1);
  });

  it('returns source_available=false when check_availability=true and source not ok', async () => {
    vi.mocked(arxivSource.checkSourceAvailability).mockResolvedValueOnce(false);
    const result = await getDownloadUrls({ identifier: '2301.12345', check_availability: true });
    expect(result.source_available).toBe(false);
    expect(result.has_source).toBe(false);
    expect(vi.mocked(arxivSource.checkSourceAvailability)).toHaveBeenCalledTimes(1);
  });
});
