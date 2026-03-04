import { describe, it, expect } from 'vitest';
import { buildQueryParams, translateParamName } from '../api/paramMapping.js';

describe('paramMapping', () => {
  describe('translateParamName', () => {
    it('translates per_page to per-page', () => {
      expect(translateParamName('per_page')).toBe('per-page');
    });

    it('translates group_by to group-by', () => {
      expect(translateParamName('group_by')).toBe('group-by');
    });

    it('drops max_results (returns null)', () => {
      expect(translateParamName('max_results')).toBeNull();
    });

    it('drops _confirm (returns null)', () => {
      expect(translateParamName('_confirm')).toBeNull();
    });

    it('drops max_size_mb (returns null)', () => {
      expect(translateParamName('max_size_mb')).toBeNull();
    });

    it('drops out_dir (returns null)', () => {
      expect(translateParamName('out_dir')).toBeNull();
    });

    it('drops refresh (returns null)', () => {
      expect(translateParamName('refresh')).toBeNull();
    });

    it('passes through unknown keys unchanged', () => {
      expect(translateParamName('filter')).toBe('filter');
      expect(translateParamName('sort')).toBe('sort');
      expect(translateParamName('cursor')).toBe('cursor');
      expect(translateParamName('search')).toBe('search');
    });
  });

  describe('buildQueryParams', () => {
    it('builds URLSearchParams with translated keys', () => {
      const qs = buildQueryParams({ per_page: 50, filter: 'is_oa:true' });
      expect(qs.get('per-page')).toBe('50');
      expect(qs.get('filter')).toBe('is_oa:true');
      expect(qs.has('per_page')).toBe(false);
    });

    it('drops null-mapped keys', () => {
      const qs = buildQueryParams({ max_results: 1000, search: 'dark matter' });
      expect(qs.has('max_results')).toBe(false);
      expect(qs.get('search')).toBe('dark matter');
    });

    it('drops undefined values', () => {
      const qs = buildQueryParams({ filter: undefined, sort: 'cited_by_count:desc' });
      expect(qs.has('filter')).toBe(false);
      expect(qs.get('sort')).toBe('cited_by_count:desc');
    });

    it('drops null values', () => {
      const qs = buildQueryParams({ filter: null, sort: 'date:desc' });
      expect(qs.has('filter')).toBe(false);
    });

    it('converts numbers to strings', () => {
      const qs = buildQueryParams({ per_page: 100, seed: 42 });
      expect(qs.get('per-page')).toBe('100');
      expect(qs.get('seed')).toBe('42');
    });

    it('returns empty URLSearchParams for empty input', () => {
      const qs = buildQueryParams({});
      expect([...qs.entries()].length).toBe(0);
    });

    it('handles group_by translation', () => {
      const qs = buildQueryParams({ group_by: 'publication_year' });
      expect(qs.get('group-by')).toBe('publication_year');
      expect(qs.has('group_by')).toBe(false);
    });
  });
});
