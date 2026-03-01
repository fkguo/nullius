/**
 * M-21 (payload size/backpressure) contract tests.
 */
import { describe, expect, it } from 'vitest';

import { STDIO_MAX_RESULT_BYTES, MAX_INLINE_RESULT_BYTES, HARD_CAP_RESULT_BYTES } from '@autoresearch/shared';
import { compactPapersInResult } from '../../src/utils/compactPaper.js';
import { inferMimeType } from '../../src/tools/dispatcher.js';

// ── M-21: STDIO_MAX_RESULT_BYTES constant ──────────────────────────────────

describe('M-21: STDIO_MAX_RESULT_BYTES', () => {
  it('is 100KB', () => {
    expect(STDIO_MAX_RESULT_BYTES).toBe(100 * 1024);
  });

  it('is greater than HARD_CAP_RESULT_BYTES', () => {
    expect(STDIO_MAX_RESULT_BYTES).toBeGreaterThan(HARD_CAP_RESULT_BYTES);
  });

  it('MAX_INLINE < HARD_CAP < STDIO_MAX hierarchy', () => {
    expect(MAX_INLINE_RESULT_BYTES).toBeLessThan(HARD_CAP_RESULT_BYTES);
    expect(HARD_CAP_RESULT_BYTES).toBeLessThan(STDIO_MAX_RESULT_BYTES);
  });
});

// ── M-21 R2 fix #1: compactPapersInResult handles raw arrays ───────────────

describe('M-21 R2: compactPapersInResult raw array handling', () => {
  const fullPaper = {
    recid: '123',
    arxiv_id: '2301.00001',
    title: 'Test Paper',
    authors: ['Author A', 'Author B', 'Author C', 'Author D'],
    author_count: 4,
    year: 2023,
    citation_count: 10,
    texkey: 'Test:2023abc',
    arxiv_primary_category: 'hep-ph',
    publication_summary: 'Published in JHEP',
    // Fields that should be stripped by compaction
    urls: [{ value: 'https://example.com' }],
    arxiv_eprints: [{ value: '2301.00001' }],
    keywords: [{ value: 'qcd' }],
    inspire_categories: ['Phenomenology-HEP'],
    collaborations: ['LHCb'],
  };

  it('compacts raw PaperSummary[] array (get_references return format)', () => {
    const raw = [fullPaper, { ...fullPaper, recid: '456', title: 'Another Paper' }];
    const result = compactPapersInResult(raw);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Record<string, unknown>[];
    expect(arr).toHaveLength(2);
    // Should have compact fields
    expect(arr[0]).toHaveProperty('title', 'Test Paper');
    expect(arr[0]).toHaveProperty('recid', '123');
    // Should NOT have full fields
    expect(arr[0]).not.toHaveProperty('urls');
    expect(arr[0]).not.toHaveProperty('arxiv_eprints');
    expect(arr[0]).not.toHaveProperty('keywords');
    expect(arr[0]).not.toHaveProperty('inspire_categories');
    // Authors should be truncated to 3
    expect(arr[0]!.authors).toEqual(['Author A', 'Author B', 'Author C']);
  });

  it('handles {papers: [...]} object format (get_citations return format)', () => {
    const obj = { total: 2, papers: [fullPaper] };
    const result = compactPapersInResult(obj) as Record<string, unknown>;
    expect(result).toHaveProperty('total', 2);
    const papers = result.papers as Record<string, unknown>[];
    expect(papers).toHaveLength(1);
    expect(papers[0]).not.toHaveProperty('urls');
  });

  it('returns original array if no items have title (non-paper array)', () => {
    const raw = [{ id: 1 }, { id: 2 }];
    const result = compactPapersInResult(raw);
    expect(result).toBe(raw); // Same reference
  });

  it('returns primitives unchanged', () => {
    expect(compactPapersInResult(null)).toBeNull();
    expect(compactPapersInResult('hello')).toBe('hello');
    expect(compactPapersInResult(42)).toBe(42);
  });
});

// ── M-21 R2 fix #2: MIME type inference (production code) ──────────────────

describe('M-21 R2: inferMimeType (production function)', () => {
  it('JSON artifacts → application/json', () => {
    expect(inferMimeType('hep://runs/r1/artifact/evidence_catalog_v1.json')).toBe('application/json');
  });

  it('JSONL artifacts → application/x-ndjson', () => {
    expect(inferMimeType('hep://runs/r1/artifact/spans.jsonl')).toBe('application/x-ndjson');
  });

  it('Markdown artifacts → text/markdown', () => {
    expect(inferMimeType('hep://runs/r1/artifact/packet.md')).toBe('text/markdown');
  });

  it('LaTeX artifacts → text/x-latex', () => {
    expect(inferMimeType('hep://runs/r1/artifact/paper.tex')).toBe('text/x-latex');
  });

  it('unknown extension → application/octet-stream', () => {
    expect(inferMimeType('hep://runs/r1/artifact/data.bin')).toBe('application/octet-stream');
  });

  it('no extension → application/octet-stream', () => {
    expect(inferMimeType('hep://runs/r1/artifact/somefile')).toBe('application/octet-stream');
  });

  it('handles URI-encoded names', () => {
    expect(inferMimeType('hep://runs/r1/artifact/my%20paper.tex')).toBe('text/x-latex');
  });
});
