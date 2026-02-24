import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  search: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { resolveArxivId } = await import('../../src/tools/research/arxivSource.js');

describe('arxivSource.resolveArxivId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('treats inspire:<recid> identifiers as recid:<recid> search queries', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ papers: [{ arxiv_id: 'hep-ex/0309032' }] } as any);
    const arxivId = await resolveArxivId('inspire:627760');
    expect(vi.mocked(api.search)).toHaveBeenCalledWith('recid:627760', { size: 1 });
    expect(arxivId).toBe('hep-ex/0309032');
  });

  it('treats numeric identifiers as recid:<recid> search queries', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ papers: [{ arxiv_id: '1310.4101' }] } as any);
    const arxivId = await resolveArxivId('1258603');
    expect(vi.mocked(api.search)).toHaveBeenCalledWith('recid:1258603', { size: 1 });
    expect(arxivId).toBe('1310.4101');
  });
});

