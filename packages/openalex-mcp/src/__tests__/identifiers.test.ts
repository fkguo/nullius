import { describe, it, expect } from 'vitest';
import { detectIdentifier } from '../api/identifiers.js';

describe('detectIdentifier', () => {
  describe('OpenAlex IDs', () => {
    it('detects W-prefixed work ID', () => {
      const r = detectIdentifier('W2741809807');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('works');
      expect(r?.normalized).toBe('W2741809807');
    });

    it('detects A-prefixed author ID', () => {
      const r = detectIdentifier('A5023888391');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('authors');
      expect(r?.normalized).toBe('A5023888391');
    });

    it('detects S-prefixed source ID', () => {
      const r = detectIdentifier('S1983995261');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('sources');
      expect(r?.normalized).toBe('S1983995261');
    });

    it('detects I-prefixed institution ID', () => {
      const r = detectIdentifier('I27837315');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('institutions');
    });

    it('detects T-prefixed topic ID', () => {
      const r = detectIdentifier('T11636');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('topics');
    });

    it('detects P-prefixed publisher ID', () => {
      const r = detectIdentifier('P4310319965');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('publishers');
    });

    it('detects F-prefixed funder ID', () => {
      const r = detectIdentifier('F4320332161');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('funders');
    });

    it('rejects retired C-prefixed concept ID', () => {
      expect(detectIdentifier('C71924100')).toBeNull();
    });
  });

  describe('OpenAlex URLs', () => {
    it('detects full openalex.org URL', () => {
      const r = detectIdentifier('https://openalex.org/W2741809807');
      expect(r?.type).toBe('openalex_url');
      expect(r?.entity).toBe('works');
      expect(r?.normalized).toContain('W2741809807');
    });

    it('detects openalex.org URL without https', () => {
      const r = detectIdentifier('http://openalex.org/A5023888391');
      expect(r?.type).toBe('openalex_url');
      expect(r?.entity).toBe('authors');
    });
  });

  describe('DOI', () => {
    it('detects bare DOI', () => {
      const r = detectIdentifier('10.1038/nature12373');
      expect(r?.type).toBe('doi');
      expect(r?.entity).toBe('works');
      expect(r?.normalized).toBe('doi:10.1038/nature12373');
    });

    it('detects DOI with https://doi.org prefix', () => {
      const r = detectIdentifier('https://doi.org/10.1038/nature12373');
      expect(r?.type).toBe('doi');
      expect(r?.normalized).toBe('doi:10.1038/nature12373');
    });

    it('detects DOI with doi: prefix', () => {
      const r = detectIdentifier('doi:10.1038/nature12373');
      expect(r?.type).toBe('doi');
    });
  });

  describe('ORCID', () => {
    it('detects bare ORCID', () => {
      const r = detectIdentifier('0000-0001-2345-6789');
      expect(r?.type).toBe('orcid');
      expect(r?.entity).toBe('authors');
      expect(r?.normalized).toBe('orcid:0000-0001-2345-6789');
    });

    it('detects ORCID URL', () => {
      const r = detectIdentifier('https://orcid.org/0000-0001-2345-6789');
      expect(r?.type).toBe('orcid');
      expect(r?.normalized).toBe('orcid:0000-0001-2345-6789');
    });
  });

  describe('ROR', () => {
    it('detects ROR URL', () => {
      const r = detectIdentifier('https://ror.org/04a9tmd77');
      expect(r?.type).toBe('ror');
      expect(r?.entity).toBe('institutions');
    });

    it('detects bare ROR ID', () => {
      const r = detectIdentifier('ror:04a9tmd77');
      expect(r?.type).toBe('ror');
    });
  });

  describe('ISSN', () => {
    it('detects bare ISSN', () => {
      const r = detectIdentifier('1234-5678');
      expect(r?.type).toBe('issn');
      expect(r?.entity).toBe('sources');
    });

    it('detects issn: prefixed ISSN', () => {
      const r = detectIdentifier('issn:1234-5678');
      expect(r?.type).toBe('issn');
    });
  });

  describe('PMID', () => {
    it('detects pmid: prefixed PMID', () => {
      const r = detectIdentifier('pmid:12345678');
      expect(r?.type).toBe('pmid');
      expect(r?.entity).toBe('works');
      expect(r?.normalized).toBe('pmid:12345678');
    });
  });

  describe('Unknown / null', () => {
    it('returns null for plain text', () => {
      expect(detectIdentifier('transformer attention mechanism')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(detectIdentifier('')).toBeNull();
    });

    it('normalizes lowercase prefix to uppercase (case-insensitive matching)', () => {
      // OPENALEX_ID_RE has /i flag — lowercase is accepted and normalized to uppercase
      const r = detectIdentifier('w2741809807');
      expect(r?.type).toBe('openalex');
      expect(r?.entity).toBe('works');
      expect(r?.normalized).toBe('W2741809807');
    });
  });
});
