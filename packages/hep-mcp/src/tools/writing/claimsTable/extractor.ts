/**
 * Claims Table Extractor
 * Extracts claims and visual assets from papers using existing tools
 */

import type { PaperClaimsResult } from './types.js';
import { cleanMathML } from '../../research/preprocess/utils.js';
import type { ClaimCategory, OriginalSection } from '../types.js';
import { scoreFigureImportance } from '../contentIndex/importanceScorer.js';

// Import existing research tools
import { gradeEvidence } from '../../research/evidenceGrading.js';
import { extractMeasurements } from '../../research/measurementExtractor.js';
import { classifyContentType } from '../../research/paperClassifier.js';
import {
  safeParseLatex,
  extractFigures,
  extractTables,
  extractNumberedEquations,
  extractSections,
  type Section,
} from '../../research/latex/index.js';
import {
  extractWithLLM,
  mergeClaims,
  type LLMExtractionMode,
} from './llmExtractor.js';

/**
 * Extract claims and visual assets from a single paper
 *
 * @param recid - INSPIRE record ID
 * @param texContent - LaTeX content (optional)
 * @param topic - Research topic for context
 * @param llmMode - LLM extraction mode (default: 'client')
 *   - 'passthrough': Return prompt for external LLM
 *   - 'client': Return structured data for host LLM to process
 *   - 'internal': Use configured LLM provider (e.g., DeepSeek)
 */
export async function extractPaperContent(
  recid: string,
  texContent: string | null,
  _topic: string,
  llmMode: LLMExtractionMode = 'client'
): Promise<PaperClaimsResult> {
  const result: PaperClaimsResult = {
    recid,
    title: '',
    success: false,
    claims: [],
    formulas: [],
    figures: [],
    tables: [],
  };

  try {
    // 1. Get evidence grading for claims
    const evidenceResult = await gradeEvidence({
      recid,
      search_confirmations: false,
      max_search_results: 10,
    });

    // Debug: log evidence result
    console.error(`[extractPaperContent] ${recid}: success=${evidenceResult.success}, claims=${evidenceResult.main_claims?.length || 0}`);

    if (evidenceResult.success) {
      result.title = evidenceResult.paper_title;
      result.claims = evidenceResult.main_claims.map(claim => ({
        text: claim.claim,
        category: inferCategory(claim.claim),
        evidence_level: claim.evidence_level,
        source_section: 'abstract/conclusions',
        locator: { section: 'abstract' },
        keywords: extractKeywords(claim.claim),
        // Add source context for anti-hallucination
        source_context: claim.source_context,
      }));
    }

    // 1.5 Enhanced: Always mine claims from fulltext if LaTeX is available
    // This is now DEFAULT behavior, not fallback - merge with gradeEvidence results
    if (texContent) {
      const minedClaims = mineClaimsFromLatex(texContent);
      // Deduplicate: skip mined claims that are too similar to existing ones
      const existingTexts = new Set(result.claims.map(c => c.text.toLowerCase().slice(0, 50)));
      const newClaims = minedClaims
        .filter(mined => !existingTexts.has(mined.text.toLowerCase().slice(0, 50)))
        .map(mined => ({
          text: mined.text,
          category: inferCategory(mined.text),
          evidence_level: 'indirect' as const,
          source_section: 'fulltext',
          locator: { section: 'fulltext' },
          keywords: extractKeywords(mined.text),
          source_context: {
            before: mined.context_before,
            after: mined.context_after,
          },
        }));
      if (newClaims.length > 0) {
        result.claims.push(...newClaims);
        console.error(`[extractPaperContent] ${recid}: mined ${newClaims.length} additional claims from fulltext`);
      }
    }

    // 1.55 Layer 2: Add abstract as summary claim ONLY when claims are insufficient
    // This avoids redundancy when fulltext claims are already extracted
    // IMPORTANT: Clean MathML/HTML to reduce context size (uses shared cleanMathML)
    const rawAbstract = evidenceResult.paper_abstract || '';
    const abstract = cleanMathML(rawAbstract);

    // Only add abstract as summary when we have < 3 claims (insufficient content)
    if (abstract && abstract.length > 50 && result.claims.length < 3) {
      // Set title if not already set
      if (!result.title) {
        result.title = evidenceResult.paper_title;
      }
      // Add abstract as summary claim (cleaned version)
      result.claims.push({
        text: abstract,
        category: 'summary' as const,
        evidence_level: 'indirect' as const,
        source_section: 'abstract',
        locator: { section: 'abstract' },
        keywords: extractKeywords(abstract),
        source_context: { before: '', after: '' },
        is_abstract_fallback: true,
      });
      result.success = true;
      const reduction = rawAbstract.length > 0 ? Math.round((1 - abstract.length / rawAbstract.length) * 100) : 0;
      console.error(`[extractPaperContent] ${recid}: added abstract as summary claim (${rawAbstract.length} -> ${abstract.length} chars, ${reduction}% reduction, total claims: ${result.claims.length})`);
    } else if (result.claims.length === 0) {
      // No claims and no abstract, mark as cite_only
      result.cite_only = true;
      result.title = evidenceResult.paper_title || 'Unknown';
      console.error(`[extractPaperContent] ${recid}: marked as cite_only (no claims and no abstract)`);
    }

    // Mark success if we got claims (before LaTeX parsing which may fail)
    if (result.claims.length > 0) {
      result.success = true;
    }

    // 1.6 Extract measurements and attach to result
    try {
      const measurementResult = await extractMeasurements({ identifier: recid });
      if (measurementResult.success && measurementResult.measurements.length > 0) {
        result.measurements = measurementResult.measurements;
        console.error(`[extractPaperContent] ${recid}: ${measurementResult.measurements.length} measurements extracted`);
      }
    } catch (measurementError) {
      console.error(`[extractPaperContent] ${recid}: measurement extraction failed:`, measurementError instanceof Error ? measurementError.message : String(measurementError));
    }

    // 1.7 LLM-enhanced extraction (if enabled and mode is 'internal')
    // Note: 'client' mode returns prompt for host LLM, handled at generator level
    if (llmMode === 'internal' && result.claims.length > 0) {
      try {
        // Classify paper content type
        const contentClass = classifyContentType(
          { title: result.title, authors: [], recid },
          texContent || undefined
        );
        console.error(`[extractPaperContent] ${recid}: content_type=${contentClass.content_type}, method=${contentClass.method}`);

        // Call LLM extraction (internal mode only)
        const llmResult = await extractWithLLM({
          recid,
          title: result.title,
          abstract: '', // Abstract not available in EvidenceGradingResult
          texContent: texContent || undefined,
          contentType: contentClass.content_type,
          ruleClaims: result.claims,
          measurements: result.measurements,
          mode: llmMode,
        });

        // Merge LLM results with rule-based results
        if (llmResult.claims.length > 0) {
          result.claims = mergeClaims(result.claims, llmResult.claims);
          console.error(`[extractPaperContent] ${recid}: LLM enhanced ${llmResult.claims.length} claims`);
        }
      } catch (llmError) {
        console.error(`[extractPaperContent] ${recid}: LLM extraction failed:`, llmError instanceof Error ? llmError.message : String(llmError));
      }
    }

    // 2. Extract visual assets from LaTeX if available (separate try-catch)
    if (texContent) {
      try {
        // Parse (fail-fast; no truncated/regex fallbacks)
        const { ast } = safeParseLatex(texContent, { file: recid });

        // Extract figures
        const figures = extractFigures(ast as any);
        result.figures = figures.map(fig => {
          const scored = scoreFigureImportance(fig, texContent);
          return {
            caption: fig.caption || '',
            label: fig.label,
            graphics_paths: fig.image_paths,
            importance: scored.importance,
            importance_score: scored.importance_score,
            section: fig.section,
            discussion_contexts: extractDiscussionContexts(texContent, fig.label),
            locator: {
              section: fig.section,
              label: fig.label,
              latex_line: fig.location?.line,
            },
          };
        });

        // Extract tables
        const tables = extractTables(ast as any);
        result.tables = tables.map(tbl => ({
          caption: tbl.caption || '',
          label: tbl.label,
          section: tbl.section,
          discussion_contexts: extractDiscussionContexts(texContent, tbl.label),
          locator: {
            section: tbl.section,
            label: tbl.label,
            latex_line: tbl.location?.line,
          },
        }));

        // Extract all numbered equations (no filtering for comprehensive extraction)
        const numberedEqs = extractNumberedEquations(ast as any, { file: recid });
        result.formulas = numberedEqs.map(eq => ({
          latex: eq.latex,
          label: eq.label,
          importance: 'medium' as const,
          importance_score: 50,
          section: undefined,
          discussion_contexts: extractDiscussionContexts(texContent, eq.label),
          locator: {
            section: undefined,
            label: eq.label,
            latex_line: eq.location?.line,
          },
        }));
      } catch (latexError) {
        // LaTeX parsing failed, but claims extraction may have succeeded
        console.error(`[extractPaperContent] LaTeX parse error for ${recid}:`, latexError instanceof Error ? latexError.message : String(latexError));
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`[extractPaperContent] Error for ${recid}:`, result.error);
  }

  return result;
}

/** Infer claim category from text */
function inferCategory(text: string): ClaimCategory {
  const lower = text.toLowerCase();
  if (/measure|observe|detect|discover|find/.test(lower)) return 'experimental_result';
  if (/predict|expect|calculate|estimate/.test(lower)) return 'theoretical_prediction';
  if (/method|technique|approach|analysis/.test(lower)) return 'methodology';
  return 'interpretation';
}

/** Extract keywords from claim text */
function extractKeywords(text: string): string[] {
  const keywords: string[] = [];
  const patterns = [
    /\b(mass|width|lifetime|branching)\b/gi,
    /\b(MeV|GeV|TeV)\b/g,
    /\b(sigma|significance)\b/gi,
    /\b(X\(\d+\)|Y\(\d+\)|Z\(\d+\))/g,
  ];
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) keywords.push(...matches);
  }
  return [...new Set(keywords)];
}

/** Extract discussion contexts for a figure */
function extractDiscussionContexts(texContent: string, label?: string): string[] {
  if (!label) return [];
  const contexts: string[] = [];
  const refPattern = new RegExp(`[^.]*\\\\ref\\{${label}\\}[^.]*\\.`, 'g');
  const matches = texContent.match(refPattern);
  if (matches) {
    contexts.push(...matches.slice(0, 3).map(m => m.trim()));
  }
  return contexts;
}

/** Mined claim with context */
interface MinedClaim {
  text: string;
  context_before: string;
  context_after: string;
}

/**
 * Mine candidate claims from LaTeX fulltext (very lightweight).
 * Removes LaTeX commands and picks sentences containing key verbs.
 */
function mineClaimsFromLatex(tex: string): MinedClaim[] {
  // Rough cleanup: remove comments, commands, math blocks
  let cleaned = tex
    .replace(/%.*$/gm, '')
    .replace(/\\cite[tp]?\{[^}]*\}/g, '')
    .replace(/\\ref\{[^}]*\}/g, '')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\\[([\\\s\S]*?)\\\]/g, ' ')
    .replace(/\\begin\{equation\*?\}[\s\S]*?\\end\{equation\*?\}/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, ' ');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Simple sentence split
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 30 && s.length < 500);

  const CLAIM_KEYWORDS = [
    'discover', 'observation', 'observe', 'measurement', 'measure',
    'result', 'evidence', 'report', 'find', 'detected', 'improve',
    'confirm', 'demonstrate', 'show', 'present'
  ];

  const mined: MinedClaim[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (CLAIM_KEYWORDS.some(k => s.toLowerCase().includes(k))) {
      mined.push({
        text: s,
        context_before: i > 0 ? sentences[i - 1] : '',
        context_after: i < sentences.length - 1 ? sentences[i + 1] : '',
      });
    }
    // Removed: if (mined.length >= 5) break; - no artificial limit for deep research
  }
  return mined;
}

/**
 * Extract visual assets from multiple tex files (avoids truncation issues)
 * Processes each file independently and merges results.
 */
export async function extractVisualAssetsFromTexFiles(
  _recid: string,
  texFiles: string[]
): Promise<{
  figures: PaperClaimsResult['figures'];
  tables: PaperClaimsResult['tables'];
  formulas: PaperClaimsResult['formulas'];
}> {
  const figures: PaperClaimsResult['figures'] = [];
  const tables: PaperClaimsResult['tables'] = [];
  const formulas: PaperClaimsResult['formulas'] = [];

  const { readFileSync } = await import('fs');

  for (const filePath of texFiles) {
    try {
      const texContent = readFileSync(filePath, 'utf-8');

      // Use safeParseLatex with 3-level fallback for each file
      const parseResult = safeParseLatex(texContent, { file: filePath });

      if (parseResult.ast) {
        // Extract figures
        const fileFigures = extractFigures(parseResult.ast as any);
        for (const fig of fileFigures) {
          const scored = scoreFigureImportance(fig, texContent);
          figures.push({
            caption: fig.caption || '',
            label: fig.label,
            graphics_paths: fig.image_paths,
            importance: scored.importance,
            importance_score: scored.importance_score,
            section: fig.section,
            discussion_contexts: extractDiscussionContexts(texContent, fig.label),
            locator: {
              section: fig.section,
              label: fig.label,
              latex_line: fig.location?.line,
            },
          });
        }

        // Extract tables
        const fileTables = extractTables(parseResult.ast as any);
        for (const tbl of fileTables) {
          tables.push({
            caption: tbl.caption || '',
            label: tbl.label,
            section: tbl.section,
            discussion_contexts: extractDiscussionContexts(texContent, tbl.label),
            locator: {
              section: tbl.section,
              label: tbl.label,
              latex_line: tbl.location?.line,
            },
          });
        }

        // Extract all numbered equations
        const numberedEqs = extractNumberedEquations(parseResult.ast as any, { file: filePath });
        for (const eq of numberedEqs) {
          formulas.push({
            latex: eq.latex,
            label: eq.label,
            importance: 'medium' as const,
            importance_score: 50,
            section: undefined,
            discussion_contexts: extractDiscussionContexts(texContent, eq.label),
            locator: {
              section: undefined,
              label: eq.label,
              latex_line: eq.location?.line,
            },
          });
        }
      }
    } catch (error) {
      console.error(`[extractVisualAssetsFromTexFiles] Error parsing ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return { figures, tables, formulas };
}

/**
 * Extract original section structure from LaTeX files
 * Maps visual assets to their sections based on locator.section
 */
export async function extractOriginalSections(
  recid: string,
  texFiles: string[],
  visualAssets: {
    figures: PaperClaimsResult['figures'];
    tables: PaperClaimsResult['tables'];
    formulas: PaperClaimsResult['formulas'];
  }
): Promise<OriginalSection[]> {
  const { readFileSync } = await import('fs');
  const allSections: OriginalSection[] = [];

  // Build section-to-asset mapping from locators
  const sectionAssets = new Map<string, {
    formula_ids: string[];
    figure_ids: string[];
    table_ids: string[];
  }>();

  // Map each asset to its section
  for (const fig of visualAssets.figures) {
    const sectionName = fig.locator?.section || 'unknown';
    if (!sectionAssets.has(sectionName)) {
      sectionAssets.set(sectionName, { formula_ids: [], figure_ids: [], table_ids: [] });
    }
    sectionAssets.get(sectionName)!.figure_ids.push(fig.label || `fig_${visualAssets.figures.indexOf(fig)}`);
  }

  for (const tbl of visualAssets.tables) {
    const sectionName = tbl.locator?.section || 'unknown';
    if (!sectionAssets.has(sectionName)) {
      sectionAssets.set(sectionName, { formula_ids: [], figure_ids: [], table_ids: [] });
    }
    sectionAssets.get(sectionName)!.table_ids.push(tbl.label || `tab_${visualAssets.tables.indexOf(tbl)}`);
  }

  for (const eq of visualAssets.formulas) {
    const sectionName = eq.locator?.section || 'unknown';
    if (!sectionAssets.has(sectionName)) {
      sectionAssets.set(sectionName, { formula_ids: [], figure_ids: [], table_ids: [] });
    }
    sectionAssets.get(sectionName)!.formula_ids.push(eq.label || `eq_${visualAssets.formulas.indexOf(eq)}`);
  }

  // Extract section structure from each file
  for (const filePath of texFiles) {
    try {
      const texContent = readFileSync(filePath, 'utf-8');
      const parseResult = safeParseLatex(texContent, { file: filePath });

      if (parseResult.ast) {
        const sections = extractSections(parseResult.ast as any);
        const converted = convertSections(sections, recid, sectionAssets);
        allSections.push(...converted);
      }
    } catch (error) {
      console.error(`[extractOriginalSections] Error parsing ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return allSections;
}

/**
 * Convert LaTeX Section to OriginalSection format
 */
function convertSections(
  sections: Section[],
  paperId: string,
  sectionAssets: Map<string, { formula_ids: string[]; figure_ids: string[]; table_ids: string[] }>
): OriginalSection[] {
  return sections.map(sec => {
    const assets = sectionAssets.get(sec.title) || { formula_ids: [], figure_ids: [], table_ids: [] };
    return {
      level: sec.level,
      title: sec.title,
      number: sec.number,
      paper_id: paperId,
      formula_ids: assets.formula_ids,
      figure_ids: assets.figure_ids,
      table_ids: assets.table_ids,
      children: convertSections(sec.children, paperId, sectionAssets),
    };
  });
}
