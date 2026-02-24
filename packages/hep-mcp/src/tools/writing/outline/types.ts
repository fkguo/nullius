/**
 * Outline Generator Types
 */

import type { SectionType, LLMCallMode } from '../types.js';
import type { PromptPacket } from '../../../vnext/contracts/promptPacket.js';

export interface GenerateOutlineParams {
  claims_table: any;
  title: string;
  topic?: string;
  structure_hints?: string;
  target_length?: 'short' | 'medium' | 'long';
  /** Optional run context (vNext integration) */
  run_id?: string;
  project_id?: string;
  /** Preferred output language (auto=detect) */
  language?: 'en' | 'zh' | 'auto';
  /** Outline planning mode */
  llm_mode?: LLMCallMode;
}

export interface OutlineSection {
  number: string;
  title: string;
  type: SectionType;
  assigned_claims: string[];
  assigned_figures: string[];
  assigned_equations: string[];
  assigned_tables: string[];
  subsections?: OutlineSection[];
}

export interface WordBudgetRange {
  min: number;
  max: number;
}

export interface SectionWordBudget {
  section_number: string;
  min_words: number;
  max_words: number;
}

export interface OutlineWordBudget {
  total_target: WordBudgetRange;
  per_section: SectionWordBudget[];
}

export interface CrossRefMap {
  defines: Array<{ section: string; concept: string }>;
  uses: Array<{ section: string; concept: string; defined_in: string }>;
}

export interface OutlineCoverageSummary {
  claims_assigned: number;
  claims_total: number;
  assets_assigned: number;
  assets_total: number;
  unassigned_claims: string[];
  unassigned_assets: string[];
}

export interface GenerateOutlineResult {
  outline: OutlineSection[];
  total_claims_assigned: number;
  total_assets_assigned: number;
  /** Phase 0: word budgets derived from target_length */
  word_budget?: OutlineWordBudget;
  /** Phase 0: cross-section definition/use hints */
  cross_ref_map?: CrossRefMap;
  /** Phase 0: coverage summary (must be 100%) */
  coverage?: OutlineCoverageSummary;
  /** Phase 0: rationale for structure (LLM/heuristic) */
  structure_rationale?: string;
  /** Strategy marker for debugging/auditing */
  outline_strategy?: string;
  /** Optional client-mode prompt packet (host LLM plans the outline) */
  prompt_packet?: PromptPacket;
}
