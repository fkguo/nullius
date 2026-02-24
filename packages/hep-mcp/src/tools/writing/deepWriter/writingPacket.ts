/**
 * Writing Packet Builder
 */

import type { WritingPacket, Claim, FigureEvidence, FormulaEvidence, TableEvidence, SoftDepthConfig, SectionType } from '../types.js';

/**
 * Soft depth configurations - suggestions instead of hard requirements.
 * LLM has freedom to organize content naturally based on the material.
 */
const SOFT_DEPTH_CONFIGS: Record<SectionType, SoftDepthConfig> = {
  introduction: {
    suggested_paragraphs: { min: 2, max: 5 },
    suggested_sentences_per_paragraph: { min: 2, max: 6 },
    optional_elements: ['historical_context', 'problem_definition', 'scope'],
    suggested_figures: 0,
    suggested_equations: 0,
    suggested_tables: 0,
    target_citation_density: 0.3,
  },
  body: {
    suggested_paragraphs: { min: 3, max: 8 },
    suggested_sentences_per_paragraph: { min: 2, max: 6 },
    optional_elements: ['definition', 'derivation', 'comparison'],
    suggested_figures: 0,  // Use as needed based on content
    suggested_equations: 0,
    suggested_tables: 0,
    target_citation_density: 0.4,
  },
  summary: {
    suggested_paragraphs: { min: 2, max: 4 },
    suggested_sentences_per_paragraph: { min: 2, max: 5 },
    optional_elements: ['main_conclusions', 'future_directions'],
    suggested_figures: 0,
    suggested_equations: 0,
    suggested_tables: 0,
    target_citation_density: 0.2,
  },
};

export function buildWritingPacket(
  section: { number: string; title: string; type: SectionType },
  claims: Claim[],
  figures: FigureEvidence[],
  equations: FormulaEvidence[],
  tables: TableEvidence[],
  options?: { topic?: string; title?: string; language?: 'en' | 'zh' }
): WritingPacket {
  // Collect paper IDs from all evidence sources (claims, figures, equations, tables)
  const claimPaperIds = claims.flatMap(c => c.paper_ids);
  const figurePaperIds = figures.map(f => f.paper_id).filter(Boolean);
  const equationPaperIds = equations.map(e => e.paper_id).filter(Boolean);
  const tablePaperIds = tables.map(t => t.paper_id).filter(Boolean);

  // Union all paper IDs to ensure comprehensive citation coverage
  const paperIds = [...new Set([
    ...claimPaperIds,
    ...figurePaperIds,
    ...equationPaperIds,
    ...tablePaperIds,
  ])];

  return {
    section,
    assigned_claims: claims,
    assigned_assets: { figures, equations, tables },
    allowed_citations: paperIds.map(id => `inspire:${id}`),
    constraints: SOFT_DEPTH_CONFIGS[section.type],
    instructions: {
      core: [
        'Write deep, analytical paragraphs based on the provided claims.',
        'Integrate visual assets naturally into the discussion when they enhance understanding.',
      ],
      prohibitions: [
        'Do NOT output bullet points or numbered lists.',
        'Do NOT copy source text verbatim.',
      ],
      requirements: [
        'Aim for 2-5 sentences per paragraph, but prioritize natural flow.',
        'Cite sources for factual claims when available.',
      ],
    },
    context: {
      topic: options?.topic,
      title: options?.title,
      language: options?.language,
      glossary: [],
    },
  };
}
