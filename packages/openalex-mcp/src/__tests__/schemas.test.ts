import { describe, it, expect } from 'vitest';
import {
  OpenAlexSearchSchema,
  OpenAlexSemanticSearchSchema,
  OpenAlexGetSchema,
  OpenAlexFilterSchema,
  OpenAlexGroupSchema,
  OpenAlexReferencesSchema,
  OpenAlexCitationsSchema,
  OpenAlexBatchSchema,
  OpenAlexAutocompleteSchema,
  OpenAlexContentSchema,
  OpenAlexRateLimitSchema,
} from '../tools/schemas.js';

describe('OpenAlex Zod schemas', () => {
  describe('OpenAlexSearchSchema', () => {
    it('accepts minimal valid input', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: 'dark matter' });
      expect(result.success).toBe(true);
    });

    it('applies default per_page=25', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: 'dark matter' });
      expect(result.success && result.data.per_page).toBe(25);
    });

    it('rejects empty query', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: '' });
      expect(result.success).toBe(false);
    });

    it('rejects seed without sample', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: 'test', seed: 42 });
      expect(result.success).toBe(false);
    });

    it('accepts seed with sample', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: 'test', sample: 10, seed: 42 });
      expect(result.success).toBe(true);
    });

    it('falls back to default per_page when per_page > 200', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: 'test', per_page: 201 });
      expect(result.success).toBe(true);
      expect(result.success && result.data.per_page).toBe(25);
    });

    it('parses page strings polluted with control characters', () => {
      const result = OpenAlexSearchSchema.safeParse({ query: 'test', page: '\r\t2' });
      expect(result.success).toBe(true);
      expect(result.success && result.data.page).toBe(2);
    });
  });

  describe('OpenAlexGetSchema', () => {
    it('accepts OpenAlex ID', () => {
      const result = OpenAlexGetSchema.safeParse({ id: 'W2741809807' });
      expect(result.success).toBe(true);
    });

    it('accepts DOI', () => {
      const result = OpenAlexGetSchema.safeParse({ id: '10.1038/nature12373' });
      expect(result.success).toBe(true);
    });

    it('rejects missing id', () => {
      const result = OpenAlexGetSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('OpenAlexFilterSchema', () => {
    it('requires both entity and filter', () => {
      expect(OpenAlexFilterSchema.safeParse({}).success).toBe(false);
      expect(OpenAlexFilterSchema.safeParse({ entity: 'works' }).success).toBe(false);
      expect(OpenAlexFilterSchema.safeParse({ filter: 'is_oa:true' }).success).toBe(false);
    });

    it('accepts valid entity and filter', () => {
      const result = OpenAlexFilterSchema.safeParse({ entity: 'works', filter: 'is_oa:true' });
      expect(result.success).toBe(true);
    });

    it('rejects invalid entity', () => {
      const result = OpenAlexFilterSchema.safeParse({ entity: 'papers', filter: 'is_oa:true' });
      expect(result.success).toBe(false);
    });
  });

  describe('OpenAlexGroupSchema', () => {
    it('requires entity and group_by', () => {
      expect(OpenAlexGroupSchema.safeParse({}).success).toBe(false);
    });

    it('accepts valid input', () => {
      const result = OpenAlexGroupSchema.safeParse({
        entity: 'works',
        group_by: 'publication_year',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('OpenAlexBatchSchema', () => {
    it('accepts array of IDs', () => {
      const result = OpenAlexBatchSchema.safeParse({ ids: ['W123', '10.1038/foo'] });
      expect(result.success).toBe(true);
    });

    it('rejects empty ids array', () => {
      const result = OpenAlexBatchSchema.safeParse({ ids: [] });
      expect(result.success).toBe(false);
    });

    it('rejects ids array exceeding 500', () => {
      const ids = Array.from({ length: 501 }, (_, i) => `W${i}`);
      const result = OpenAlexBatchSchema.safeParse({ ids });
      expect(result.success).toBe(false);
    });
  });

  describe('OpenAlexContentSchema', () => {
    it('requires work_id and _confirm: true', () => {
      expect(OpenAlexContentSchema.safeParse({ work_id: 'W123' }).success).toBe(false);
      expect(OpenAlexContentSchema.safeParse({ work_id: 'W123', _confirm: false }).success).toBe(false);
    });

    it('accepts valid content request', () => {
      const result = OpenAlexContentSchema.safeParse({
        work_id: 'W2741809807',
        _confirm: true,
      });
      expect(result.success).toBe(true);
    });

    it('applies default type=pdf', () => {
      const result = OpenAlexContentSchema.safeParse({ work_id: 'W123', _confirm: true });
      expect(result.success && result.data.type).toBe('pdf');
    });

    it('applies default max_size_mb=100', () => {
      const result = OpenAlexContentSchema.safeParse({ work_id: 'W123', _confirm: true });
      expect(result.success && result.data.max_size_mb).toBe(100);
    });

    it('falls back to default max_size_mb for invalid values', () => {
      const result = OpenAlexContentSchema.safeParse({
        work_id: 'W123',
        _confirm: true,
        max_size_mb: -100,
      });
      expect(result.success).toBe(true);
      expect(result.success && result.data.max_size_mb).toBe(100);
    });
  });

  describe('OpenAlexRateLimitSchema', () => {
    it('parses empty object (all fields optional)', () => {
      const result = OpenAlexRateLimitSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('applies default refresh=false', () => {
      const result = OpenAlexRateLimitSchema.safeParse({});
      expect(result.success && result.data.refresh).toBe(false);
    });
  });

  describe('OpenAlexSemanticSearchSchema', () => {
    it('requires non-empty query', () => {
      expect(OpenAlexSemanticSearchSchema.safeParse({}).success).toBe(false);
      expect(OpenAlexSemanticSearchSchema.safeParse({ query: '' }).success).toBe(false);
    });

    it('accepts valid query', () => {
      const result = OpenAlexSemanticSearchSchema.safeParse({ query: 'quantum gravity' });
      expect(result.success).toBe(true);
    });
  });

  describe('OpenAlexReferencesSchema', () => {
    it('requires work_id', () => {
      expect(OpenAlexReferencesSchema.safeParse({}).success).toBe(false);
    });

    it('accepts work_id', () => {
      expect(OpenAlexReferencesSchema.safeParse({ work_id: 'W123' }).success).toBe(true);
    });
  });

  describe('OpenAlexCitationsSchema', () => {
    it('requires work_id', () => {
      expect(OpenAlexCitationsSchema.safeParse({}).success).toBe(false);
    });

    it('accepts work_id', () => {
      expect(OpenAlexCitationsSchema.safeParse({ work_id: 'W123' }).success).toBe(true);
    });
  });

  describe('OpenAlexAutocompleteSchema', () => {
    it('requires query and entity', () => {
      expect(OpenAlexAutocompleteSchema.safeParse({}).success).toBe(false);
      expect(OpenAlexAutocompleteSchema.safeParse({ query: 'Harvard' }).success).toBe(false);
    });

    it('accepts valid input', () => {
      const result = OpenAlexAutocompleteSchema.safeParse({
        query: 'Harvard',
        entity: 'institutions',
      });
      expect(result.success).toBe(true);
    });
  });
});
