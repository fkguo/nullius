/**
 * Tool Handler Tests (aligned with current exposure set)
 * Updated for lazy loading architecture
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TopicEvolutionSchema } from '@nullius/shared';

// Mock the API client
vi.mock('../src/api/client.js', () => ({
  search: vi.fn(),
  searchAll: vi.fn(),
  searchByUrl: vi.fn(),
  getPaper: vi.fn(),
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
  getReferences: vi.fn(),
  getCitations: vi.fn(),
  getBibtex: vi.fn(),
  batchGetPapers: vi.fn(),
  getAuthor: vi.fn(),
}));

// Mock individual research modules for lazy loading
vi.mock('../src/tools/research/topicAnalysis.js', () => ({
  analyzeTopicUnified: vi.fn(),
}));

vi.mock('../src/tools/research/networkAnalysis.js', () => ({
  analyzeNetwork: vi.fn(),
}));

vi.mock('../src/tools/research/evidenceGrading.js', () => ({
  gradeEvidence: vi.fn(),
}));

vi.mock('../src/tools/research/criticalAnalysis.js', () => ({
  performCriticalAnalysis: vi.fn(),
}));

vi.mock('../src/tools/research/reviewClassifier.js', () => ({
  classifyReviews: vi.fn(),
}));

vi.mock('../src/tools/research/theoreticalConflicts.js', () => ({
  performTheoreticalConflicts: vi.fn(),
}));

vi.mock('../src/utils/resolveArxivId.js', () => ({
  resolveArxivIdRich: vi.fn().mockResolvedValue({ arxivId: '2301.12345' }),
  resolveArxivId: vi.fn().mockResolvedValue('2301.12345'),
}));

vi.mock('@nullius/arxiv-mcp/tooling', async () => {
  const actual = await vi.importActual('@nullius/arxiv-mcp/tooling');
  return {
    ...actual,
    accessPaperSource: vi.fn(),
  };
});

vi.mock('../src/tools/research/parseLatexContent.js', () => ({
  parseLatexContent: vi.fn(),
}));

vi.mock('../src/tools/research/findConnections.js', () => ({
  findConnections: vi.fn(),
}));

vi.mock('../src/tools/research/traceSource.js', () => ({
  traceOriginalSource: vi.fn(),
}));

vi.mock('../src/tools/research/crossoverTopics.js', () => ({
  findCrossoverTopics: vi.fn(),
}));

vi.mock('../src/tools/research/stance/index.js', () => ({
  analyzeStanceFromLatex: vi.fn(),
}));

vi.mock('../src/tools/research/cleanupDownloads.js', () => ({
  cleanupDownloads: vi.fn(),
}));

vi.mock('../src/tools/research/validateBibliography.js', () => ({
  validateBibliography: vi.fn(),
}));

vi.mock('../src/tools/research/paperClassifier.js', () => ({
  classifyPapers: vi.fn(),
}));

// Import after mocking
const { getTools, handleToolCall } = await import('../src/tools/index.js');
const api = await import('../src/api/client.js');

// Import mocked modules
const topicAnalysis = await import('../src/tools/research/topicAnalysis.js');
const networkAnalysis = await import('../src/tools/research/networkAnalysis.js');
const evidenceGrading = await import('../src/tools/research/evidenceGrading.js');
const criticalAnalysis = await import('../src/tools/research/criticalAnalysis.js');
const reviewClassifier = await import('../src/tools/research/reviewClassifier.js');
const theoreticalConflicts = await import('../src/tools/research/theoreticalConflicts.js');
const arxivTooling = await import('@nullius/arxiv-mcp/tooling');
const parseLatexContent = await import('../src/tools/research/parseLatexContent.js');
const findConnections = await import('../src/tools/research/findConnections.js');
const traceSource = await import('../src/tools/research/traceSource.js');
const crossoverTopics = await import('../src/tools/research/crossoverTopics.js');
const stance = await import('../src/tools/research/stance/index.js');
const cleanupDownloads = await import('../src/tools/research/cleanupDownloads.js');
const validateBibliography = await import('../src/tools/research/validateBibliography.js');
const paperClassifier = await import('../src/tools/research/paperClassifier.js');
const { makeProjectRoot, readProjectFile } = await import('./support/projectFiles.js');

function getBibtexEntryKey(bibtex: string): string | null {
  const cleaned = bibtex.replace(/^\uFEFF/, '').trim();
  const entryRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(cleaned)) !== null) {
    const entryType = match[1].toLowerCase();
    if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') continue;
    return match[2].trim();
  }
  return null;
}

function readTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find(item => item.type === 'text' && typeof item.text === 'string');
  return block?.text ?? '{}';
}

describe('Tool Handlers (current exposure)', () => {
  let originalDataDirEnv: string | undefined;
  let dataDir: string;
  let projectRoot: string;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-tools-test-'));
    process.env.HEP_DATA_DIR = dataDir;
    projectRoot = makeProjectRoot(dataDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Core tools (Tier 1)
  it('inspire_search should call api.search with preprocessing', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 0, papers: [], has_more: false });
    vi.mocked(paperClassifier.classifyPapers).mockReturnValue([]);

    await handleToolCall('inspire_search', { query: 'a:"guo, feng-kun"', size: 500 });

    expect(api.search).toHaveBeenCalledWith(
      'a:guo, feng-kun',
      expect.objectContaining({ size: 500 })
    );
  });

  it('inspire_search should shrink page size when explicit max_results is smaller than size', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 0, papers: [], has_more: false });
    vi.mocked(paperClassifier.classifyPapers).mockReturnValue([]);

    await handleToolCall('inspire_search', {
      query: 't:qcd',
      size: 25,
      max_results: 10,
    });

    expect(api.search).toHaveBeenCalledWith(
      't:qcd',
      expect.objectContaining({ size: 10, page: 1 })
    );
    expect(api.searchAll).not.toHaveBeenCalled();
  });

  it('inspire_search should use api.searchAll when explicit max_results exceeds page size and page is not provided', async () => {
    vi.mocked(api.searchAll).mockResolvedValueOnce({ total: 40, papers: [], has_more: false });
    vi.mocked(paperClassifier.classifyPapers).mockReturnValue([]);

    await handleToolCall('inspire_search', {
      query: 't:qcd',
      size: 25,
      max_results: 40,
    });

    expect(api.searchAll).toHaveBeenCalledWith(
      't:qcd',
      expect.objectContaining({ size: 25, max_results: 40 })
    );
    expect(api.search).not.toHaveBeenCalled();
  });

  it('inspire_search should export files when output_dir is provided', async () => {
    const papers = [
      { recid: '1', title: 'T1', authors: [] },
      { recid: '2', title: 'T2', authors: [] },
      { recid: '3', title: 'T3', authors: [] },
    ];

    vi.mocked(api.search).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(0, 2),
      has_more: true,
      next_url: 'https://inspirehep.net/api/literature?q=x&size=2&page=2',
    } as any);

    vi.mocked(api.searchByUrl).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(2),
      has_more: false,
    } as any);

    const res = await handleToolCall('inspire_search', {
      query: 't:qcd',
      project_root: projectRoot,
      output_dir: 'out',
      size: 2,
      max_results: 10,
      output_format: 'jsonl',
    });

    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(readTextBlock(res)) as {
      export_path: string;
      meta_path: string;
      summary: { total: number; exported: number; pages_fetched: number };
    };

    expect(payload.export_path).toMatch(/^out\/inspire_search_export_[0-9a-f]{16}\.jsonl$/);
    expect(payload.meta_path).toMatch(/^out\/inspire_search_export_[0-9a-f]{16}_meta\.json$/);
    expect(payload.summary.total).toBe(3);
    expect(payload.summary.exported).toBe(3);
    expect(payload.summary.pages_fetched).toBe(2);

    expect(api.search).toHaveBeenCalledWith('t:qcd', expect.objectContaining({ size: 2 }));
    expect(api.searchByUrl).toHaveBeenCalledTimes(1);
  });

  it('topicEvolution preserves legacy omitted granularity while consuming shared result authority', async () => {
    vi.mocked(api.search)
      .mockResolvedValueOnce({
        total: 2,
        papers: [
          {
            recid: 'p1',
            title: 'Phase-one paper',
            authors: ['Author A'],
            year: 2020,
            citation_count: 12,
          },
          {
            recid: 'p2',
            title: 'Phase-two paper',
            authors: ['Author B'],
            year: 2024,
            citation_count: 6,
          },
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({
        total: 3,
        papers: [],
        has_more: false,
      });

    const { analyzeTopicEvolution } = await import('../src/tools/research/topicEvolution.js');
    const result = await analyzeTopicEvolution({
      topic: 'QCD',
      start_year: 2020,
      end_year: 2024,
    });

    expect(api.search).toHaveBeenNthCalledWith(
      1,
      'QCD date:2020->2024',
      expect.objectContaining({ sort: 'mostcited', size: 1000 }),
    );
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.period).toBe('2020-2024');
    expect(TopicEvolutionSchema.parse(result)).toEqual(result);
  });

  it('topicAnalysis keeps legacy omitted granularity on the live evolution path', async () => {
    vi.mocked(api.search)
      .mockResolvedValueOnce({
        total: 2,
        papers: [
          {
            recid: 'p1',
            title: 'Phase-one paper',
            authors: ['Author A'],
            year: 2020,
            citation_count: 12,
          },
          {
            recid: 'p2',
            title: 'Phase-two paper',
            authors: ['Author B'],
            year: 2024,
            citation_count: 6,
          },
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({
        total: 3,
        papers: [],
        has_more: false,
      });

    const { analyzeTopicUnified: analyzeTopicUnifiedActual } =
      await vi.importActual('../src/tools/research/topicAnalysis.js') as typeof import('../src/tools/research/topicAnalysis.js');
    const result = await analyzeTopicUnifiedActual({
      topic: 'QCD',
      mode: 'evolution',
      options: {
        start_year: 2020,
        end_year: 2024,
      },
    });

    expect(api.search).toHaveBeenNthCalledWith(
      1,
      'QCD date:2020->2024',
      expect.objectContaining({ sort: 'mostcited', size: 1000 }),
    );
    expect(result.evolution?.phases).toHaveLength(1);
    expect(result.evolution?.phases[0]?.period).toBe('2020-2024');
  });

  it('inspire_search_next should reject review_mode="none" (compat removed)', async () => {
    const res = await handleToolCall('inspire_search_next', {
      next_url: 'https://inspirehep.net/api/literature?page=1&size=1&q=recid%3A1',
      review_mode: 'none',
    });
    expect(res.isError).toBe(true);
    expect(api.searchByUrl).not.toHaveBeenCalled();
    expect(paperClassifier.classifyPapers).not.toHaveBeenCalled();

    const payload = JSON.parse(readTextBlock(res)) as {
      error?: { code?: string; data?: { issues?: unknown[] } };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['review_mode'] })])
    );
  });

  it('inspire_search_next should accept next_url page sizes allowed by inspire_search', async () => {
    vi.mocked(api.searchByUrl).mockResolvedValueOnce({ total: 0, papers: [], has_more: false });

    const res = await handleToolCall('inspire_search_next', {
      next_url: 'https://inspirehep.net/api/literature?page=2&size=1000&q=t%3Aqcd',
    });

    expect(res.isError).not.toBe(true);
    expect(api.searchByUrl).toHaveBeenCalledWith(
      'https://inspirehep.net/api/literature?page=2&size=1000&q=t%3Aqcd',
      { max_page_size: 1000 },
    );
  });

  it('inspire_search review_mode="exclude" should keep uncertain papers visible', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({
      total: 3,
      papers: [
        { recid: '1', title: 'Explicit review' },
        { recid: '2', title: 'Uncertain metadata' },
        { recid: '3', title: 'Original paper' },
      ],
      has_more: false,
    } as any);
    vi.mocked(paperClassifier.classifyPapers).mockReturnValue([
      { recid: '1', is_review: true, review_classification: { decision: 'review' } },
      { recid: '2', is_review: false, review_classification: { decision: 'uncertain' } },
      { recid: '3', is_review: false, review_classification: { decision: 'not_review' } },
    ] as any);

    const res = await handleToolCall('inspire_search', {
      query: 't:qcd',
      review_mode: 'exclude',
      size: 10,
    });

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(readTextBlock(res)) as { papers: Array<{ recid: string }> };
    expect(payload.papers.map(p => p.recid)).toEqual(['3', '2']);
  });

  it('inspire_literature(get_paper) should call api.getPaper', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '1' } as any);
    const res = await handleToolCall('inspire_literature', { mode: 'get_paper', recid: '1' });
    expect(api.getPaper).toHaveBeenCalledWith('1');
    expect(res.isError).toBeFalsy();
  });

  it('inspire_literature(get_paper) should tolerate size for compatibility', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '854586' } as any);
    const res = await handleToolCall('inspire_literature', {
      mode: 'get_paper',
      recid: '854586',
      size: 1,
    });
    expect(api.getPaper).toHaveBeenCalledWith('854586');
    expect(res.isError).toBeFalsy();
  });

  it('inspire_literature(lookup_by_id) should route by identifier type', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '2' } as any);
    await handleToolCall('inspire_literature', { mode: 'lookup_by_id', identifier: '2' });
    expect(api.getPaper).toHaveBeenCalledWith('2');

    vi.mocked(api.getByDoi).mockResolvedValueOnce({ recid: '3' } as any);
    await handleToolCall('inspire_literature', { mode: 'lookup_by_id', identifier: '10.123/abc' });
    expect(api.getByDoi).toHaveBeenCalledWith('10.123/abc');

    vi.mocked(api.getByArxiv).mockResolvedValueOnce({ recid: '4' } as any);
    await handleToolCall('inspire_literature', { mode: 'lookup_by_id', identifier: '2301.00001' });
    expect(api.getByArxiv).toHaveBeenCalledWith('2301.00001');

    vi.mocked(api.getByArxiv).mockResolvedValueOnce({ recid: '5' } as any);
    await handleToolCall('inspire_literature', { mode: 'lookup_by_id', identifier: 'arXiv:2301.00001' });
    expect(api.getByArxiv).toHaveBeenCalledWith('arXiv:2301.00001');
  });

  it('inspire_literature(lookup_by_id) should tolerate and ignore size for agent-call compatibility', async () => {
    vi.mocked(api.getByArxiv).mockResolvedValueOnce({ recid: '2109.01038' } as any);
    const result = await handleToolCall('inspire_literature', {
      mode: 'lookup_by_id',
      identifier: '2109.01038',
      size: 1,
    } as any);

    expect(result.isError).toBeFalsy();
    expect(api.getByArxiv).toHaveBeenCalledWith('2109.01038');
  });

  it('inspire_literature(get_references) should call api.getReferences', async () => {
    vi.mocked(api.getReferences).mockResolvedValueOnce([]);
    await handleToolCall('inspire_literature', { mode: 'get_references', recid: '1', size: 10 });
    expect(api.getReferences).toHaveBeenCalledWith('1', 10);
  });

  it('inspire_literature(get_citations) should call api.getCitations', async () => {
    vi.mocked(api.getCitations).mockResolvedValueOnce({ total: 0, papers: [], has_more: false } as any);
    await handleToolCall('inspire_literature', { mode: 'get_citations', recid: '1' });
    expect(api.getCitations).toHaveBeenCalled();
  });

  it('inspire_literature(get_citations) should not forward oversized size budgets', async () => {
    vi.mocked(api.getCitations).mockResolvedValueOnce({ total: 0, papers: [], has_more: false } as any);
    const result = await handleToolCall('inspire_literature', {
      mode: 'get_citations',
      recid: '1',
      size: 5000,
    });

    expect(result.isError).toBeFalsy();
    expect(api.getCitations).toHaveBeenCalledWith('1', expect.objectContaining({ size: 25 }));
  });

  it('inspire_literature(get_citations) should fail-fast on identifier/options misuse', async () => {
    const result = await handleToolCall('inspire_literature', {
      mode: 'get_citations',
      identifier: '770691',
      options: { limit: 20 },
    } as any);

    expect(result.isError).toBe(true);
    expect(api.getCitations).not.toHaveBeenCalled();

    const payload = JSON.parse(readTextBlock(result)) as {
      error?: { code?: string; data?: { issues?: unknown[] } };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');

    const issues = payload.error?.data?.issues ?? [];
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['recid'] }),
        expect.objectContaining({
          code: 'unrecognized_keys',
          keys: expect.arrayContaining(['identifier', 'options']),
        }),
      ])
    );
  });

  it('inspire_literature(search_affiliation) should search with aff prefix', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 0, papers: [], has_more: false });
    await handleToolCall('inspire_literature', { mode: 'search_affiliation', affiliation: 'CERN' });
    expect(api.search).toHaveBeenCalledWith('aff:CERN', expect.any(Object));
  });

  it('inspire_literature(search_affiliation) should not forward oversized size budgets', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 0, papers: [], has_more: false });
    const result = await handleToolCall('inspire_literature', {
      mode: 'search_affiliation',
      affiliation: 'CERN',
      size: 5000,
    });

    expect(result.isError).toBeFalsy();
    expect(api.search).toHaveBeenCalledWith('aff:CERN', expect.objectContaining({ size: 25 }));
  });

  it('inspire_literature(get_bibtex) should call api.getBibtex', async () => {
    vi.mocked(api.getBibtex).mockResolvedValueOnce('bibtex');
    await handleToolCall('inspire_literature', { mode: 'get_bibtex', recids: ['1'] });
    expect(api.getBibtex).toHaveBeenCalledWith(['1']);
  });

  it('inspire_literature(get_bibtex) should accept a single recid string', async () => {
    vi.mocked(api.getBibtex).mockResolvedValueOnce('bibtex');
    await handleToolCall('inspire_literature', { mode: 'get_bibtex', recids: '110056' } as any);
    expect(api.getBibtex).toHaveBeenCalledWith(['110056']);
  });

  it('inspire_literature(get_author) should call api.getAuthor', async () => {
    vi.mocked(api.getAuthor).mockResolvedValueOnce({} as any);
    await handleToolCall('inspire_literature', { mode: 'get_author', identifier: 'E.Witten.1' });
    expect(api.getAuthor).toHaveBeenCalledWith('E.Witten.1');
  });

  it('inspire_literature(get_author) should tolerate and ignore size for agent-call compatibility', async () => {
    vi.mocked(api.getAuthor).mockResolvedValueOnce({ bai: 'Feng.Kun.Guo.1' } as any);
    const result = await handleToolCall('inspire_literature', {
      mode: 'get_author',
      identifier: 'Guo, Feng-Kun',
      size: 25,
    } as any);

    expect(result.isError).toBeFalsy();
    expect(api.getAuthor).toHaveBeenCalledWith('Guo, Feng-Kun');
  });

  it('inspire_resolve_citekey should resolve citekey + bibtex for a single recid', async () => {
    const recid = '2968660';
    const bibtex = '@article{Diefenbacher:2025zzn,\n  title={Agents of Discovery}\n}\n';

    vi.mocked(api.batchGetPapers).mockResolvedValueOnce([
      {
        recid,
        texkey: 'Diefenbacher:2025zzn',
        doi_url: 'https://doi.org/10.1234/abc',
        arxiv_url: 'https://arxiv.org/abs/2509.08535',
      } as any,
    ]);
    vi.mocked(api.getBibtex).mockImplementation(async ids => {
      expect(ids).toEqual([recid]);
      return bibtex;
    });

    const res = await handleToolCall('inspire_resolve_citekey', { recid });
    expect(res.isError).toBeFalsy();

    const payload = JSON.parse(readTextBlock(res)) as {
      results?: Array<{ recid: string; citekey: string; bibtex: string; links?: Record<string, string> }>;
    };

    expect(payload.results).toHaveLength(1);
    const item = payload.results![0]!;
    expect(item.recid).toBe(recid);
    expect(item.citekey).toBeTruthy();
    expect(getBibtexEntryKey(item.bibtex)).toBe(item.citekey);
    expect(item.links?.inspire).toBe(`https://inspirehep.net/literature/${recid}`);
    expect(item.links?.doi).toBe('https://doi.org/10.1234/abc');
    expect(item.links?.arxiv).toBe('https://arxiv.org/abs/2509.08535');
  });

  it('inspire_resolve_citekey should resolve citekey + bibtex for recids batch', async () => {
    const recidA = '2968660';
    const recidB = '3062816';
    const bibtexA = '@article{Diefenbacher:2025zzn,\n  title={Agents of Discovery}\n}\n';
    const bibtexB = '@article{Doe:2026abc,\n  title={Example Paper}\n}\n';

    vi.mocked(api.batchGetPapers).mockResolvedValueOnce([
      { recid: recidA, texkey: 'Diefenbacher:2025zzn', arxiv_url: 'https://arxiv.org/abs/2509.08535' } as any,
      { recid: recidB, texkey: 'Doe:2026abc', doi_url: 'https://doi.org/10.5678/def' } as any,
    ]);
    vi.mocked(api.getBibtex).mockImplementation(async ids => {
      expect(ids).toEqual([recidA, recidB]);
      return `${bibtexA}\n\n${bibtexB}`;
    });

    const res = await handleToolCall('inspire_resolve_citekey', { recids: [recidA, recidB] });
    expect(res.isError).toBeFalsy();

    const payload = JSON.parse(readTextBlock(res)) as {
      results?: Array<{ recid: string; citekey: string; bibtex: string }>;
    };

    expect(payload.results?.map(r => r.recid)).toEqual([recidA, recidB]);
    for (const item of payload.results ?? []) {
      expect(item.citekey).toBeTruthy();
      expect(getBibtexEntryKey(item.bibtex)).toBe(item.citekey);
    }
  });

  // Consolidated tools (Tier 2)
  it('inspire_topic_analysis should call analyzeTopicUnified', async () => {
    vi.mocked(topicAnalysis.analyzeTopicUnified).mockResolvedValueOnce({ ok: true } as any);
    const res = await handleToolCall('inspire_topic_analysis', {
      topic: 'qcd',
      mode: 'timeline',
    });
    expect(topicAnalysis.analyzeTopicUnified).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
  });

  it('inspire_network_analysis should call analyzeNetwork', async () => {
    vi.mocked(networkAnalysis.analyzeNetwork).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_network_analysis', {
      mode: 'citation',
      seed: '123',
    });
    expect(networkAnalysis.analyzeNetwork).toHaveBeenCalled();
  });

  it('inspire_find_connections should call findConnections', async () => {
    vi.mocked(findConnections.findConnections).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_find_connections', {
      recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });
    expect(findConnections.findConnections).toHaveBeenCalledWith({
      recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });
  });

  it('inspire_trace_original_source should call traceOriginalSource', async () => {
    vi.mocked(traceSource.traceOriginalSource).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_trace_original_source', {
      recid: '1',
      max_depth: 3,
      max_refs_per_level: 2,
      cross_validate: true,
    });
    expect(traceSource.traceOriginalSource).toHaveBeenCalledWith({
      recid: '1',
      max_depth: 3,
      max_refs_per_level: 2,
      cross_validate: true,
    });
  });

  it('inspire_grade_evidence should call gradeEvidence', async () => {
    vi.mocked(evidenceGrading.gradeEvidence).mockResolvedValueOnce({ ok: true } as any);
    const createMessage = vi.fn();

    await handleToolCall(
      'inspire_grade_evidence',
      { recid: '1' },
      'standard',
      { createMessage }
    );

    expect(evidenceGrading.gradeEvidence).toHaveBeenCalledWith(
      { recid: '1' },
      { createMessage }
    );
  });

  it.each(['standard', 'full'] as const)('refuses the retired measurement operator in %s without executing providers or sampling', async mode => {
    const createMessage = vi.fn();
    const callTool = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    try {
      const response = await handleToolCall(
        'inspire_detect_measurement_conflicts',
        { project_root: projectRoot, recids: ['1', '2'], target_quantities: ['W mass'] },
        mode,
        { createMessage, callTool }
      );
      expect(response.isError).toBe(true);
      expect(readTextBlock(response)).toContain('Unknown tool: inspire_detect_measurement_conflicts');
      expect(api.getPaper).not.toHaveBeenCalled();
      expect(arxivTooling.accessPaperSource).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(createMessage).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('inspire_critical_analysis should call performCriticalAnalysis', async () => {
    vi.mocked(criticalAnalysis.performCriticalAnalysis).mockResolvedValueOnce({ ok: true } as any);
    const createMessage = vi.fn();

    await handleToolCall(
      'inspire_critical_analysis',
      { recid: '1' },
      'standard',
      { createMessage }
    );

    expect(criticalAnalysis.performCriticalAnalysis).toHaveBeenCalledWith(
      { recid: '1' },
      { createMessage }
    );
  });

  it('inspire_classify_reviews should call classifyReviews', async () => {
    vi.mocked(reviewClassifier.classifyReviews).mockResolvedValueOnce({ ok: true } as any);
    const createMessage = vi.fn();

    await handleToolCall(
      'inspire_classify_reviews',
      { recids: ['1', '2'] },
      'standard',
      { createMessage }
    );

    expect(reviewClassifier.classifyReviews).toHaveBeenCalledWith(
      { recids: ['1', '2'] },
      { createMessage }
    );
  });

  it('inspire_theoretical_conflicts should call performTheoreticalConflicts', async () => {
    vi.mocked(theoreticalConflicts.performTheoreticalConflicts).mockResolvedValueOnce({ ok: true } as any);
    const createMessage = vi.fn();

    await handleToolCall(
      'inspire_theoretical_conflicts',
      { output_dir: 'out', recids: ['1', '2'] },
      'standard',
      { createMessage }
    );

    expect(theoreticalConflicts.performTheoreticalConflicts).toHaveBeenCalledWith(
      { output_dir: 'out', recids: ['1', '2'] },
      { createMessage }
    );
  });

  it('inspire_paper_source should call accessPaperSource', async () => {
    vi.mocked(arxivTooling.accessPaperSource).mockResolvedValueOnce({
      mode: 'urls', identifier: '2301.12345',
      provenance: { downloaded: false, retrieval_level: 'urls_only' },
    } as any);
    await handleToolCall('inspire_paper_source', { identifier: '123', mode: 'urls' });
    expect(arxivTooling.accessPaperSource).toHaveBeenCalled();
  });

  it('inspire_paper_source(metadata) should return structured fallback when no arXiv id exists', async () => {
    const resolveArxivIdModule = await import('../src/utils/resolveArxivId.js');
    vi.mocked(resolveArxivIdModule.resolveArxivIdRich).mockResolvedValueOnce({ arxivId: null, recid: '1821180' });

    const res = await handleToolCall('inspire_paper_source', { identifier: '1821180', mode: 'metadata' });

    expect(res.isError).toBeFalsy();
    expect(arxivTooling.accessPaperSource).not.toHaveBeenCalled();

    const payload = JSON.parse(readTextBlock(res)) as {
      mode: string;
      identifier: string;
      provenance?: { retrieval_level?: string; source_available?: boolean | null };
      urls?: { has_source?: boolean; source_available?: boolean | null; inspire_url?: string };
      error?: string;
    };

    expect(payload.mode).toBe('metadata');
    expect(payload.identifier).toBe('1821180');
    expect(payload.provenance?.retrieval_level).toBe('none');
    expect(payload.urls?.has_source).toBe(false);
    expect(payload.urls?.inspire_url).toBe('https://inspirehep.net/literature/1821180');
    expect(payload.error).toContain('Could not resolve arXiv ID');
  });

  it('inspire_parse_latex should require output_dir', async () => {
    const res = await handleToolCall('inspire_parse_latex', {
      project_root: projectRoot,
      identifier: '123',
      components: ['sections'],
    } as any);

    expect(res.isError).toBe(true);
    const payload = JSON.parse(readTextBlock(res)) as {
      error?: { code?: string; data?: { issues?: Array<{ path?: unknown[] }> } };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.issues?.some(issue => issue.path?.includes('output_dir'))).toBe(true);
    expect(parseLatexContent.parseLatexContent).not.toHaveBeenCalled();
  });

  it('inspire_parse_latex refuses an unknown nested option instead of dropping it', async () => {
    const res = await handleToolCall('inspire_parse_latex', {
      project_root: projectRoot,
      output_dir: 'parsed',
      identifier: '123',
      components: ['sections'],
      options: { max_dept: 3 },
    } as any);
    expect(res.isError).toBe(true);
    const payload = JSON.parse(readTextBlock(res)) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(readTextBlock(res)).toContain('max_dept');
    expect(parseLatexContent.parseLatexContent).not.toHaveBeenCalled();
  });

  it('the published schemas list no optional numeric option as required, and runtime accepts empty and partial options', async () => {
    const parseLatex = getTools('full').find(t => t.name === 'inspire_parse_latex')!;
    expect((parseLatex.inputSchema as any).properties.options.required ?? []).toEqual([]);
    const zotero = getTools('full').find(t => t.name === 'hep_import_from_zotero')!;
    expect((zotero.inputSchema as any).required).toEqual(['output_dir']);
    vi.mocked(parseLatexContent.parseLatexContent).mockResolvedValue({
      metadata: { title: 'T', authors: [], abstract: '', arxiv_id: '1234.5678', source_file: '/tmp/main.tex' },
      summary: { counts: {} },
    } as any);
    for (const [dir, options] of [['opt-empty', {}], ['opt-partial', { include_inline_math: true }]] as const) {
      const res = await handleToolCall('inspire_parse_latex', {
        project_root: projectRoot, output_dir: dir, identifier: '123', components: ['sections'], options,
      } as any);
      expect(res.isError, readTextBlock(res)).toBeFalsy();
    }
    vi.mocked(parseLatexContent.parseLatexContent).mockReset();
  });

  it('inspire_parse_latex passes exactly the parser options it declares and refuses the ones it never read', async () => {
    for (const removed of [{ format: 'markdown' }, { max_depth: 1 }, { include_external: true }, { cross_validate: true }]) {
      const refused = await handleToolCall('inspire_parse_latex', {
        project_root: projectRoot, output_dir: 'parsed', identifier: '123', components: ['sections'], options: removed,
      } as any);
      expect(refused.isError, JSON.stringify(removed)).toBe(true);
    }
    expect(parseLatexContent.parseLatexContent).not.toHaveBeenCalled();

    vi.mocked(parseLatexContent.parseLatexContent).mockResolvedValueOnce({
      metadata: { title: 'T', authors: [], abstract: '', arxiv_id: '1234.5678', source_file: '/tmp/main.tex' },
      summary: { counts: {} },
    } as any);
    const options = {
      include_key_equations: false,
      include_inline_math: true,
      include_section_content: true,
      max_section_content: '500',
      include_proofs: false,
      citation_context_window: 0,
      parse_table_data: false,
    };
    const res = await handleToolCall('inspire_parse_latex', {
      project_root: projectRoot, output_dir: 'parsed-options', identifier: '123', components: ['sections'], options,
    } as any);
    expect(res.isError).toBeFalsy();
    expect(vi.mocked(parseLatexContent.parseLatexContent).mock.calls[0]?.[0]).toMatchObject({
      options: { ...options, max_section_content: 500 },
    });
  });

  it('inspire_parse_latex should write its result into output_dir and return path+summary', async () => {
    vi.mocked(parseLatexContent.parseLatexContent).mockResolvedValueOnce({
      metadata: {
        title: 'T',
        authors: [],
        abstract: '',
        arxiv_id: '1234.5678',
        source_file: '/tmp/main.tex',
      },
      summary: {
        components_extracted: ['sections'],
        counts: { sections: 2 },
      },
      sections: [],
    } as any);

    const res = await handleToolCall('inspire_parse_latex', {
      project_root: projectRoot,
      output_dir: 'parsed',
      identifier: '123',
      components: ['sections'],
      options: { include_section_content: true, max_section_content: 2 },
    });

    expect(res.isError).toBeFalsy();
    expect(parseLatexContent.parseLatexContent).toHaveBeenCalledWith({
      identifier: '123',
      components: ['sections'],
      options: { include_section_content: true, max_section_content: 2 },
    });

    const payload = JSON.parse(readTextBlock(res)) as {
      path?: string;
      summary?: { artifact_name?: string; output_dir?: string; counts?: Record<string, number> };
    };
    expect(payload.path).toMatch(/^parsed\/parse_latex_[a-f0-9]{16}\.json$/);
    expect(payload.summary?.artifact_name).toMatch(/^parse_latex_[a-f0-9]{16}\.json$/);
    expect(payload.summary?.output_dir).toBe('parsed');
    expect(payload.summary?.counts).toEqual({ sections: 2 });
    const written = JSON.parse(readProjectFile(projectRoot, payload.path!)) as { result: { summary: { counts: Record<string, number> } } };
    expect(written.result.summary.counts).toEqual({ sections: 2 });
  });

  it('inspire_literature(search_affiliation) validation should fail on missing affiliation', async () => {
    const result = await handleToolCall('inspire_literature', { mode: 'search_affiliation' } as any);
    expect(result.isError).toBe(true);
  });

  // Full-only whitelist tools
  it('full-only tools should be rejected in standard mode', async () => {
    const result = await handleToolCall('inspire_cleanup_downloads', { _confirm: true, dry_run: true });
    expect(result.isError).toBe(true);
  });

  it('inspire_find_crossover_topics should call findCrossoverTopics', async () => {
    vi.mocked(crossoverTopics.findCrossoverTopics).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_find_crossover_topics', {}, 'full');
    expect(crossoverTopics.findCrossoverTopics).toHaveBeenCalled();
  });

  it('inspire_analyze_citation_stance should call analyzeStanceFromLatex', async () => {
    vi.mocked(stance.analyzeStanceFromLatex).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_analyze_citation_stance', { latex_content: 'text', target_recid: '1' }, 'full');
    expect(stance.analyzeStanceFromLatex).toHaveBeenCalled();
  });

  it('inspire_cleanup_downloads should call cleanupDownloads', async () => {
    vi.mocked(cleanupDownloads.cleanupDownloads).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_cleanup_downloads', { _confirm: true, dry_run: true }, 'full');
    expect(cleanupDownloads.cleanupDownloads).toHaveBeenCalled();
  });

  it('inspire_validate_bibliography should call validateBibliography', async () => {
    vi.mocked(validateBibliography.validateBibliography).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_validate_bibliography', { identifier: '123' }, 'full');
    expect(validateBibliography.validateBibliography).toHaveBeenCalled();
  });
});
