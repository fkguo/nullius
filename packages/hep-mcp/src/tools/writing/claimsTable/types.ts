/**
 * Claims Table Generator - Types and Utilities
 */

import type { SnippetLocator, ClaimCategory, EvidenceLevel, EnhancedClaimsTable } from '../types.js';
import type { ClaimsTableReference } from './storage.js';
import type { Measurement } from '../../research/measurementExtractor.js';
import type { LLMExtractionMode } from './llmExtractor.js';

export interface GenerateClaimsTableParams {
  recids: string[];
  topic: string;
  focus_areas?: string[];
  include_visual_assets?: boolean;
  /**
   * Store full data to disk and return lightweight reference (default: auto)
   * - true: always store to disk
   * - false: always return full data in MCP response
   * - 'auto' (default): store to disk when response would be large (>50 formulas or >10 figures)
   */
  use_disk_storage?: boolean | 'auto';
  /**
   * LLM extraction mode for claims enhancement (default: 'client')
   * - 'passthrough': Only use rule-based extraction (no LLM)
   * - 'client': Return structured data for host LLM to process
   * - 'internal': Use configured LLM provider (e.g., DeepSeek)
   */
  llm_mode?: LLMExtractionMode;
}

export interface GenerateClaimsTableResult {
  claims_table: EnhancedClaimsTable;
  processing_time_ms: number;
  warnings: string[];
  /** Reference for disk-stored tables (when use_disk_storage enabled) */
  reference?: ClaimsTableReference;
}

/** Claim extraction result from a single paper */
export interface PaperClaimsResult {
  recid: string;
  title: string;
  success: boolean;
  error?: string;
  claims: ExtractedClaim[];
  formulas: ExtractedFormula[];
  figures: ExtractedFigure[];
  tables: ExtractedTable[];
  /** Extracted measurements with uncertainties (from measurementExtractor) */
  measurements?: Measurement[];
  /** Mark as cite-only (no extractable content) */
  cite_only?: boolean;
}

export interface ExtractedClaim {
  text: string;
  category: ClaimCategory;
  evidence_level: EvidenceLevel;
  source_section: string;
  locator: SnippetLocator;
  keywords: string[];
  /** Source context for anti-hallucination */
  source_context?: {
    before: string;
    after: string;
    /** LLM-derived physical meaning (from internal mode) */
    llm_physical_meaning?: string;
    /** LLM-derived importance rank (from internal mode) */
    llm_importance_rank?: number;
  };
  /** Mark this claim as abstract fallback (not from keyword matching) */
  is_abstract_fallback?: boolean;
}

export interface ExtractedFormula {
  latex: string;
  label?: string;
  importance: 'high' | 'medium' | 'low';
  importance_score: number;
  section?: string;
  locator: SnippetLocator;
  /** Discussion contexts from paper body */
  discussion_contexts?: string[];
}

export interface ExtractedFigure {
  caption: string;
  label?: string;
  graphics_paths: string[];
  importance: 'high' | 'medium' | 'low';
  importance_score: number;
  section?: string;
  discussion_contexts: string[];
  locator: SnippetLocator;
}

export interface ExtractedTable {
  caption: string;
  label?: string;
  content_summary?: string;
  section?: string;
  locator: SnippetLocator;
  /** Discussion contexts from paper body */
  discussion_contexts?: string[];
}
