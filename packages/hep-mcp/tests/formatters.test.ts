import { describe, expect, it } from 'vitest';

import { formatPaperMarkdown } from '../src/utils/formatters.js';

describe('formatPaperMarkdown', () => {
  it('prints a copy/paste-friendly IDs line when identifiers exist', () => {
    const md = formatPaperMarkdown({
      recid: '1234567',
      title: 'Test Paper',
      authors: ['Author A'],
      year: 2024,
      arxiv_id: '2301.12345',
      doi: '10.1103/PhysRevD.107.014001',
    } as any);

    expect(md).toContain(
      'IDs: recid=`1234567` | arXiv=`2301.12345` | DOI=`10.1103/PhysRevD.107.014001`'
    );
  });

  it('omits the IDs line when no identifiers exist', () => {
    const md = formatPaperMarkdown({
      title: 'Test Paper',
      authors: ['Author A'],
    } as any);

    expect(md).not.toContain('IDs:');
  });
});

