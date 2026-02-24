/**
 * Tests for Zod schemas in @autoresearch/shared
 */

import { describe, it, expect } from 'vitest';
import {
  PaperIdentifiersSchema,
  AuthorSchema,
  PaperSummarySchema,
  PaginationParamsSchema,
  AnalysisTypeSchema,
  RelatedStrategySchema,
  ExpansionDirectionSchema,
  SurveyGoalSchema,
  SurveyPrioritizeSchema,
} from '../types/index.js';

describe('PaperIdentifiersSchema', () => {
  it('should validate valid identifiers', () => {
    const valid = {
      recid: '12345',
      arxiv_id: '2301.12345',
      doi: '10.1103/PhysRevD.100.014001',
    };
    expect(PaperIdentifiersSchema.parse(valid)).toEqual(valid);
  });

  it('should allow partial identifiers', () => {
    const partial = { recid: '12345' };
    expect(PaperIdentifiersSchema.parse(partial)).toEqual(partial);
  });
});

describe('AuthorSchema', () => {
  it('should validate author with full_name', () => {
    const author = { full_name: 'Witten, Edward' };
    expect(AuthorSchema.parse(author)).toEqual(author);
  });

  it('should validate author with all fields', () => {
    const author = {
      full_name: 'Witten, Edward',
      bai: 'E.Witten.1',
      affiliations: ['IAS Princeton'],
    };
    expect(AuthorSchema.parse(author)).toEqual(author);
  });
});

describe('PaperSummarySchema', () => {
  it('should validate minimal paper summary', () => {
    const paper = {
      recid: '12345',
      title: 'Test Paper',
      authors: ['Author One'],
    };
    expect(PaperSummarySchema.parse(paper)).toMatchObject(paper);
  });

  it('should validate full paper summary', () => {
    const paper = {
      recid: '12345',
      title: 'Test Paper',
      authors: ['Author One', 'Author Two'],
      year: 2024,
      citation_count: 100,
      arxiv_id: '2401.00001',
      doi: '10.1234/test',
      publication_summary: 'Phys. Rev. D 100 (2024) 014001',
    };
    const result = PaperSummarySchema.parse(paper);
    expect(result.recid).toBe('12345');
    expect(result.citation_count).toBe(100);
  });
});

describe('PaginationParamsSchema', () => {
  it('should use defaults', () => {
    const result = PaginationParamsSchema.parse({});
    expect(result.page).toBe(1);
    expect(result.size).toBe(25);
  });

  it('should respect provided values', () => {
    const result = PaginationParamsSchema.parse({ page: 2, size: 50 });
    expect(result.page).toBe(2);
    expect(result.size).toBe(50);
  });

  it('should reject size over 1000', () => {
    expect(() => PaginationParamsSchema.parse({ size: 1001 })).toThrow();
  });

  it('should accept size up to 1000', () => {
    const result = PaginationParamsSchema.parse({ size: 1000 });
    expect(result.size).toBe(1000);
  });
});

describe('Analysis Type Enums', () => {
  it('should validate AnalysisType', () => {
    expect(AnalysisTypeSchema.parse('overview')).toBe('overview');
    expect(AnalysisTypeSchema.parse('timeline')).toBe('timeline');
    expect(AnalysisTypeSchema.parse('all')).toBe('all');
  });

  it('should validate RelatedStrategy', () => {
    expect(RelatedStrategySchema.parse('high_cited_refs')).toBe('high_cited_refs');
    expect(RelatedStrategySchema.parse('co_citation')).toBe('co_citation');
    expect(RelatedStrategySchema.parse('all')).toBe('all');
  });

  it('should validate ExpansionDirection', () => {
    expect(ExpansionDirectionSchema.parse('forward')).toBe('forward');
    expect(ExpansionDirectionSchema.parse('backward')).toBe('backward');
    expect(ExpansionDirectionSchema.parse('lateral')).toBe('lateral');
  });

  it('should validate SurveyGoal', () => {
    expect(SurveyGoalSchema.parse('comprehensive_review')).toBe('comprehensive_review');
    expect(SurveyGoalSchema.parse('quick_overview')).toBe('quick_overview');
  });

  it('should validate SurveyPrioritize', () => {
    expect(SurveyPrioritizeSchema.parse('citations')).toBe('citations');
    expect(SurveyPrioritizeSchema.parse('recency')).toBe('recency');
    expect(SurveyPrioritizeSchema.parse('relevance')).toBe('relevance');
  });
});
