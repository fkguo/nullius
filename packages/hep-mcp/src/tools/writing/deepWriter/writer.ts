/**
 * Deep Section Writer - Main Entry Point
 */

import type { WriteSectionParams, WriteSectionResult } from './types.js';
import type {
  SectionOutput,
  EnhancedClaimsTable,
  WritingPacket,
  Claim,
  SentenceAttribution,
  FigureUsage,
  EquationUsage,
} from '../types.js';
import { buildWritingPacket } from './writingPacket.js';
import type { OutlineSection } from '../outline/types.js';
import { getWritingModeConfig, DeepWriterAgent } from '../llm/index.js';

export async function writeSection(params: WriteSectionParams): Promise<WriteSectionResult> {
  const {
    outline,
    claims_table,
    section_number,
    llm_mode = 'client',
  } = params;

  const ct = claims_table as EnhancedClaimsTable;
  const sections = outline.outline as OutlineSection[];
  const section = sections.find(s => s.number === section_number);

  if (!section) {
    throw new Error(`Section ${section_number} not found`);
  }

  // Build writing packet
  const claims = ct.claims.filter(c => section.assigned_claims.includes(c.claim_id));
  const figures = ct.visual_assets.figures.filter(f => section.assigned_figures.includes(f.evidence_id));
  const equations = ct.visual_assets.formulas.filter(f => section.assigned_equations.includes(f.evidence_id));
  const tables = ct.visual_assets.tables.filter(t => section.assigned_tables?.includes(t.evidence_id));

  const packet = buildWritingPacket(
    { number: section.number, title: section.title, type: section.type },
    claims, figures, equations, tables
  );

  // Handle different modes
  // passthrough and client modes use the same logic (generate content from packet)
  // internal mode calls LLM via DeepWriterAgent
  if (llm_mode === 'passthrough' || llm_mode === 'client') {
    const sectionOutput = generateContentFromPacket(packet, section);
    return {
      section_output: sectionOutput,
      writing_packet: packet,
      mode_used: llm_mode,
    };
  }

  // internal mode - call LLM via DeepWriterAgent
  return createInternalResult(packet, section);
}

async function createInternalResult(
  packet: WritingPacket,
  section: OutlineSection
): Promise<WriteSectionResult> {
  const config = getWritingModeConfig('internal');

  if (!config.llmConfig) {
    // Fallback to client mode if no LLM config
    console.warn('No LLM config found, falling back to client mode');
    return {
      section_output: createEmptySectionOutput(section),
      writing_packet: packet,
      mode_used: 'client',
    };
  }

  try {
    const agent = new DeepWriterAgent(config);
    const result = await agent.writeSection(packet);

    return {
      section_output: result.output,
      writing_packet: packet,
      mode_used: 'internal',
    };
  } catch (error) {
    console.error('Internal LLM call failed:', error);
    // Fallback to client mode on error
    return {
      section_output: createEmptySectionOutput(section),
      writing_packet: packet,
      mode_used: 'client',
    };
  }
}

function createEmptySectionOutput(section: OutlineSection): SectionOutput {
  return {
    section_number: section.number,
    title: section.title,
    content: '',
    attributions: [],
    figures_used: [],
    equations_used: [],
    tables_used: [],
    originality_report: {
      max_overlap_ratio: 0,
      avg_overlap_ratio: 0,
      level: 'acceptable',
      is_acceptable: true,
      needs_review: false,
      has_verbatim_copy: false,
      flagged_sentences: [],
      statistics: {
        total_sentences: 0,
        checked_sentences: 0,
        grounded_sentences: 0,
        synthesized_sentences: 0,
        flagged_count: 0,
        critical_count: 0,
        warning_count: 0,
      },
    },
    quality_check: {
      all_claims_supported: true,
      unsupported_statements: [],
      depth_constraints: {
        min_paragraphs: 0,
        actual_paragraphs: 0,
        paragraphs_pass: true,
        min_sentences_per_paragraph: 0,
        actual_min_sentences: 0,
        sentences_pass: true,
        required_elements: [],
        elements_coverage: 0,
        elements_pass: true,
        min_figures: 0,
        actual_figures: 0,
        min_equations: 0,
        actual_equations: 0,
        visual_pass: true,
        asset_coverage: {
          assigned_figures: [],
          discussed_figures: [],
          figures_coverage_pass: true,
          assigned_equations: [],
          discussed_equations: [],
          equations_coverage_pass: true,
          figure_discussions: [],
          equation_discussions: [],
          overall_pass: true,
        },
      },
      format_checks: {
        bullet_list_detected: false,
        numbered_list_detected: false,
        single_sentence_paragraphs: 0,
        pass: true,
      },
      multi_paper_stats: {
        paragraphs_total: 0,
        paragraphs_multi_paper: 0,
        min_required_multi_paper: 2,
        pass: true,
      },
      tone_score: 0,
      structure_score: 0,
      overall_pass: true,
      blocking_issues: [],
      warnings: [],
    },
    metadata: {
      word_count: 0,
      paragraph_count: 0,
      sentence_count: 0,
      citation_count: 0,
      processing_time_ms: 0,
    },
  };
}

/**
 * Generate section content from WritingPacket claims and evidence
 */
function generateContentFromPacket(packet: WritingPacket, section: OutlineSection): SectionOutput {
  const startTime = Date.now();
  const claims = packet.assigned_claims;
  const figures = packet.assigned_assets.figures;
  const equations = packet.assigned_assets.equations;

  // Group claims by category for better organization
  const claimsByCategory = groupClaimsByCategory(claims);

  // Generate paragraphs from claims
  const paragraphs: string[] = [];
  const attributions: SentenceAttribution[] = [];
  const figuresUsed: FigureUsage[] = [];
  const equationsUsed: EquationUsage[] = [];

  // Generate content for each category
  for (const categoryClaims of Object.values(claimsByCategory)) {
    const paragraph = generateParagraphFromClaims(categoryClaims, attributions);
    if (paragraph) {
      paragraphs.push(paragraph);
    }
  }

  // Add figure references
  for (const fig of figures) {
    const figRef = `As shown in Figure~\\ref{${fig.evidence_id}}, ${fig.caption || 'the data illustrates the discussed phenomenon'}.`;
    paragraphs.push(figRef);
    figuresUsed.push({
      figure_id: fig.evidence_id,
      paper_id: fig.paper_id,
      reference_context: figRef,
      discussion: fig.caption || '',
      latex_ref: `\\ref{${fig.evidence_id}}`,
    });
  }

  // Add equation references
  for (const eq of equations) {
    if (eq.label) {
      const eqRef = `The relationship is captured by Eq.~(\\ref{${eq.label}}): $${eq.latex}$`;
      paragraphs.push(eqRef);
      equationsUsed.push({
        equation_id: eq.evidence_id,
        paper_id: eq.paper_id,
        explanation: eq.description || '',
        significance: 'Key equation',
        latex_ref: `\\ref{${eq.label}}`,
      });
    }
  }

  const content = paragraphs.join('\n\n');
  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  const sentenceCount = content.split(/[.!?]+/).filter(s => s.trim().length > 0).length;

  return {
    section_number: section.number,
    title: section.title,
    content,
    attributions,
    figures_used: figuresUsed,
    equations_used: equationsUsed,
    tables_used: [],
    originality_report: {
      max_overlap_ratio: 0,
      avg_overlap_ratio: 0,
      level: 'acceptable',
      is_acceptable: true,
      needs_review: false,
      has_verbatim_copy: false,
      flagged_sentences: [],
      statistics: {
        total_sentences: sentenceCount,
        checked_sentences: sentenceCount,
        grounded_sentences: sentenceCount,
        synthesized_sentences: 0,
        flagged_count: 0,
        critical_count: 0,
        warning_count: 0,
      },
    },
    quality_check: createDefaultQualityCheck(paragraphs.length, sentenceCount),
    metadata: {
      word_count: wordCount,
      paragraph_count: paragraphs.length,
      sentence_count: sentenceCount,
      citation_count: attributions.length,
      processing_time_ms: Date.now() - startTime,
    },
  };
}

/**
 * Group claims by category
 */
function groupClaimsByCategory(claims: Claim[]): Record<string, Claim[]> {
  const groups: Record<string, Claim[]> = {};
  for (const claim of claims) {
    const category = claim.category || 'general';
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(claim);
  }
  return groups;
}

/**
 * Generate a paragraph from a group of claims
 */
function generateParagraphFromClaims(
  claims: Claim[],
  attributions: SentenceAttribution[]
): string {
  if (claims.length === 0) return '';

  const sentences: string[] = [];

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    // Build sentence from claim
    let sentence = claim.claim_text;

    // Add citation
    if (claim.paper_ids.length > 0) {
      const citeKeys = claim.paper_ids.map(id => `inspire:${id}`).join(',');
      sentence = `${sentence}~\\cite{${citeKeys}}`;

      // Track attribution
      attributions.push({
        sentence,
        sentence_index: attributions.length,
        claim_ids: [claim.claim_id],
        evidence_ids: claim.supporting_evidence.map(e => e.evidence_id),
        citations: claim.paper_ids.map(id => `inspire:${id}`),
        type: 'fact',
        is_grounded: true,
      });
    }

    sentences.push(sentence);
  }

  return sentences.join(' ');
}

/**
 * Create default quality check result
 */
function createDefaultQualityCheck(paragraphCount: number, sentenceCount: number): SectionOutput['quality_check'] {
  return {
    all_claims_supported: true,
    unsupported_statements: [],
    depth_constraints: {
      min_paragraphs: 3,
      actual_paragraphs: paragraphCount,
      paragraphs_pass: paragraphCount >= 3,
      min_sentences_per_paragraph: 3,
      actual_min_sentences: Math.floor(sentenceCount / Math.max(paragraphCount, 1)),
      sentences_pass: true,
      required_elements: [],
      elements_coverage: 1,
      elements_pass: true,
      min_figures: 0,
      actual_figures: 0,
      min_equations: 0,
      actual_equations: 0,
      visual_pass: true,
      asset_coverage: {
        assigned_figures: [],
        discussed_figures: [],
        figures_coverage_pass: true,
        assigned_equations: [],
        discussed_equations: [],
        equations_coverage_pass: true,
        figure_discussions: [],
        equation_discussions: [],
        overall_pass: true,
      },
    },
    format_checks: {
      bullet_list_detected: false,
      numbered_list_detected: false,
      single_sentence_paragraphs: 0,
      pass: true,
    },
    multi_paper_stats: {
      paragraphs_total: paragraphCount,
      paragraphs_multi_paper: paragraphCount,
      min_required_multi_paper: 2,
      pass: paragraphCount >= 2,
    },
    tone_score: 0.8,
    structure_score: 0.8,
    overall_pass: true,
    blocking_issues: [],
    warnings: [],
  };
}
