/**
 * Synthesize Review Tool
 * Generates structured review summaries from deep paper analysis
 *
 * Enhanced with:
 * - Narrative mode for academic prose output
 * - Critical analysis integration
 * - Multiple narrative structures
 */

import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import * as api from '../../api/client.js';
import pLimit from 'p-limit';
import { deepAnalyze, type DeepPaperAnalysis } from './deepAnalyze.js';
import { performCriticalAnalysis, type CriticalAnalysisResult } from './criticalAnalysis.js';
import { detectConflicts, type ConflictAnalysis } from './conflictDetector.js';
import {
  groupByTimeline,
  groupByMethodology,
  groupByImpact,
  groupForComparison,
  type PaperGroup,
} from './synthesis/grouping.js';
import {
  generateNarrativeSections,
  type NarrativeStructure,
  type NarrativeSections,
} from './synthesis/narrative.js';
import {
  generateMarkdown,
  type ReviewStyle,
  type SynthesizedReview,
} from './synthesis/markdown.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types re-exported for the local research-tool module surface.
// ─────────────────────────────────────────────────────────────────────────────

export type { NarrativeStructure, ReviewStyle, PaperGroup, SynthesizedReview };

export interface SynthesizeReviewParams {
  identifiers: string[];
  review_type: 'methodology' | 'timeline' | 'comparison' | 'overview';
  focus_topic?: string;
  format?: 'json' | 'markdown';
  style?: ReviewStyle;
  include_critical_analysis?: boolean;
  narrative_structure?: NarrativeStructure;
  options?: SynthesizeOptions;
  /** Internal MCP context (not part of tool schema) */
  _mcp?: {
    createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
  };
}

export interface SynthesizeOptions {
  include_equations?: boolean;
  include_bibliography?: boolean;
  max_papers_per_group?: number;
}

export interface SynthesizeReviewResult {
  review: SynthesizedReview;
  markdown?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<SynthesizeOptions> = {
  include_equations: true,
  include_bibliography: true,
  max_papers_per_group: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract key equations from papers, prioritizing importance-scored equations
 */
function extractKeyEquations(
  papers: DeepPaperAnalysis[],
  maxEquations: number = 10
): Array<{
  latex: string;
  source_paper: string;
  importance?: 'high' | 'medium' | 'low';
  description?: string;
}> {
  const equations: Array<{
    latex: string;
    source_paper: string;
    importance?: 'high' | 'medium' | 'low';
    description?: string;
    score: number;
  }> = [];

  for (const paper of papers) {
    if (paper.key_equations && paper.key_equations.length > 0) {
      for (const eq of paper.key_equations) {
        if (eq.selection_status !== 'selected') continue;
        const descParts: string[] = [];
        if (eq.label) descParts.push(eq.label);
        if (eq.reference_count > 0) {
          descParts.push(`ref×${eq.reference_count}`);
        }
        if (eq.section) descParts.push(`in ${eq.section}`);
        if (eq.selection_rationale) descParts.push(eq.selection_rationale);

        equations.push({
          latex: eq.latex,
          source_paper: paper.recid,
          importance: eq.importance_band,
          description: descParts.join('; ') || undefined,
          score: eq.importance_score,
        });
      }
      continue;
    }
    if (paper.equations) {
      const labeled = paper.equations.filter(eq => eq.label);
      for (const eq of labeled.slice(0, 3)) {
        equations.push({
          latex: eq.latex,
          source_paper: paper.recid,
          description: eq.label,
          score: eq.referenced ? 30 : 10,
        });
      }
    }
  }

  // Sort by score and return top equations
  return equations
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEquations)
    .map(({ score, ...rest }) => rest);
}

async function performCriticalAnalysisSection(
  recids: string[],
  criticalResults: CriticalAnalysisResult[]
): Promise<SynthesizedReview['critical_analysis']> {
  const conflicts = await detectConflicts({
    recids,
    min_tension_sigma: 3.0,
    include_tables: true,
  });

  const wellEstablished: string[] = [];
  const controversial: string[] = [];
  const emerging: string[] = [];

  for (const result of criticalResults) {
    if (result.evidence?.main_claims) {
      for (const claim of result.evidence.main_claims) {
        if (claim.confidence === 'high' && claim.independent_confirmations >= 2) {
          wellEstablished.push(`[${result.paper_title}] ${claim.claim.slice(0, 100)}...`);
        } else if (claim.confidence === 'controversial') {
          controversial.push(`[${result.paper_title}] ${claim.claim.slice(0, 100)}...`);
        } else if (claim.confidence === 'low' && claim.is_orphan) {
          emerging.push(`[${result.paper_title}] ${claim.claim.slice(0, 100)}...`);
        }
      }
    }
  }

  const reliabilityScores = criticalResults
    .filter(r => r.success && r.integrated_assessment)
    .map(r => r.integrated_assessment.reliability_score);
  const avgReliability = reliabilityScores.length > 0
    ? reliabilityScores.reduce((a, b) => a + b, 0) / reliabilityScores.length
    : 0;

  const highRiskPapers = criticalResults
    .filter(r => r.integrated_assessment?.risk_level === 'high')
    .map(r => r.paper_title);

  const allRecommendations = criticalResults
    .flatMap(r => r.integrated_assessment?.recommendations || []);
  const uniqueRecommendations = [...new Set(allRecommendations)].slice(0, 5);

  const openQuestions: string[] = [];
  for (const result of criticalResults.slice(0, 3)) {
    if (result.questions?.questions?.assumptions?.[0]) {
      openQuestions.push(result.questions.questions.assumptions[0]);
    }
  }

  return {
    conflicts: conflicts.conflicts,
    evidence_summary: {
      well_established: wellEstablished.slice(0, 5),
      controversial: controversial.slice(0, 5),
      emerging: emerging.slice(0, 5),
    },
    open_questions: openQuestions,
    overall_assessment: {
      average_reliability: Math.round(avgReliability * 100) / 100,
      high_risk_papers: highRiskPapers,
      recommendations: uniqueRecommendations,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export async function synthesizeReview(
  params: SynthesizeReviewParams
): Promise<SynthesizeReviewResult> {
  const {
    identifiers,
    review_type,
    focus_topic = 'Research Review',
    format = 'json',
    style = 'list',
    include_critical_analysis = false,
    narrative_structure = 'convergent',
  } = params;

  const options: Required<SynthesizeOptions> = {
    ...DEFAULT_OPTIONS,
    ...params.options,
  };

  // Step 1: Deep analyze all papers
  const analysisResult = await deepAnalyze({
    identifiers,
    options: {
      extract_equations: options.include_equations,
      extract_theorems: true,
      extract_methodology: true,
      extract_conclusions: true,
    },
    _mcp: params._mcp,
  });

  const successfulPapers = analysisResult.papers.filter(p => p.success);

  // Step 2: Get paper metadata (citations, years)
  const metadata = new Map<string, { year?: number; citations?: number }>();
  if (successfulPapers.length > 0) {
    const recids = successfulPapers.map(p => p.recid).filter(id => id);
    const papers = await api.batchGetPapers(recids);
    for (const paper of papers) {
      metadata.set(paper.recid!, {
        year: paper.year,
        citations: paper.citation_count,
      });
    }
  }

  // Step 3: Determine year range
  const years = [...metadata.values()].map(m => m.year).filter((y): y is number => !!y);
  const yearRange = {
    start: years.length > 0 ? Math.min(...years) : new Date().getFullYear(),
    end: years.length > 0 ? Math.max(...years) : new Date().getFullYear(),
  };

  // Step 4: Group papers based on review_type
  let groups: PaperGroup[];
  switch (review_type) {
    case 'timeline':
      groups = groupByTimeline(successfulPapers, metadata);
      break;
    case 'methodology':
      groups = groupByMethodology(successfulPapers, options.max_papers_per_group);
      break;
    case 'overview':
      groups = groupByImpact(successfulPapers, metadata);
      break;
    case 'comparison':
    default:
      groups = groupForComparison(successfulPapers, options.max_papers_per_group);
      break;
  }

  // Step 5: Extract key equations
  const keyEquations = options.include_equations
    ? extractKeyEquations(successfulPapers)
    : undefined;

  // Step 6: Get bibliography
  let bibliography: string | undefined;
  if (options.include_bibliography && successfulPapers.length > 0) {
    const recids = successfulPapers.map(p => p.recid).filter(id => id);
    try {
      bibliography = await api.getBibtex(recids);
    } catch (error) {
      // Log at debug level for troubleshooting
      console.debug(`[hep-mcp] synthesizeReview getBibtex: Skipped - ${error instanceof Error ? error.message : String(error)}`);
      // Skip on error
    }
  }

  // Step 7: Build main findings
  const mainFindings: string[] = [];
  mainFindings.push(`Analyzed ${successfulPapers.length} papers on ${focus_topic}`);
  if (groups.length > 0) {
    mainFindings.push(`Organized into ${groups.length} groups by ${review_type}`);
  }
  const totalEquations = successfulPapers.reduce((sum, p) => sum + (p.equations?.length || 0), 0);
  if (totalEquations > 0) {
    mainFindings.push(`Contains ${totalEquations} mathematical expressions`);
  }

  // Step 8: Critical analysis (if requested)
  let criticalAnalysisSection: SynthesizedReview['critical_analysis'] | undefined;
  let conflicts: ConflictAnalysis[] = [];
  let criticalResults: CriticalAnalysisResult[] | undefined;

  if (include_critical_analysis && successfulPapers.length > 0) {
    const recids = successfulPapers.map(p => p.recid).filter(id => id);
    const limit = pLimit(3);
    criticalResults = await Promise.all(
      recids.map(recid =>
        limit(() =>
          performCriticalAnalysis({
            recid,
            include_evidence: true,
            include_questions: true,
            include_assumptions: true,
            check_literature: true,
          })
        )
      )
    );

    criticalAnalysisSection = await performCriticalAnalysisSection(recids, criticalResults);

    if (criticalAnalysisSection) {
      conflicts = criticalAnalysisSection.conflicts;

      if (conflicts.length > 0) {
        const hardCount = conflicts.filter(c => c.conflict_type === 'hard').length;
        const softCount = conflicts.filter(c => c.conflict_type === 'soft').length;
        mainFindings.push(`Detected ${hardCount} hard conflicts and ${softCount} soft tensions`);
      }
      const highRiskCount = criticalAnalysisSection.overall_assessment.high_risk_papers.length;
      if (highRiskCount > 0) {
        mainFindings.push(`Identified ${highRiskCount} high-risk paper(s) requiring careful evaluation`);
      }
    }
  }

  // Step 9: Generate narrative sections (if narrative style)
  let narrativeSections: NarrativeSections | undefined;
  if (style === 'narrative') {
    // Extract critical results for narrative if available
    const criticalResultsForNarrative = include_critical_analysis ? criticalResults : undefined;

    narrativeSections = generateNarrativeSections(
      narrative_structure,
      focus_topic,
      successfulPapers,
      groups,
      yearRange,
      metadata,
      conflicts,
      criticalResultsForNarrative
    );
  }

  // Step 10: Build review
  const review: SynthesizedReview = {
    title: `Review: ${focus_topic}`,
    focus_topic,
    generated_at: new Date().toISOString(),
    overview: {
      total_papers: identifiers.length,
      successful_analysis: successfulPapers.length,
      year_range: yearRange,
      main_findings: mainFindings,
    },
    groups,
    key_equations: keyEquations,
    bibliography,
    critical_analysis: criticalAnalysisSection,
    narrative_sections: narrativeSections,
  };

  // Step 11: Generate markdown if requested
  const markdown = format === 'markdown' ? generateMarkdown(review, style) : undefined;

  return {
    review,
    markdown,
  };
}
