import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/api/client.js', () => ({
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
  search: vi.fn(),
}));

const api = await import('../../../src/api/client.js');

import type { BibEntry } from '../../../src/tools/research/latex/bibliographyExtractor.js';
import { mapBibEntryToInspire } from '../../../src/tools/research/latex/citekeyMapper.js';
import { buildAllowedCitationsArtifact } from '../../../src/core/citations.js';

describe('citekeyMapper (M5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matches by DOI', async () => {
    const entry: BibEntry = {
      key: 'Doe:2020ab',
      type: 'article',
      doi: '10.1000/xyz',
    };

    vi.mocked(api.getByDoi).mockResolvedValue({
      recid: '100',
      title: 'Paper',
      authors: ['Doe, John'],
      year: 2020,
    } as any);

    const res = await mapBibEntryToInspire(entry);

    expect(res.status).toBe('matched');
    expect(res.match_method).toBe('doi');
    expect(res.recid).toBe('100');
  });

  it('matches by arXiv ID', async () => {
    const entry: BibEntry = {
      key: 'SomeKey',
      type: 'article',
      arxiv_id: '2301.01234',
    };

    vi.mocked(api.getByArxiv).mockResolvedValue({
      recid: '200',
      title: 'Paper',
      authors: ['Doe, John'],
      year: 2023,
    } as any);

    const res = await mapBibEntryToInspire(entry);

    expect(res.status).toBe('matched');
    expect(res.match_method).toBe('arxiv');
    expect(res.recid).toBe('200');
  });

  it('matches by INSPIRE texkey', async () => {
    const entry: BibEntry = {
      key: 'Smith:2020ab',
      type: 'article',
    };

    vi.mocked(api.search).mockResolvedValue({
      total: 1,
      papers: [
        { recid: '300', title: 'Paper', authors: ['Smith, A'], year: 2020, texkey: 'Smith:2020ab' },
      ],
      has_more: false,
    } as any);

    const res = await mapBibEntryToInspire(entry);

    expect(res.status).toBe('matched');
    expect(res.match_method).toBe('texkey');
    expect(res.recid).toBe('300');
  });

  it('matches by journal_ref', async () => {
    const entry: BibEntry = {
      key: 'NotATexkey',
      type: 'article',
      journal: 'Phys. Rev. D',
      volume: '90',
      pages: '015004',
      year: '2018',
    };

    vi.mocked(api.search).mockResolvedValue({
      total: 1,
      papers: [
        { recid: '400', title: 'Paper', authors: ['A'], year: 2018, texkey: 'X:2018aa' },
      ],
      has_more: false,
    } as any);

    const res = await mapBibEntryToInspire(entry);

    expect(res.status).toBe('matched');
    expect(res.match_method).toBe('journal_ref');
    expect(res.recid).toBe('400');
  });

  it('matches by title+author+year with confidence + candidates', async () => {
    const entry: BibEntry = {
      key: 'CustomKey',
      type: 'article',
      title: 'Quantum Widget Dynamics',
      authors: ['Doe, John and Roe, Jane'],
      year: '2020',
    };

    vi.mocked(api.search).mockResolvedValue({
      total: 2,
      papers: [
        { recid: '500', title: 'Quantum Widget Dynamics', authors: ['John Doe'], year: 2020 },
        { recid: '501', title: 'Widget Dynamics', authors: ['Someone Else'], year: 2020 },
      ],
      has_more: false,
    } as any);

    const res = await mapBibEntryToInspire(entry);

    expect(res.status).toBe('matched');
    expect(res.match_method).toBe('title_author_year');
    expect(res.recid).toBe('500');
    expect(res.confidence).toBeGreaterThan(0.78);
    expect(res.candidates?.length).toBeGreaterThanOrEqual(1);
  });

  it('builds allowed_citations.json with toggleable secondary allowlist', () => {
    const primary = ['inspire:1', '2'];
    const secondary = ['3', 'inspire:4', '4'];

    const primaryOnly = buildAllowedCitationsArtifact({
      include_mapped_references: false,
      allowed_citations_primary: primary,
      allowed_citations_secondary: secondary,
    });

    expect(primaryOnly.allowed_citations).toContain('inspire:1');
    expect(primaryOnly.allowed_citations).toContain('inspire:2');
    expect(primaryOnly.allowed_citations).not.toContain('inspire:3');

    const withSecondary = buildAllowedCitationsArtifact({
      include_mapped_references: true,
      allowed_citations_primary: primary,
      allowed_citations_secondary: secondary,
    });

    expect(withSecondary.allowed_citations).toContain('inspire:1');
    expect(withSecondary.allowed_citations).toContain('inspire:2');
    expect(withSecondary.allowed_citations).toContain('inspire:3');
    expect(withSecondary.allowed_citations).toContain('inspire:4');
  });
});

