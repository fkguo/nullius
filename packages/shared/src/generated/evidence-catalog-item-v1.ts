/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Type of evidence. First 9 are LaTeX-sourced, last 2 are PDF-sourced.
 *
 * This interface was referenced by `EvidenceCatalogItemV1`'s JSON-Schema
 * via the `definition` "EvidenceType".
 */
export type EvidenceType =
  | "title"
  | "abstract"
  | "section"
  | "paragraph"
  | "equation"
  | "figure"
  | "table"
  | "theorem"
  | "citation_context"
  | "pdf_page"
  | "pdf_region";

/**
 * Unified evidence catalog item for LaTeX and PDF sources. Each item represents a piece of evidence extracted from a research paper.
 */
export interface EvidenceCatalogItemV1 {
  /**
   * Schema version.
   */
  version: 1;
  /**
   * Unique identifier for this evidence item (e.g. ev_<paper_id>_<type>_<hash>).
   */
  evidence_id: string;
  /**
   * Project that owns this evidence.
   */
  project_id: string;
  /**
   * Paper from which this evidence was extracted.
   */
  paper_id: string;
  type: EvidenceType;
  /**
   * Source locator pointing to the evidence in the original document.
   */
  locator: LatexLocatorV1 | PdfLocatorV1;
  /**
   * Extracted text content of the evidence.
   */
  text: string;
  /**
   * Normalized text for search matching.
   */
  normalized_text?: string;
  /**
   * Citation keys referenced in this evidence (for citation_context type).
   */
  citations?: string[];
  /**
   * Type-specific metadata (e.g. equation_type, label, section_path).
   */
  meta?: {
    [k: string]: unknown;
  };
  artifact_ref?: ArtifactRefV1;
}
/**
 * This interface was referenced by `EvidenceCatalogItemV1`'s JSON-Schema
 * via the `definition` "LatexLocatorV1".
 */
export interface LatexLocatorV1 {
  /**
   * Locator kind discriminator.
   */
  kind: "latex";
  /**
   * Relative path to the LaTeX source file within the extracted directory.
   */
  file: string;
  /**
   * Byte offset in the (merged) source.
   */
  offset: number;
  /**
   * 1-based line number.
   */
  line: number;
  /**
   * 0-based column number.
   */
  column: number;
  /**
   * End byte offset (exclusive).
   */
  endOffset?: number;
  /**
   * End line number.
   */
  endLine?: number;
  /**
   * End column number.
   */
  endColumn?: number;
  /**
   * Textual anchors around the evidence for fuzzy re-location.
   */
  anchor?: {
    before: string;
    after: string;
  };
}
/**
 * This interface was referenced by `EvidenceCatalogItemV1`'s JSON-Schema
 * via the `definition` "PdfLocatorV1".
 */
export interface PdfLocatorV1 {
  /**
   * Locator kind discriminator.
   */
  kind: "pdf";
  /**
   * 1-based page number in the PDF.
   */
  page: number;
  /**
   * Bounding box coordinates in PDF coordinate space.
   */
  bbox?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  /**
   * Character offset within the extracted text of the page.
   */
  char_offset?: number;
  /**
   * Character length of the evidence text.
   */
  char_length?: number;
}
/**
 * Content-addressed reference to a research artifact. Used by integrity reports, research outcomes, and events to point at specific versioned artifacts.
 */
export interface ArtifactRefV1 {
  /**
   * URI of the artifact. Format: 'rep://<run_id>/<artifact_path>' for local, or absolute URI for remote.
   */
  uri: string;
  /**
   * Artifact kind (e.g., 'strategy', 'outcome', 'computation_result', 'integrity_report'). Optional for forward compatibility.
   */
  kind?: string;
  /**
   * Schema version of the referenced artifact.
   */
  schema_version?: number;
  /**
   * SHA-256 hex digest of the artifact content. Used for integrity verification and content addressing.
   */
  sha256: string;
  /**
   * Size of the artifact in bytes.
   */
  size_bytes?: number;
  /**
   * Agent or component that produced this artifact.
   */
  produced_by?: string;
  /**
   * ISO 8601 UTC Z timestamp of artifact creation.
   */
  created_at?: string;
}
