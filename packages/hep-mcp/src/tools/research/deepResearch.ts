/**
 * Deep Research Tool (Consolidated)
 *
 * Modes:
 * - 'analyze': Deep content analysis (equations, theorems, methodology)
 * - 'synthesize': Generate structured review from papers
 */

import { deepAnalyze, type DeepAnalyzeResult, type DeepAnalyzeOptions } from './deepAnalyze.js';
import {
  synthesizeReview,
  type SynthesizeReviewResult,
  type SynthesizeOptions,
  type NarrativeStructure,
  type ReviewStyle,
} from './synthesizeReview.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DeepMode = 'analyze' | 'synthesize';

export interface DeepResearchParams {
  /** Paper identifiers */
  identifiers: string[];
  /** Research mode */
  mode: DeepMode;
  /** Output format */
  format?: 'json' | 'markdown';
  /** Mode-specific options */
  options?: DeepOptions;
  /** Internal MCP context (not part of tool schema) */
  _mcp?: {
    reportProgress?: (progress: number, total?: number, message?: string) => void | Promise<void>;
    createMessage?: (params: import('@modelcontextprotocol/sdk/types.js').CreateMessageRequestParamsBase) => Promise<import('@modelcontextprotocol/sdk/types.js').CreateMessageResult>;
  };
}

export interface DeepOptions {
  // Analyze options
  extract_equations?: boolean;
  extract_theorems?: boolean;
  extract_methodology?: boolean;
  extract_conclusions?: boolean;
  include_inline_math?: boolean;
  max_section_length?: number;

  // Synthesize options
  review_type?: 'methodology' | 'timeline' | 'comparison' | 'overview';
  focus_topic?: string;
  style?: ReviewStyle;
  include_critical_analysis?: boolean;
  narrative_structure?: NarrativeStructure;
  include_equations?: boolean;
  include_bibliography?: boolean;
  max_papers_per_group?: number;
}

export interface DeepResearchResult {
  mode: DeepMode;
  /** Deep analysis result (if mode='analyze') */
  analysis?: DeepAnalyzeResult;
  /** Synthesized review (if mode='synthesize') */
  review?: SynthesizeReviewResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export async function performDeepResearch(
  params: DeepResearchParams
): Promise<DeepResearchResult> {
  const { identifiers, mode, format = 'json', options = {} } = params;

  if (!identifiers?.length) {
    throw new Error('identifiers array is required');
  }

  const result: DeepResearchResult = { mode };

  switch (mode) {
    case 'analyze': {
      const analyzeOptions: DeepAnalyzeOptions = {
        extract_equations: options.extract_equations,
        extract_theorems: options.extract_theorems,
        extract_methodology: options.extract_methodology,
        extract_conclusions: options.extract_conclusions,
        include_inline_math: options.include_inline_math,
        max_section_length: options.max_section_length,
      };
      result.analysis = await deepAnalyze({ identifiers, options: analyzeOptions, _mcp: params._mcp });
      break;
    }

    case 'synthesize': {
      const synthOptions: SynthesizeOptions = {
        include_equations: options.include_equations,
        include_bibliography: options.include_bibliography,
        max_papers_per_group: options.max_papers_per_group,
      };
      result.review = await synthesizeReview({
        identifiers,
        review_type: options.review_type || 'overview',
        focus_topic: options.focus_topic,
        format,
        style: options.style,
        include_critical_analysis: options.include_critical_analysis,
        narrative_structure: options.narrative_structure,
        options: synthOptions,
        _mcp: params._mcp,
      });
      break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  return result;
}
