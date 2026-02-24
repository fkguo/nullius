import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tools/research/downloadUrls.js', () => ({
  getDownloadUrls: vi.fn(),
}));

vi.mock('../src/tools/research/paperContent.js', () => ({
  getPaperContent: vi.fn(),
}));

vi.mock('../src/tools/research/arxivSource.js', () => ({
  getArxivSource: vi.fn(),
}));

const downloadUrls = await import('../src/tools/research/downloadUrls.js');
const paperContent = await import('../src/tools/research/paperContent.js');
const arxivSource = await import('../src/tools/research/arxivSource.js');
const { accessPaperSource } = await import('../src/tools/research/paperSource.js');

describe('accessPaperSource provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mode=urls sets provenance.retrieval_level=urls_only and passes through source_available', async () => {
    vi.mocked(downloadUrls.getDownloadUrls).mockResolvedValueOnce({
      has_source: false,
      source_available: null,
    } as any);

    const result = await accessPaperSource({ identifier: '123', mode: 'urls' });

    expect(result.provenance).toEqual({
      downloaded: false,
      retrieval_level: 'urls_only',
      source_available: null,
    });
  });

  it('mode=metadata sets provenance.retrieval_level=metadata_only', async () => {
    vi.mocked(arxivSource.getArxivSource).mockResolvedValueOnce({
      metadata: { arxiv_id: '2301.12345', title: 't', authors: [] },
      source_url: 'src',
      pdf_url: 'pdf',
      abs_url: 'abs',
      source_available: true,
    } as any);

    const result = await accessPaperSource({ identifier: '2301.12345', mode: 'metadata' });

    expect(result.provenance).toEqual({
      downloaded: false,
      retrieval_level: 'metadata_only',
    });
  });

  it('mode=content (latex) sets provenance.retrieval_level=latex_source and downloaded=true', async () => {
    vi.mocked(paperContent.getPaperContent).mockResolvedValueOnce({
      success: true,
      source_type: 'latex',
      file_path: '/tmp/paper',
      arxiv_id: '2301.12345',
    } as any);

    const result = await accessPaperSource({ identifier: '2301.12345', mode: 'content' });

    expect(result.provenance).toEqual({
      downloaded: true,
      retrieval_level: 'latex_source',
      source_available: true,
    });
  });

  it('mode=content (pdf) sets provenance.retrieval_level=pdf_only and downloaded=true', async () => {
    vi.mocked(paperContent.getPaperContent).mockResolvedValueOnce({
      success: true,
      source_type: 'pdf',
      file_path: '/tmp/paper.pdf',
      arxiv_id: '2301.12345',
    } as any);

    const result = await accessPaperSource({ identifier: '2301.12345', mode: 'content' });

    expect(result.provenance).toEqual({
      downloaded: true,
      retrieval_level: 'pdf_only',
    });
  });

  it('mode=content (failed) sets provenance.retrieval_level=none and downloaded=false', async () => {
    vi.mocked(paperContent.getPaperContent).mockResolvedValueOnce({
      success: false,
      source_type: 'pdf',
      file_path: '',
      arxiv_id: '',
      error: 'fail',
    } as any);

    const result = await accessPaperSource({ identifier: 'bad', mode: 'content' });

    expect(result.provenance).toEqual({
      downloaded: false,
      retrieval_level: 'none',
    });
  });

  it('mode=auto probes urls with check_availability=true', async () => {
    vi.mocked(downloadUrls.getDownloadUrls).mockResolvedValueOnce({
      has_source: true,
      source_available: true,
    } as any);

    const result = await accessPaperSource({ identifier: '2301.12345', mode: 'auto' });

    expect(vi.mocked(downloadUrls.getDownloadUrls)).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: '2301.12345', check_availability: true })
    );

    expect(result.provenance).toEqual({
      downloaded: false,
      retrieval_level: 'urls_only',
      source_available: true,
    });
  });
});

