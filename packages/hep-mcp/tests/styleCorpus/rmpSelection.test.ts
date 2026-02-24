import { describe, it, expect } from 'vitest';

import { buildStratifiedSelection, searchAllPapers, type InspireSearchClient } from '../../src/corpora/style/selection.js';
import { StyleProfileSchema } from '../../src/corpora/style/schemas.js';

describe('RMP selection (R1)', () => {
  it('paginates without hidden truncation', async () => {
    const calls: Array<{ page?: number; size?: number }> = [];
    const client: InspireSearchClient = {
      async search(_query, options) {
        calls.push({ page: options?.page, size: options?.size });
        const page = options?.page ?? 1;

        const all = [
          { recid: '1', title: 'P1', authors: [], year: 2018 },
          { recid: '2', title: 'P2', authors: [], year: 2018 },
          { recid: '3', title: 'P3', authors: [], year: 2018 },
          { recid: '4', title: 'P4', authors: [], year: 2018 },
          { recid: '5', title: 'P5', authors: [], year: 2018 },
        ];

        const size = options?.size ?? 2;
        const start = (page - 1) * size;
        const papers = all.slice(start, start + size) as any;
        return {
          total: all.length,
          papers,
          has_more: start + size < all.length,
        };
      },
    };

    const res = await searchAllPapers(client, 'j:Rev.Mod.Phys.', { page_size: 2, max_results: 100 });
    expect(res.total).toBe(5);
    expect(res.papers.map(p => p.recid)).toEqual(['1', '2', '3', '4', '5']);
    expect(calls).toEqual([
      { page: 1, size: 2 },
      { page: 2, size: 2 },
      { page: 3, size: 2 },
    ]);
  });

  it('forwards arxiv_categories option to client.search', async () => {
    const calls: Array<{ arxiv_categories?: string }> = [];
    const client: InspireSearchClient = {
      async search(_query, options) {
        calls.push({ arxiv_categories: options?.arxiv_categories });
        return { total: 0, papers: [], has_more: false };
      },
    };

    await searchAllPapers(client, 'j:Rev.Mod.Phys.', { page_size: 2, max_results: 100, arxiv_categories: 'hep-ph' });
    expect(calls).toEqual([{ arxiv_categories: 'hep-ph' }]);
  });

  it('selects reproducible stratified list with deterministic fill', () => {
    const profile = StyleProfileSchema.parse({
      version: 1,
      style_id: 'rmp',
      title: 'Rev. Mod. Phys.',
      inspire_query: 'j:Rev.Mod.Phys.',
      selection: {
        strategy: 'stratified_v1',
        target_categories: ['hep-th', 'hep-ph'],
        year_bins: [
          { id: '2010s', start_year: 2010, end_year: 2019 },
          { id: '2020s', start_year: 2020, end_year: 2029 },
        ],
        sort_within_stratum: 'mostcited',
      },
      defaults: { target_papers: 200 },
    });

    const candidates: any[] = [
      // hep-th__2010s
      { recid: '1', title: 'T1', authors: [], year: 2015, citation_count: 10, arxiv_primary_category: 'hep-th' },
      { recid: '2', title: 'T2', authors: [], year: 2015, citation_count: 5, arxiv_primary_category: 'hep-th' },
      // hep-ph__2010s
      { recid: '3', title: 'P1', authors: [], year: 2014, citation_count: 7, arxiv_primary_category: 'hep-ph' },
      // hep-th__2020s
      { recid: '4', title: 'T3', authors: [], year: 2021, citation_count: 3, arxiv_primary_category: 'hep-th' },
      // fill-only (non-target category)
      { recid: '10', title: 'Other', authors: [], year: 2012, citation_count: 999, arxiv_primary_category: 'cond-mat' },
    ];

    const sel = buildStratifiedSelection({ profile, candidates: candidates as any, target_papers: 5 });
    expect(sel.selected.map(s => s.paper.recid)).toEqual(['1', '2', '4', '3', '10']);
    expect(sel.stats.by_stratum['hep-th__2010s']).toBe(2);
    expect(sel.stats.by_stratum['hep-th__2020s']).toBe(1);
    expect(sel.stats.by_stratum['hep-ph__2010s']).toBe(1);
    expect(sel.stats.filled).toBe(1);
  });
});
