/**
 * Critical Research Tool (Consolidated)
 * Combines: grade_evidence, detect_conflicts, critical_analysis, classify_reviews
 *
 * Modes:
 * - 'evidence': Grade evidence quality of claims in a paper
 * - 'conflicts': Detect measurement conflicts between papers
 * - 'analysis': Comprehensive critical analysis (AI scientist view)
 * - 'reviews': Classify review papers by type and authority
 */

import { gradeEvidence, type EvidenceGradingResult } from './evidenceGrading.js';
import { detectConflicts, type ConflictDetectionResult } from './conflictDetector.js';
import { performCriticalAnalysis, type CriticalAnalysisResult } from './criticalAnalysis.js';
import { classifyReviews, type ClassifyReviewsResult } from './reviewClassifier.js';
import { performTheoreticalConflicts, type TheoreticalConflictsResult } from './theoreticalConflicts.js';
import type { ToolHandlerContext } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CriticalMode = 'evidence' | 'conflicts' | 'analysis' | 'reviews' | 'theoretical';

export interface CriticalResearchParams {
  /** Analysis mode */
  mode: CriticalMode;
  /** Paper recids (single for evidence/analysis, multiple for conflicts/reviews) */
  recids: string[];
  /** Optional vNext run_id (required for mode='theoretical' to write artifacts) */
  run_id?: string;
  /** Mode-specific options */
  options?: CriticalOptions;
}

export interface CriticalOptions {
  // Evidence options
  search_confirmations?: boolean;
  max_search_results?: number;

  // Conflicts options
  target_quantities?: string[];
  min_tension_sigma?: number;
  include_tables?: boolean;

  // Analysis options
  include_evidence?: boolean;
  include_questions?: boolean;
  include_assumptions?: boolean;
  check_literature?: boolean;
  assumption_max_depth?: number;

  // Reviews options
  current_threshold_years?: number;

  // Theoretical conflicts options (mode='theoretical')
  subject_entity?: string;
  inputs?: Array<'title' | 'abstract' | 'citation_context' | 'evidence_paragraph'>;
  max_papers?: number;
  max_claim_candidates_per_paper?: number;
  max_candidates_total?: number;
  llm_mode?: 'passthrough' | 'client' | 'internal';
  max_llm_requests?: number;
  strict_llm?: boolean;
  prompt_version?: string;
  stable_sort?: boolean;
  client_llm_responses?: Array<{
    request_id: string;
    json_response: unknown;
    model?: string;
    created_at?: string;
    [key: string]: unknown;
  }>;
}

export interface CriticalResearchResult {
  mode: CriticalMode;
  /** Evidence grading result (if mode='evidence') */
  evidence?: EvidenceGradingResult;
  /** Conflict detection result (if mode='conflicts') */
  conflicts?: ConflictDetectionResult;
  /** Critical analysis result (if mode='analysis') */
  analysis?: CriticalAnalysisResult;
  /** Review classification result (if mode='reviews') */
  reviews?: ClassifyReviewsResult;
  /** Theoretical debate map + conflicts (if mode='theoretical'; Evidence-first via run artifacts) */
  theoretical?: TheoreticalConflictsResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified critical research tool
 */
export async function performCriticalResearch(
  params: CriticalResearchParams,
  ctx: Pick<ToolHandlerContext, 'createMessage'> = {}
): Promise<CriticalResearchResult> {
  const { mode, recids, options = {} } = params;

  if (!recids?.length) {
    throw new Error('recids array is required');
  }

  const result: CriticalResearchResult = { mode };

  switch (mode) {
    case 'evidence': {
      result.evidence = await gradeEvidence({
        recid: recids[0],
        search_confirmations: options.search_confirmations,
        max_search_results: options.max_search_results,
      }, {
        createMessage: ctx.createMessage,
      });
      break;
    }

    case 'conflicts': {
      result.conflicts = await detectConflicts({
        recids,
        target_quantities: options.target_quantities,
        min_tension_sigma: options.min_tension_sigma,
        include_tables: options.include_tables,
      }, {
        createMessage: ctx.createMessage,
      });
      break;
    }

    case 'analysis': {
      result.analysis = await performCriticalAnalysis({
        recid: recids[0],
        include_evidence: options.include_evidence,
        include_questions: options.include_questions,
        include_assumptions: options.include_assumptions,
        check_literature: options.check_literature,
        search_confirmations: options.search_confirmations,
        max_search_results: options.max_search_results,
        assumption_max_depth: options.assumption_max_depth,
      });
      break;
    }

    case 'reviews': {
      result.reviews = await classifyReviews({
        recids,
        current_threshold_years: options.current_threshold_years,
      });
      break;
    }

    case 'theoretical': {
      if (!params.run_id) {
        throw new Error("mode='theoretical' requires run_id");
      }
      result.theoretical = await performTheoreticalConflicts({
        run_id: params.run_id,
        recids,
        options,
      }, {
        createMessage: ctx.createMessage,
      });
      break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  return result;
}
