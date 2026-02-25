/**
 * H-13: Result Handling Reform — L0-L4 tests
 */
import { describe, it, expect } from 'vitest';
import { compactPaperSummary, compactPapersInResult, type CompactPaperSummary } from '../src/utils/compactPaper.js';
import {
  MAX_INLINE_RESULT_BYTES,
  HARD_CAP_RESULT_BYTES,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// L0: Compact serialization
// ─────────────────────────────────────────────────────────────────────────────

describe('L0: Compact serialization', () => {
  it('MAX_INLINE_RESULT_BYTES is 40KB', () => {
    expect(MAX_INLINE_RESULT_BYTES).toBe(40_000);
  });

  it('HARD_CAP_RESULT_BYTES is 80KB', () => {
    expect(HARD_CAP_RESULT_BYTES).toBe(80_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1: CompactPaperSummary
// ─────────────────────────────────────────────────────────────────────────────

describe('L1: compactPaperSummary', () => {
  const fullPaper = {
    recid: '123456',
    arxiv_id: '2401.12345',
    doi: '10.1103/PhysRevLett.130.071801',
    title: 'Precision measurement of something important',
    authors: ['Author A', 'Author B', 'Author C', 'Author D', 'Author E'],
    author_count: 5,
    collaborations: ['CMS'],
    year: 2024,
    earliest_date: '2024-01-24',
    citation_count: 42,
    citation_count_without_self_citations: 38,
    publication_summary: 'PRL 130 (2023) 071801 [arXiv:2301.12345]',
    inspire_url: 'https://inspirehep.net/literature/123456',
    arxiv_url: 'https://arxiv.org/abs/2401.12345',
    doi_url: 'https://doi.org/10.1103/PhysRevLett.130.071801',
    pdf_url: 'https://arxiv.org/pdf/2401.12345.pdf',
    source_url: 'https://arxiv.org/e-print/2401.12345',
    publication_type: ['review'],
    document_type: ['article'],
    texkey: 'CMS:2024abc',
    arxiv_primary_category: 'hep-ex',
    arxiv_categories: ['hep-ex', 'hep-ph'],
  };

  it('retains decision-relevant fields', () => {
    const compact = compactPaperSummary(fullPaper);
    expect(compact.recid).toBe('123456');
    expect(compact.arxiv_id).toBe('2401.12345');
    expect(compact.title).toBe('Precision measurement of something important');
    expect(compact.year).toBe(2024);
    expect(compact.citation_count).toBe(42);
    expect(compact.texkey).toBe('CMS:2024abc');
    expect(compact.arxiv_primary_category).toBe('hep-ex');
    expect(compact.publication_summary).toBe('PRL 130 (2023) 071801 [arXiv:2301.12345]');
    expect(compact.collaborations).toEqual(['CMS']);
    expect(compact.author_count).toBe(5);
  });

  it('truncates authors to 3', () => {
    const compact = compactPaperSummary(fullPaper);
    expect(compact.authors).toEqual(['Author A', 'Author B', 'Author C']);
    expect(compact.authors!.length).toBe(3);
  });

  it('drops URLs and classification arrays', () => {
    const compact = compactPaperSummary(fullPaper) as Record<string, unknown>;
    // These should NOT be present in compact
    expect(compact).not.toHaveProperty('pdf_url');
    expect(compact).not.toHaveProperty('source_url');
    expect(compact).not.toHaveProperty('inspire_url');
    expect(compact).not.toHaveProperty('arxiv_url');
    expect(compact).not.toHaveProperty('doi_url');
    expect(compact).not.toHaveProperty('publication_type');
    expect(compact).not.toHaveProperty('document_type');
    expect(compact).not.toHaveProperty('arxiv_categories');
    expect(compact).not.toHaveProperty('earliest_date');
    expect(compact).not.toHaveProperty('citation_count_without_self_citations');
    expect(compact).not.toHaveProperty('doi');
  });

  it('achieves ~63% size reduction', () => {
    const fullSize = JSON.stringify(fullPaper).length;
    const compactSize = JSON.stringify(compactPaperSummary(fullPaper)).length;
    const reduction = 1 - compactSize / fullSize;
    // At least 50% reduction (spec says ~63%)
    expect(reduction).toBeGreaterThan(0.5);
  });

  it('uses author_count from paper if available', () => {
    const compact = compactPaperSummary({ ...fullPaper, author_count: 200 });
    expect(compact.author_count).toBe(200);
  });

  it('falls back to authors.length for author_count', () => {
    const { author_count: _, ...paperNoCount } = fullPaper;
    const compact = compactPaperSummary(paperNoCount);
    expect(compact.author_count).toBe(5);
  });
});

describe('L1: compactPapersInResult', () => {
  it('compacts papers array in result object', () => {
    const result = {
      total: 2,
      papers: [
        { title: 'Paper A', authors: ['A1', 'A2', 'A3', 'A4'], inspire_url: 'https://...' },
        { title: 'Paper B', authors: ['B1'], doi_url: 'https://...' },
      ],
    };
    const compacted = compactPapersInResult(result) as Record<string, unknown>;
    const papers = compacted.papers as CompactPaperSummary[];
    expect(papers[0].title).toBe('Paper A');
    expect(papers[0].authors).toEqual(['A1', 'A2', 'A3']);
    // URL fields should be dropped
    expect((papers[0] as Record<string, unknown>)).not.toHaveProperty('inspire_url');
    expect((papers[1] as Record<string, unknown>)).not.toHaveProperty('doi_url');
  });

  it('returns original if no papers key', () => {
    const result = { foo: 'bar' };
    expect(compactPapersInResult(result)).toBe(result);
  });

  it('returns original for non-objects', () => {
    expect(compactPapersInResult('string')).toBe('string');
    expect(compactPapersInResult(null)).toBe(null);
    expect(compactPapersInResult([1, 2])).toEqual([1, 2]);
  });
});
