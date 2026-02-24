/**
 * Citation Verifier Types
 */

export interface VerifyCitationsParams {
  section_output: any;
  claims_table: any;
  /**
   * Optional allowlist for citations in this section.
   * Can include INSPIRE recids ("123456"), INSPIRE-style keys ("inspire:123456"),
   * or resolved BibTeX keys ("Author:2024abc").
   *
   * If provided (even as an empty array), verification enforces it.
   * If omitted, verifier falls back to deriving an allowlist from claims_table.
   */
  allowed_citations?: string[];
}

export interface CitationIssue {
  type: 'citation_mismatch' | 'orphan_citation' | 'unauthorized_citation' | 'missing_citation' | 'citation_density';
  sentence_index?: number;
  paragraph_index?: number;
  citation?: string;
  expected?: string;
  found_in_latex?: string[];
  count?: number;
  severity: 'error' | 'warning';
  message?: string;
}

export interface VerifyCitationsResult {
  pass: boolean;
  issues: CitationIssue[];
  statistics: {
    total_citations: number;
    unique_citations: number;
    attributed_citations: number;
    unauthorized_count: number;
    orphan_count: number;
    missing_count: number;
  };
}
