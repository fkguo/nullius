import { describe, expect, it } from 'vitest';

import {
  CanonicalPaperSchema,
  DiscoveryDedupArtifactSchema,
  canonicalizeDiscoveryCandidates,
  type CanonicalCandidate,
} from '../index.js';

const confidentCandidates: CanonicalCandidate[] = [
  {
    provider: 'inspire',
    identifiers: { recid: '12345', doi: '10.1000/example', arxiv_id: '2501.00001' },
    title: 'Cross-provider canonical identity for HEP papers',
    authors: ['A. Author', 'B. Author'],
    year: 2025,
    citation_count: 42,
    matched_by: ['exact_doi', 'exact_arxiv_id'],
    provenance: { source: 'inspire_search', query: '10.1000/example' },
  },
  {
    provider: 'openalex',
    identifiers: { openalex_id: 'W2741809807', doi: '10.1000/example' },
    title: 'Cross-provider canonical identity for HEP papers',
    authors: ['A. Author', 'B. Author'],
    year: 2025,
    citation_count: 40,
    matched_by: ['exact_doi'],
    provenance: { source: 'openalex_get', query: '10.1000/example' },
  },
  {
    provider: 'arxiv',
    identifiers: { arxiv_id: '2501.00001' },
    title: 'Cross-provider canonical identity for HEP papers',
    authors: ['A. Author', 'B. Author'],
    year: 2025,
    matched_by: ['exact_arxiv_id'],
    provenance: { source: 'arxiv_metadata', query: '2501.00001' },
  },
];

describe('canonicalizeDiscoveryCandidates', () => {
  it('confidently merges candidates linked by exact identifiers', () => {
    const result = canonicalizeDiscoveryCandidates({
      query: '10.1000/example',
      candidates: confidentCandidates,
    });

    expect(result.papers).toHaveLength(1);
    expect(result.dedup.confident_merges).toHaveLength(1);
    expect(result.dedup.uncertain_groups).toHaveLength(0);

    const paper = CanonicalPaperSchema.parse(result.papers[0]);
    expect(paper.provider_sources).toEqual(['arxiv', 'inspire', 'openalex']);
    expect(paper.identifiers).toMatchObject({
      recid: '12345',
      doi: '10.1000/example',
      arxiv_id: '2501.00001',
      openalex_id: 'W2741809807',
    });
    expect(paper.merge_state).toBe('confident_match');
    expect(paper.merge_confidence).toBe('high');
    expect(paper.source_candidates).toHaveLength(3);

    const dedup = DiscoveryDedupArtifactSchema.parse(result.dedup);
    expect(dedup.confident_merges[0]?.match_reasons).toContain('exact_doi');
    expect(dedup.confident_merges[0]?.match_reasons).toContain('exact_arxiv_id');
  });

  it('rejects malformed canonical papers that drop provenance', () => {
    expect(() =>
      CanonicalPaperSchema.parse({
        canonical_key: 'paper:doi:10.1000/example',
        title: 'Malformed canonical paper',
        authors: ['A. Author'],
        provider_sources: ['openalex'],
        merge_state: 'confident_match',
        merge_confidence: 'high',
        match_reasons: ['exact_doi'],
        source_candidates: [],
      }))
      .toThrow(/source_candidates/i);
  });
});
