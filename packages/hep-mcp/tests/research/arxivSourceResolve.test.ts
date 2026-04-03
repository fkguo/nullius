import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  search: vi.fn(),
  getPaper: vi.fn(),
  getByDoi: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { resolveArxivId, resolveArxivIdRich } = await import('../../src/utils/resolveArxivId.js');

describe('arxivSource.resolveArxivId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('treats inspire:<recid> identifiers as direct getPaper lookups', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '627760', arxiv_id: 'hep-ex/0309032' } as any);
    const arxivId = await resolveArxivId('inspire:627760');
    expect(vi.mocked(api.getPaper)).toHaveBeenCalledWith('627760');
    expect(arxivId).toBe('hep-ex/0309032');
  });

  it('treats numeric identifiers as direct getPaper lookups', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '1258603', arxiv_id: '1310.4101' } as any);
    const arxivId = await resolveArxivId('1258603');
    expect(vi.mocked(api.getPaper)).toHaveBeenCalledWith('1258603');
    expect(arxivId).toBe('1310.4101');
  });

  it('treats DOI identifiers as direct getByDoi lookups', async () => {
    vi.mocked(api.getByDoi).mockResolvedValueOnce({ doi: '10.1234/test', arxiv_id: '2401.01234' } as any);
    const arxivId = await resolveArxivId('10.1234/test');
    expect(vi.mocked(api.getByDoi)).toHaveBeenCalledWith('10.1234/test');
    expect(arxivId).toBe('2401.01234');
  });

  it('rich resolve preserves recid even when no arXiv identifier exists', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '1821180' } as any);
    const resolved = await resolveArxivIdRich('1821180');
    expect(resolved).toEqual({ arxivId: null, recid: '1821180', doi: undefined });
  });
});
