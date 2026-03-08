import { describe, expect, it } from 'vitest';

import type { EvidenceType, LatexLocatorV1, PdfLocatorV1 } from '@autoresearch/shared';

import {
  buildEvidenceLocalization,
  inferRequestedLocalizationUnit,
  mapEvidenceTypeToLocalizationUnit,
  type LocalizationCandidate,
  type LocalizationCatalogItem,
} from '../../src/core/evidence-localization/localize.js';

function latexLocator(file: string, line: number): LatexLocatorV1 {
  return { kind: 'latex', file, offset: line * 10, line, column: 1 };
}

function pdfLocator(page: number): PdfLocatorV1 {
  return { kind: 'pdf', page };
}

function item(
  type: EvidenceType,
  text: string,
  locator: LatexLocatorV1 | PdfLocatorV1,
  evidenceId: string,
  meta?: Record<string, unknown>,
): LocalizationCatalogItem {
  return {
    evidence_id: evidenceId,
    project_id: 'project_1',
    paper_id: 'paper_1',
    type,
    text,
    locator,
    meta,
  };
}

function candidate(itemValue: LocalizationCatalogItem, score = 0.9): LocalizationCandidate {
  return {
    item: itemValue,
    score,
    semantic_score: score,
    token_overlap_ratio: 0.5,
    importance_score: 0.8,
  };
}

describe('evidence localization', () => {
  it('maps evidence types to localization units', () => {
    expect(mapEvidenceTypeToLocalizationUnit('pdf_page')).toBe('page');
    expect(mapEvidenceTypeToLocalizationUnit('paragraph')).toBe('chunk');
    expect(mapEvidenceTypeToLocalizationUnit('citation_context')).toBe('citation_context');
  });

  it('promotes labeled pdf regions to structured units when visual artifacts exist', () => {
    const figureRegion = item(
      'pdf_region',
      'VISFIG_GOLD mass spectrum anomaly.',
      pdfLocator(2),
      'ev_pdf_figure',
      { label: 'picture', region_uri: 'hep://runs/run_1/artifact/figure.png' },
    );
    const result = buildEvidenceLocalization({
      query: 'which figure shows the mass spectrum anomaly?',
      candidates: [{ ...candidate(figureRegion, 0.82), preferred_unit: 'figure' }],
      allItems: [figureRegion],
      limit: 5,
    });

    expect(result.artifact.availability).toBe('localized');
    expect(result.selected[0]?.localization.unit).toBe('figure');
    expect(result.selected[0]?.localization.source_surfaces).toEqual(['pdf_region']);
    expect(result.selected[0]?.localization.cross_surface_status).toBe('pdf_only');
  });

  it('keeps unlabeled or non-visual pdf regions as chunk results', () => {
    const region = item('pdf_region', 'Fallback chunk GOLD discusses the benchmark signal.', pdfLocator(3), 'ev_pdf_chunk');
    const result = buildEvidenceLocalization({
      query: 'which figure shows the benchmark signal?',
      candidates: [candidate(region, 0.75)],
      allItems: [region],
      limit: 5,
    });

    expect(result.selected[0]?.localization.unit).toBe('chunk');
    expect(result.selected[0]?.localization.status).toBe('fallback_available');
  });

  it('infers requested units from filters and query text', () => {
    expect(inferRequestedLocalizationUnit({ query: 'show me the equation for beta function' })).toBe('equation');
    expect(inferRequestedLocalizationUnit({ query: 'where is the support?', types: ['citation_context'] })).toBe('citation_context');
    expect(inferRequestedLocalizationUnit({ query: 'broad topical summary only' })).toBeUndefined();
  });

  it('keeps exact structured hits localized and links supporting pdf evidence when consistent', () => {
    const table = item('table', 'Table GOLD branching fractions for the benchmark channel.', latexLocator('main.tex', 20), 'ev_table');
    const pdfRegion = item('pdf_region', 'Table GOLD branching fractions for the benchmark channel.', pdfLocator(3), 'ev_pdf_region');
    const result = buildEvidenceLocalization({
      query: 'which table reports the branching fractions?',
      types: ['table'],
      candidates: [candidate(table)],
      allItems: [table, pdfRegion],
      limit: 5,
    });

    expect(result.artifact.availability).toBe('localized');
    expect(result.selected[0]?.localization.status).toBe('localized');
    expect(result.selected[0]?.localization.cross_surface_status).toBe('consistent');
    expect(result.selected[0]?.localization.source_surfaces).toEqual(['latex', 'pdf_region']);
    expect(result.selected[0]?.localization.supporting_evidence_id).toBe('ev_pdf_region');
  });

  it('returns coarse fallback when the requested structured unit is missing', () => {
    const paragraph = item('paragraph', 'Fallback chunk GOLD discusses the benchmark signal.', latexLocator('main.tex', 10), 'ev_chunk');
    const result = buildEvidenceLocalization({
      query: 'which equation defines the benchmark signal?',
      types: ['equation'],
      candidates: [candidate(paragraph, 0.72)],
      allItems: [paragraph],
      limit: 5,
    });

    expect(result.artifact.availability).toBe('unavailable');
    expect(result.selected[0]?.localization.status).toBe('fallback_available');
    expect(result.artifact.reason_codes).toContain('requested_unit_missing_from_indexed_surfaces');
  });

  it('abstains when exact structured hits are ambiguous', () => {
    const first = item('table', 'Table GOLD benchmark summary A.', latexLocator('main.tex', 30), 'ev_table_a');
    const second = item('table', 'Table GOLD benchmark summary B.', latexLocator('main.tex', 60), 'ev_table_b');
    const result = buildEvidenceLocalization({
      query: 'which table summarizes the benchmark?',
      types: ['table'],
      candidates: [candidate(first, 0.91), candidate(second, 0.9)],
      allItems: [first, second],
      limit: 5,
    });

    expect(result.artifact.availability).toBe('abstained');
    expect(result.selected[0]?.localization.status).toBe('abstained');
    expect(result.artifact.reason_codes).toContain('exact_unit_ambiguous');
  });

  it('keeps pdf-only page hits as localized page results', () => {
    const page = item('pdf_page', 'PAGE_GOLD page 4 contains the target derivation.', pdfLocator(4), 'ev_page_4');
    const result = buildEvidenceLocalization({
      query: 'which page contains the target derivation?',
      candidates: [candidate(page, 0.85)],
      allItems: [page],
      limit: 5,
    });

    expect(result.artifact.requested_unit).toBe('page');
    expect(result.artifact.availability).toBe('localized');
    expect(result.selected[0]?.localization.source_surfaces).toEqual(['pdf_page']);
    expect(result.selected[0]?.localization.cross_surface_status).toBe('pdf_only');
  });
});
