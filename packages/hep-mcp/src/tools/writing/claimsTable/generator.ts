/**
 * Claims Table Generator - Main Entry Point
 */

import type {
  GenerateClaimsTableParams,
  GenerateClaimsTableResult,
  PaperClaimsResult,
} from './types.js';
import type {
  EnhancedClaimsTable,
  Claim,
  ClaimCategory,
  ClaimStatus,
  FormulaEvidence,
  FigureEvidence,
  TableEvidence,
  DisagreementGraph,
  OriginalSection,
} from '../types.js';
import { extractPaperContent, extractVisualAssetsFromTexFiles, extractOriginalSections } from './extractor.js';
import { generateFingerprint, generateEvidenceId } from '../contentIndex/fingerprint.js';
import { accessPaperSource } from '../../research/paperSource.js';
import { detectConflicts } from '../../research/conflictDetector.js';
import { getProjectStructure } from '../../research/latex/index.js';
import { storeClaimsTable, type ClaimsTableReference } from './storage.js';

/**
 * Generate an enhanced claims table from multiple papers
 */
export async function generateClaimsTable(
  params: GenerateClaimsTableParams
): Promise<GenerateClaimsTableResult> {
  const startTime = Date.now();
  const warnings: string[] = [];
  const {
    recids,
    topic,
    include_visual_assets = true,
    use_disk_storage = true,  // Default: always store to disk (reduces MCP response tokens)
    llm_mode = 'client',      // Default: client mode (host LLM processes structured data)
  } = params;

  // 1. Extract content from each paper
  const paperResults: PaperClaimsResult[] = [];
  const allOriginalSections: OriginalSection[] = [];

  for (const recid of recids) {
    let texFiles: string[] = [];
	    if (include_visual_assets) {
	      try {
	        const result = await accessPaperSource({ identifier: recid, mode: 'content' });
	        if (result.content?.success && result.content?.main_tex) {
	          // Get all project files for multi-file LaTeX projects
	          try {
	            const structure = getProjectStructure(result.content.main_tex);
	            texFiles = structure.files.map(f => f.path);
	          } catch (error) {
	            warnings.push(
	              `[${recid}] Could not parse LaTeX project structure (falling back to main file only): ` +
	              `${error instanceof Error ? error.message : String(error)}`
	            );
	            texFiles = [result.content.main_tex];
	          }
	        }
	      } catch (error) {
	        warnings.push(`Could not get LaTeX for ${recid}: ${error instanceof Error ? error.message : String(error)}`);
	      }
	    }

    // Extract claims (using abstract/conclusions from INSPIRE API)
    const claimsResult = await extractPaperContent(recid, null, topic, llm_mode);

    // Extract visual assets from all tex files (avoiding truncation)
    if (texFiles.length > 0) {
      const visualAssets = await extractVisualAssetsFromTexFiles(recid, texFiles);
      claimsResult.figures = visualAssets.figures;
      claimsResult.tables = visualAssets.tables;
      claimsResult.formulas = visualAssets.formulas;

	      // Extract original section structure (for adaptive outline)
	      try {
	        const sections = await extractOriginalSections(recid, texFiles, visualAssets);
	        allOriginalSections.push(...sections);
	      } catch (error) {
	        console.error(`[generateClaimsTable] Section extraction failed for ${recid}:`, error);
	        warnings.push(
	          `[${recid}] Original section extraction failed: ${error instanceof Error ? error.message : String(error)}`
	        );
	      }
	    }

    paperResults.push(claimsResult);
    // Add extraction errors to warnings
    if (!claimsResult.success && claimsResult.error) {
      warnings.push(`[${recid}] Extraction failed: ${claimsResult.error}`);
    } else if (claimsResult.claims.length === 0) {
      warnings.push(`[${recid}] No claims extracted`);
    }
  }

  // 2. Build claims with evidence (no limit - extract all)
  const claims = buildClaims(paperResults);

  if (claims.length === 0) {
    throw new Error('No claims extracted from papers. Ensure fulltext/LaTeX is available and evidenceGrading returns main claims.');
  }

  // 3. Build all visual assets (no limits - full extraction)
  const visual_assets = include_visual_assets
    ? buildVisualAssets(paperResults)
    : { formulas: [], figures: [], tables: [] };

  // 4. Build disagreement graph
	  let disagreement_graph: DisagreementGraph = { edges: [], clusters: [] };
	  try {
	    const conflicts = await detectConflicts({ recids, min_tension_sigma: 2 });
	    disagreement_graph = buildDisagreementGraph(conflicts);
	  } catch (error) {
	    warnings.push(`Could not detect conflicts: ${error instanceof Error ? error.message : String(error)}`);
	  }

  // 5. Build statistics
  const statistics = buildStatistics(claims, visual_assets);

  // 6. Build the full claims table
  const full_claims_table: EnhancedClaimsTable = {
    id: generateFingerprint(`${topic}:${recids.join(',')}`),
    corpus_snapshot: {
      paper_count: recids.length,
      recids,
      date_range: { start: 2000, end: new Date().getFullYear() },
      snapshot_date: new Date().toISOString(),
    },
    claims,
    visual_assets,
    original_sections: allOriginalSections.length > 0 ? allOriginalSections : undefined,
    disagreement_graph,
    notation_table: [],
    glossary: [],
    analysis_dimensions: {
      methodological_comparisons: [],
      result_significance: [],
      open_questions: [],
    },
    metadata: {
      created_at: new Date().toISOString(),
      processing_time_ms: Date.now() - startTime,
      source_paper_count: recids.length,
      version: '2.0',
    },
    statistics,
  };

  // 7. Store to disk (default behavior to reduce MCP response tokens)
  // Set use_disk_storage=false to get full data in MCP response (for debugging)
	  let shouldUseDiskStorage = use_disk_storage !== false;

  let reference: ClaimsTableReference | undefined;
  let claims_table: EnhancedClaimsTable;

	  if (shouldUseDiskStorage) {
	    try {
	      // Store full table to disk
	      reference = await storeClaimsTable(full_claims_table, topic);
	      const { formulas, figures, tables } = full_claims_table.visual_assets;
	      warnings.push(
	        `Visual assets (${formulas.length} formulas, ${figures.length} figures, ${tables.length} tables) ` +
	        `stored to disk. Use ref_id="${reference.ref_id}" in subsequent tools to auto-load.`
	      );

	      // Return lightweight version for MCP response (empty visual_assets)
	      claims_table = {
	        ...full_claims_table,
	        visual_assets: { formulas: [], figures: [], tables: [] },
	      };
	    } catch (error) {
	      warnings.push(
	        `Failed to store claims table to disk (returning full data in response): ` +
	        `${error instanceof Error ? error.message : String(error)}`
	      );
	      shouldUseDiskStorage = false;
	      claims_table = full_claims_table;
	    }
	  } else {
	    // Return full data in MCP response
	    claims_table = full_claims_table;
	  }

  return {
    claims_table,
    processing_time_ms: Date.now() - startTime,
    warnings,
    reference,
  };
}

/** Build claims from paper results (no limit) */
function buildClaims(results: PaperClaimsResult[]): Claim[] {
  const claims: Claim[] = [];
  let claimNo = 1;

  for (const paper of results) {
    if (!paper.success) continue;
    for (const extracted of paper.claims) {
      const fingerprint = generateFingerprint(extracted.text);
      claims.push({
        claim_id: generateEvidenceId(paper.recid, 'claim', claimNo, fingerprint),
        claim_no: `C${String(claimNo).padStart(3, '0')}`,
        claim_text: extracted.text,
        category: extracted.category,
        status: 'emerging',
        paper_ids: [paper.recid],
        supporting_evidence: [],
        assumptions: [],
        scope: '',
        evidence_grade: extracted.evidence_level,
        keywords: extracted.keywords,
        is_extractive: true,
        source_context: extracted.source_context,
      });
      claimNo++;
    }
  }
  return claims;
}

/** Build visual assets from paper results */
function buildVisualAssets(results: PaperClaimsResult[]): {
  formulas: FormulaEvidence[];
  figures: FigureEvidence[];
  tables: TableEvidence[];
} {
  const formulas: FormulaEvidence[] = [];
  const figures: FigureEvidence[] = [];
  const tables: TableEvidence[] = [];

  for (const paper of results) {
    if (!paper.success) continue;

    // Add all formulas
    for (const f of paper.formulas) {
      const fp = generateFingerprint(f.latex);
      formulas.push({
        kind: 'formula',
        evidence_id: generateEvidenceId(paper.recid, 'formula', f.label, fp),
        paper_id: paper.recid,
        latex: f.latex,
        label: f.label,
        importance: f.importance,
        locator: f.locator,
        fingerprint: fp,
        stance: 'neutral',
        confidence: 'high',
      });
    }

    // Add all figures
    for (const fig of paper.figures) {
      const fp = generateFingerprint(fig.caption);
      figures.push({
        kind: 'figure',
        evidence_id: generateEvidenceId(paper.recid, 'figure', fig.label, fp),
        paper_id: paper.recid,
        caption: fig.caption,
        graphics_paths: fig.graphics_paths,
        label: fig.label,
        discussion_contexts: fig.discussion_contexts,
        importance: fig.importance,
        locator: fig.locator,
        fingerprint: fp,
        stance: 'neutral',
        confidence: 'high',
      });
    }

    // Add all tables
    for (const tbl of paper.tables) {
      const fp = generateFingerprint(tbl.caption);
      tables.push({
        kind: 'table',
        evidence_id: generateEvidenceId(paper.recid, 'table', tbl.label, fp),
        paper_id: paper.recid,
        caption: tbl.caption,
        label: tbl.label,
        content_summary: tbl.content_summary,
        locator: tbl.locator,
        fingerprint: fp,
        stance: 'neutral',
        confidence: 'high',
      });
    }
  }

  return { formulas, figures, tables };
}

/** Build disagreement graph from conflict detection */
function buildDisagreementGraph(conflicts: { conflicts?: Array<{ conflict_type?: string; tension_sigma?: number; notes?: string }> }): DisagreementGraph {
  const edges = (conflicts.conflicts || []).map((c, i: number) => ({
    claim_id_a: `conflict_${i}_a`,
    claim_id_b: `conflict_${i}_b`,
    tension_type: (c.conflict_type || 'soft') as 'hard' | 'soft' | 'apparent',
    tension_sigma: c.tension_sigma,
    description: c.notes || '',
  }));
  return { edges, clusters: [] };
}

/** Build statistics */
function buildStatistics(
  claims: Claim[],
  assets: { formulas: FormulaEvidence[]; figures: FigureEvidence[]; tables: TableEvidence[] }
): EnhancedClaimsTable['statistics'] {
  const byCategory = {} as Record<ClaimCategory, number>;
  const byStatus = {} as Record<ClaimStatus, number>;
  for (const c of claims) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  }
  return {
    total_claims: claims.length,
    claims_by_category: byCategory,
    claims_by_status: byStatus,
    total_formulas: assets.formulas.length,
    total_figures: assets.figures.length,
    total_tables: assets.tables.length,
    coverage_ratio: claims.length > 0 ? 1 : 0,
  };
}
