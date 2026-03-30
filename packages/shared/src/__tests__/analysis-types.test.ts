/**
 * Tests for consolidated analysis-types Zod schemas (NEW-R06).
 *
 * Exercises params and results schemas beyond the enum-only tests in schemas.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as SharedRoot from '../index.js';
import * as SharedGenerated from '../generated/index.js';
import {
  AnalyzePapersParamsSchema,
  AnalyzeCollectionParamsSchema,
  FindRelatedParamsSchema,
  ResearchExpansionParamsSchema,
  GenerateSurveyParamsSchema,
  TopicEvolutionParamsSchema,
  TopicEvolutionSchema,
  BatchImportParamsSchema,
  CollectionAnalysisSchema,
  ConnectionsResultSchema,
  RelatedPapersSchema,
  SurveyResultSchema,
  BatchImportResultSchema,
} from '../types/analysis-types.js';

describe('AnalyzePapersParamsSchema', () => {
  it('validates minimal params', () => {
    const result = AnalyzePapersParamsSchema.parse({ recids: ['123'] });
    expect(result.recids).toEqual(['123']);
    expect(result.analysis_type).toEqual(['all']);
  });

  it('rejects empty recids', () => {
    expect(() => AnalyzePapersParamsSchema.parse({ recids: [] })).toThrow();
  });
});

describe('AnalyzeCollectionParamsSchema', () => {
  it('validates with defaults', () => {
    const result = AnalyzeCollectionParamsSchema.parse({ collectionKey: 'ABC' });
    expect(result.collectionKey).toBe('ABC');
    expect(result.max_items).toBe(100);
  });
});

describe('FindRelatedParamsSchema', () => {
  it('validates with strategy', () => {
    const result = FindRelatedParamsSchema.parse({
      recids: ['123'],
      strategy: 'co_citation',
    });
    expect(result.strategy).toBe('co_citation');
    expect(result.limit).toBe(20);
  });

  it('rejects invalid strategy', () => {
    expect(() =>
      FindRelatedParamsSchema.parse({ recids: ['123'], strategy: 'invalid' }),
    ).toThrow();
  });
});

describe('ResearchExpansionParamsSchema', () => {
  it('validates with filters', () => {
    const result = ResearchExpansionParamsSchema.parse({
      seed_recids: ['123'],
      direction: 'forward',
      filters: { min_citations: 10, year_range: { start: 2020 } },
    });
    expect(result.filters?.min_citations).toBe(10);
  });
});

describe('GenerateSurveyParamsSchema', () => {
  it('validates with goal', () => {
    const result = GenerateSurveyParamsSchema.parse({
      seed_recids: ['123'],
      goal: 'comprehensive_review',
    });
    expect(result.prioritize).toBe('relevance');
  });
});

describe('TopicEvolutionParamsSchema', () => {
  it('validates minimal', () => {
    const result = TopicEvolutionParamsSchema.parse({ topic: 'QCD' });
    expect(result.granularity).toBe('year');
    expect(result.include_subtopics).toBe(false);
  });
});

describe('Analysis-type public ownership', () => {
  it('keeps runtime topic-evolution authority on the handwritten shared surface', () => {
    expect(SharedRoot.TopicEvolutionParamsSchema).toBe(TopicEvolutionParamsSchema);
    expect(SharedRoot.TopicEvolutionSchema).toBe(TopicEvolutionSchema);
    expect('TopicEvolutionParamsSchema' in SharedGenerated).toBe(false);
    expect('TopicEvolutionSchema' in SharedGenerated).toBe(false);
  });
});

describe('BatchImportParamsSchema', () => {
  it('validates with defaults', () => {
    const result = BatchImportParamsSchema.parse({ recids: ['123'] });
    expect(result.download_pdf).toBe(true);
  });
});

describe('CollectionAnalysisSchema', () => {
  it('validates minimal result', () => {
    const result = CollectionAnalysisSchema.parse({
      item_count: 42,
      date_range: { earliest: '2020-01-01', latest: '2024-12-31' },
    });
    expect(result.item_count).toBe(42);
  });
});

describe('ConnectionsResultSchema', () => {
  it('validates with edges', () => {
    const result = ConnectionsResultSchema.parse({
      internal_edges: [{ source: '1', target: '2' }],
      bridge_papers: [],
      isolated_papers: ['3'],
    });
    expect(result.internal_edges).toHaveLength(1);
  });
});

describe('RelatedPapersSchema', () => {
  it('validates result', () => {
    const result = RelatedPapersSchema.parse({
      papers: [
        {
          recid: '1',
          title: 'Test',
          authors: ['A'],
          relevance_score: 0.9,
          relevance_reason: 'cited',
          connection_count: 5,
        },
      ],
      total_candidates: 100,
    });
    expect(result.papers[0].relevance_score).toBe(0.9);
  });
});

describe('SurveyResultSchema', () => {
  it('validates minimal survey', () => {
    const result = SurveyResultSchema.parse({
      goal: 'comprehensive_review',
      sections: [
        {
          name: 'Intro',
          description: 'Overview',
          papers: [
            {
              recid: '1',
              title: 'P1',
              authors: ['A'],
              why_include: 'foundational',
              priority: 'essential',
              is_review: false,
            },
          ],
        },
      ],
      suggested_reading_order: ['1'],
    });
    expect(result.sections).toHaveLength(1);
  });
});

describe('BatchImportResultSchema', () => {
  it('validates result', () => {
    const result = BatchImportResultSchema.parse({
      total: 3,
      imported: 2,
      skipped: 0,
      failed: 1,
      details: [
        { recid: '1', status: 'imported', zotero_key: 'ZK1' },
        { recid: '2', status: 'imported' },
        { recid: '3', status: 'failed', error: 'timeout' },
      ],
    });
    expect(result.imported).toBe(2);
    expect(result.details[2].error).toBe('timeout');
  });
});
