/**
 * Tool Handler Tests (aligned with current exposure set)
 * Updated for lazy loading architecture
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API client
vi.mock('../src/api/client.js', () => ({
  search: vi.fn(),
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

vi.mock('../src/tools/research/discoverPapers.js', () => ({
  discoverPapers: vi.fn(),
}));

vi.mock('../src/tools/research/networkAnalysis.js', () => ({
  analyzeNetwork: vi.fn(),
}));

vi.mock('../src/tools/research/criticalResearch.js', () => ({
  performCriticalResearch: vi.fn(),
}));

vi.mock('../src/utils/resolveArxivId.js', () => ({
  resolveArxivIdRich: vi.fn().mockResolvedValue({ arxivId: '2301.12345' }),
  resolveArxivId: vi.fn().mockResolvedValue('2301.12345'),
}));

vi.mock('@autoresearch/arxiv-mcp/tooling', async () => {
  const actual = await vi.importActual('@autoresearch/arxiv-mcp/tooling');
  return {
    ...actual,
    accessPaperSource: vi.fn(),
  };
});

vi.mock('../src/tools/research/deepResearch.js', () => ({
  performDeepResearch: vi.fn(),
}));

vi.mock('../src/tools/research/fieldSurvey.js', () => ({
  performFieldSurvey: vi.fn(),
}));

vi.mock('../src/tools/research/parseLatexContent.js', () => ({
  parseLatexContent: vi.fn(),
}));

vi.mock('../src/tools/research/experts.js', () => ({
  findExperts: vi.fn(),
}));

vi.mock('../src/tools/research/analyzePapers.js', () => ({
  analyzePapers: vi.fn(),
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

vi.mock('../src/core/citations.js', async () => {
  const actual = await vi.importActual('../src/core/citations.js') as object;
  return {
    ...actual,
    writeRunJsonArtifact: vi.fn(),
  };
});

// Import after mocking
const { handleToolCall } = await import('../src/tools/index.js');
const api = await import('../src/api/client.js');

// Import mocked modules
const topicAnalysis = await import('../src/tools/research/topicAnalysis.js');
const discoverPapers = await import('../src/tools/research/discoverPapers.js');
const networkAnalysis = await import('../src/tools/research/networkAnalysis.js');
const criticalResearch = await import('../src/tools/research/criticalResearch.js');
const arxivTooling = await import('@autoresearch/arxiv-mcp/tooling');
const deepResearch = await import('../src/tools/research/deepResearch.js');
const fieldSurvey = await import('../src/tools/research/fieldSurvey.js');
const parseLatexContent = await import('../src/tools/research/parseLatexContent.js');
const experts = await import('../src/tools/research/experts.js');
const analyzePapers = await import('../src/tools/research/analyzePapers.js');
const findConnections = await import('../src/tools/research/findConnections.js');
const traceSource = await import('../src/tools/research/traceSource.js');
const crossoverTopics = await import('../src/tools/research/crossoverTopics.js');
const stance = await import('../src/tools/research/stance/index.js');
const cleanupDownloads = await import('../src/tools/research/cleanupDownloads.js');
const validateBibliography = await import('../src/tools/research/validateBibliography.js');
const paperClassifier = await import('../src/tools/research/paperClassifier.js');
const citations = await import('../src/core/citations.js');

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

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-tools-test-'));
    process.env.HEP_DATA_DIR = dataDir;
    vi.clearAllMocks();

    vi.mocked(citations.writeRunJsonArtifact).mockImplementation((runId: string, artifactName: string, data: unknown) => {
      const runArtifactsDir = path.join(dataDir, 'runs', runId, 'artifacts');
      fs.mkdirSync(runArtifactsDir, { recursive: true });
      fs.writeFileSync(path.join(runArtifactsDir, artifactName), JSON.stringify(data, null, 2), 'utf-8');
      return {
        name: artifactName,
        uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`,
        mimeType: 'application/json',
      };
    });

    fs.mkdirSync(path.join(dataDir, 'runs', 'run_test', 'artifacts'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'runs', 'run_test', 'manifest.json'),
      JSON.stringify(
        {
          run_id: 'run_test',
          project_id: 'proj_test',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: 'pending',
          steps: [],
        },
        null,
        2
      ),
      'utf-8'
    );
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

  it('inspire_search should export artifacts when run_id is provided', async () => {
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
      run_id: 'run_test',
      size: 2,
      max_results: 10,
      output_format: 'jsonl',
    });

    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(readTextBlock(res)) as {
      export_uri: string;
      meta_uri: string;
      summary: { total: number; exported: number; pages_fetched: number };
    };

    expect(payload.export_uri).toMatch(/^hep:\/\/runs\/run_test\/artifact\//);
    expect(payload.meta_uri).toMatch(/^hep:\/\/runs\/run_test\/artifact\//);
    expect(payload.summary.total).toBe(3);
    expect(payload.summary.exported).toBe(3);
    expect(payload.summary.pages_fetched).toBe(2);

    expect(api.search).toHaveBeenCalledWith('t:qcd', expect.objectContaining({ size: 2 }));
    expect(api.searchByUrl).toHaveBeenCalledTimes(1);
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

  it('inspire_literature(get_paper) should call api.getPaper', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '1' } as any);
    const res = await handleToolCall('inspire_literature', { mode: 'get_paper', recid: '1' });
    expect(api.getPaper).toHaveBeenCalledWith('1');
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
  it('inspire_research_navigator(topic_analysis) should call analyzeTopicUnified', async () => {
    vi.mocked(topicAnalysis.analyzeTopicUnified).mockResolvedValueOnce({ ok: true } as any);
    const res = await handleToolCall('inspire_research_navigator', {
      mode: 'topic_analysis',
      topic: 'qcd',
      topic_mode: 'timeline',
    });
    expect(topicAnalysis.analyzeTopicUnified).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
  });

  it('inspire_research_navigator(discover) should call discoverPapers', async () => {
    vi.mocked(discoverPapers.discoverPapers).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_research_navigator', {
      mode: 'discover',
      discover_mode: 'seminal',
      topic: 'qcd',
    });
    expect(discoverPapers.discoverPapers).toHaveBeenCalled();
  });

  it('inspire_research_navigator(network) should call analyzeNetwork', async () => {
    vi.mocked(networkAnalysis.analyzeNetwork).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_research_navigator', {
      mode: 'network',
      network_mode: 'citation',
      seed: '123',
    });
    expect(networkAnalysis.analyzeNetwork).toHaveBeenCalled();
  });

  it('inspire_research_navigator(experts) should call findExperts', async () => {
    vi.mocked(experts.findExperts).mockResolvedValueOnce({ topic: 'qcd', experts: [] } as any);
    await handleToolCall('inspire_research_navigator', {
      mode: 'experts',
      topic: 'qcd',
      limit: 5,
    });
    expect(experts.findExperts).toHaveBeenCalledWith({ topic: 'qcd', limit: 5 });
  });

  it('inspire_research_navigator(connections) should call findConnections', async () => {
    vi.mocked(findConnections.findConnections).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_research_navigator', {
      mode: 'connections',
      seed_recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });
    expect(findConnections.findConnections).toHaveBeenCalledWith({
      recids: ['1', '2'],
      include_external: true,
      max_external_depth: 2,
    });
  });

  it('inspire_research_navigator(trace_source) should call traceOriginalSource', async () => {
    vi.mocked(traceSource.traceOriginalSource).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_research_navigator', {
      mode: 'trace_source',
      seed: '1',
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

  it('inspire_research_navigator(analyze) should call analyzePapers', async () => {
    vi.mocked(analyzePapers.analyzePapers).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_research_navigator', {
      mode: 'analyze',
      recids: ['1'],
      analysis_type: ['overview'],
    });
    expect(analyzePapers.analyzePapers).toHaveBeenCalledWith({ recids: ['1'], analysis_type: ['overview'] });
  });

  it('inspire_critical_research should call performCriticalResearch', async () => {
    vi.mocked(criticalResearch.performCriticalResearch).mockResolvedValueOnce({ ok: true } as any);
    const createMessage = vi.fn();

    await handleToolCall(
      'inspire_critical_research',
      { mode: 'evidence', recids: ['1'] },
      'standard',
      { createMessage }
    );

    expect(criticalResearch.performCriticalResearch).toHaveBeenCalledWith(
      { mode: 'evidence', recids: ['1'] },
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

  it('inspire_deep_research should call performDeepResearch', async () => {
    vi.mocked(deepResearch.performDeepResearch).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_deep_research', { identifiers: ['1'], mode: 'analyze' });
    expect(deepResearch.performDeepResearch).toHaveBeenCalled();
  });

  it('inspire_research_navigator(field_survey) should call performFieldSurvey', async () => {
    vi.mocked(fieldSurvey.performFieldSurvey).mockResolvedValueOnce({ ok: true } as any);
    await handleToolCall('inspire_research_navigator', { mode: 'field_survey', topic: 'qcd' });
    expect(fieldSurvey.performFieldSurvey).toHaveBeenCalled();
  });

  it('inspire_parse_latex should require run_id', async () => {
    const res = await handleToolCall('inspire_parse_latex', {
      identifier: '123',
      components: ['sections'],
    } as any);

    expect(res.isError).toBe(true);
    const payload = JSON.parse(readTextBlock(res)) as {
      error?: { code?: string; data?: { next_actions?: Array<{ tool?: string }> } };
    };
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.next_actions?.map(a => a.tool)).toEqual(['hep_project_create', 'hep_run_create']);
  });

  it('inspire_parse_latex should write artifact and return uri+summary', async () => {
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
      run_id: 'run_test',
      identifier: '123',
      components: ['sections'],
      options: { cross_validate: true, max_depth: 2 },
    });

    expect(res.isError).toBeFalsy();
    expect(parseLatexContent.parseLatexContent).toHaveBeenCalledWith({
      identifier: '123',
      components: ['sections'],
      options: { cross_validate: true, max_depth: 2 },
    });

    const payload = JSON.parse(readTextBlock(res)) as {
      uri?: string;
      summary?: { artifact_name?: string; run_id?: string; counts?: Record<string, number> };
    };
    expect(payload.uri).toMatch(/^hep:\/\/runs\/run_test\/artifact\/parse_latex_[a-f0-9]{16}\.json$/);
    expect(payload.summary?.artifact_name).toMatch(/^parse_latex_[a-f0-9]{16}\.json$/);
    expect(payload.summary?.run_id).toBe('run_test');
    expect(payload.summary?.counts).toEqual({ sections: 2 });
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
