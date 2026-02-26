/**
 * Adaptive Outline Generator
 *
 * Generates outline based on content coherence, not hardcoded templates:
 * - Single paper: Use original section structure as base
 * - Multiple papers: Create synthesized structure from claim clustering
 * - target_length is a scaling factor, not determinant
 * - Distributes ALL visual assets (not just first N)
 */

import type { GenerateOutlineParams, GenerateOutlineResult, OutlineSection } from './types.js';
import type { EnhancedClaimsTable, SectionType, OriginalSection, Claim } from '../types.js';
import { planOutline, type OutlinePlan } from '../../../core/writing/outlinePlanner.js';
import { WORD_BUDGET_BY_LENGTH, calculatePerSectionBudget } from './wordBudget.js';
import { verifyOutlineCoverage } from './coverage.js';
import { invalidParams } from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SCALING_FACTORS = {
  short: 0.5,
  medium: 1.0,
  long: 1.5,
};

const MIN_SECTIONS = 3;
const MAX_SECTIONS = 15;

// Section titles that should be intro/summary type
// Note: "discussion" alone is NOT summary - it's typically a body section
// Only match when combined with summary-like words
const INTRO_PATTERNS = /^(intro|preface|overview)/i;
const SUMMARY_PATTERNS = /^(summar|conclu|outlook|future|final\s+remarks)/i;

// ─────────────────────────────────────────────────────────────────────────────
// Main Generator
// ─────────────────────────────────────────────────────────────────────────────

export async function generateOutline(params: GenerateOutlineParams): Promise<GenerateOutlineResult> {
  const { claims_table, target_length = 'medium' } = params;
  const ct = claims_table as EnhancedClaimsTable;

  // Determine generation strategy
  const paperCount = ct.corpus_snapshot?.paper_count || ct.corpus_snapshot?.recids?.length || 1;
  const hasOriginalSections = ct.original_sections && ct.original_sections.length > 0;

  let outline: OutlineSection[];
  let outlineStrategy: string | undefined;
  let structureRationale: string | undefined;
  let crossRefMap: GenerateOutlineResult['cross_ref_map'] | undefined;

  if (paperCount === 1 && hasOriginalSections) {
    // Single paper: use original section structure
    outline = generateFromOriginalSections(ct, target_length);
    outlineStrategy = 'original_sections';
    structureRationale = 'Outline derived from the original paper section structure (single-paper mode).';
  } else {
    const llmMode = params.llm_mode ?? 'passthrough';
    const planResult = await planOutline(
      {
        run_id: params.run_id ?? 'standalone',
        project_id: params.project_id ?? 'standalone',
        language: params.language ?? 'auto',
        target_length,
        title: params.title,
        topic: params.topic,
        claims_table: ct,
      },
      llmMode
    );

    if ('system_prompt' in planResult) {
      return {
        outline: [],
        total_claims_assigned: 0,
        total_assets_assigned: 0,
        prompt_packet: planResult,
        outline_strategy: 'llm_client_pending',
        structure_rationale: 'Client outline planning requested. Use prompt_packet with a host LLM and re-run with the planned outline.',
      };
    }

    outline = convertPlanToOutlineSections(planResult, ct);
    outlineStrategy = llmMode === 'internal' ? 'outline_planner_internal' : 'outline_planner_heuristic';
    structureRationale = planResult.structure_rationale;

    // Contract gate: fail-fast on invalid LLM output (no silent heuristic fallback).
    const bodyCount = outline.filter(s => s.type === 'body').length;
    if (outline.length < MIN_SECTIONS || outline.length > MAX_SECTIONS || bodyCount === 0) {
      throw invalidParams('Outline plan invalid (must include body sections and reasonable section count)', {
        min_sections: MIN_SECTIONS,
        max_sections: MAX_SECTIONS,
        observed_sections: outline.length,
        observed_body_sections: bodyCount,
        outline_strategy: outlineStrategy,
      });
    }

    // Ensure intro and summary sections exist + renumber.
    ensureIntroSummary(outline);
  }

  // Ensure all assets are distributed
  distributeAllAssets(outline, ct);

  // Cross-section map (best-effort, deterministic)
  crossRefMap = buildCrossRefMapForOutline(outline, ct);

  // Calculate totals (including subsections recursively)
  const { totalClaims, totalAssets } = countAssignments(outline);

  const totalBudget = WORD_BUDGET_BY_LENGTH[target_length] ?? WORD_BUDGET_BY_LENGTH.medium;
  const word_budget = {
    total_target: totalBudget,
    per_section: calculatePerSectionBudget(outline, totalBudget),
  };
  const coverageCheck = verifyOutlineCoverage({ outline, claims_table: ct, word_budget });

  return {
    outline,
    total_claims_assigned: totalClaims,
    total_assets_assigned: totalAssets,
    word_budget,
    cross_ref_map: crossRefMap,
    coverage: {
      claims_assigned: coverageCheck.claims.assigned,
      claims_total: coverageCheck.claims.total,
      assets_assigned:
        coverageCheck.assets.equations_assigned +
        coverageCheck.assets.figures_assigned +
        coverageCheck.assets.tables_assigned,
      assets_total:
        coverageCheck.assets.equations_total +
        coverageCheck.assets.figures_total +
        coverageCheck.assets.tables_total,
      unassigned_claims: coverageCheck.claims.unassigned,
      unassigned_assets: coverageCheck.assets.unassigned,
    },
    structure_rationale: structureRationale,
    outline_strategy: outlineStrategy,
  };
}

function convertPlanToOutlineSections(plan: OutlinePlan, ct: EnhancedClaimsTable): OutlineSection[] {
  const eqIds = new Set((ct.visual_assets?.formulas ?? []).map(e => String((e as any).evidence_id)));
  const figIds = new Set((ct.visual_assets?.figures ?? []).map(e => String((e as any).evidence_id)));
  const tabIds = new Set((ct.visual_assets?.tables ?? []).map(e => String((e as any).evidence_id)));

  const unique = (values: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of values.map(String)) {
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  return plan.sections.map(sec => {
    const assetIds = Array.isArray(sec.assigned_asset_ids) ? sec.assigned_asset_ids.map(String) : [];
    return {
      number: String(sec.number ?? ''),
      title: String(sec.title ?? ''),
      type: sec.type,
      assigned_claims: unique(Array.isArray(sec.assigned_claim_ids) ? sec.assigned_claim_ids.map(String) : []),
      assigned_figures: unique(assetIds.filter(id => figIds.has(id))),
      assigned_equations: unique(assetIds.filter(id => eqIds.has(id))),
      assigned_tables: unique(assetIds.filter(id => tabIds.has(id))),
    };
  });
}

/**
 * Recursively count all assigned claims and assets
 */
function countAssignments(sections: OutlineSection[]): { totalClaims: number; totalAssets: number } {
  let totalClaims = 0;
  let totalAssets = 0;

  for (const section of sections) {
    totalClaims += section.assigned_claims.length;
    totalAssets += section.assigned_figures.length +
                   section.assigned_equations.length +
                   section.assigned_tables.length;

    if (section.subsections) {
      const sub = countAssignments(section.subsections);
      totalClaims += sub.totalClaims;
      totalAssets += sub.totalAssets;
    }
  }

  return { totalClaims, totalAssets };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 1: Generate from Original Sections (Single Paper)
// ─────────────────────────────────────────────────────────────────────────────

function generateFromOriginalSections(
  ct: EnhancedClaimsTable,
  targetLength: 'short' | 'medium' | 'long'
): OutlineSection[] {
  const originalSections = ct.original_sections!;
  const scale = SCALING_FACTORS[targetLength];

  // Get only top-level (level 1) sections
  const topLevelSections = originalSections.filter(s => s.level === 1);

  // Apply scaling for short mode: merge sections
  let outline: OutlineSection[];

  if (scale < 1.0) {
    // Short mode: merge similar sections
    const targetCount = Math.max(MIN_SECTIONS, Math.round(topLevelSections.length * scale));
    outline = mergeSectionsToTarget(topLevelSections, targetCount);
  } else if (scale > 1.0) {
    // Long mode: preserve hierarchy with subsections
    outline = convertWithSubsections(topLevelSections);
  } else {
    // Medium mode: use top-level sections as-is
    outline = topLevelSections.map((sec, i) => createOutlineSectionFromOriginal(i + 1, sec, false));
  }

  // Ensure intro and summary sections exist
  ensureIntroSummary(outline);

  return outline;
}

/**
 * Convert OriginalSection to OutlineSection, recursively including all children
 * NOTE: Assets from original sections are NOT copied here - they will be distributed
 * by distributeAllAssets() to avoid duplication
 */
function createOutlineSectionFromOriginal(
  number: number,
  section: OriginalSection,
  includeChildren: boolean,
  parentNumber?: string
): OutlineSection {
  const sectionNumber = parentNumber ? `${parentNumber}.${number}` : String(number);

  // Handle empty or whitespace-only titles (can happen with LaTeX math-only titles)
  const title = section.title?.trim() || `Section ${sectionNumber}`;

  const result: OutlineSection = {
    number: sectionNumber,
    title,
    type: inferSectionType(title),
    assigned_claims: [],
    assigned_figures: [],    // Empty - will be filled by distributeAllAssets
    assigned_equations: [],  // Empty - will be filled by distributeAllAssets
    assigned_tables: [],     // Empty - will be filled by distributeAllAssets
  };

  // Recursively add all children as subsections (supports section/subsection/subsubsection/...)
  if (includeChildren && section.children.length > 0) {
    result.subsections = section.children.map((child, i) =>
      createOutlineSectionFromOriginal(i + 1, child, true, sectionNumber)  // true: recursive
    );
  }

  return result;
}

/**
 * Convert sections preserving hierarchy (for long mode)
 */
function convertWithSubsections(sections: OriginalSection[]): OutlineSection[] {
  return sections.map((sec, i) => createOutlineSectionFromOriginal(i + 1, sec, true));
}

/**
 * Merge sections to reach target count (for short mode)
 */
function mergeSectionsToTarget(sections: OriginalSection[], targetCount: number): OutlineSection[] {
  if (sections.length <= targetCount) {
    return sections.map((sec, i) => createOutlineSectionFromOriginal(i + 1, sec, false));
  }

  const mergeRatio = Math.ceil(sections.length / targetCount);
  const result: OutlineSection[] = [];

  for (let i = 0; i < sections.length; i += mergeRatio) {
    const batch = sections.slice(i, i + mergeRatio);
    const merged = mergeSectionGroup(batch, result.length + 1);
    result.push(merged);
  }

  return result;
}

/**
 * Merge a group of sections into one
 * NOTE: Assets are NOT merged here - distributeAllAssets handles all asset assignment
 */
function mergeSectionGroup(sections: OriginalSection[], number: number): OutlineSection {
  // Use first section's title (with fallback for empty titles)
  const title = sections[0].title?.trim() || `Section ${number}`;
  return {
    number: String(number),
    title,
    type: inferSectionType(title),
    assigned_claims: [],
    assigned_figures: [],    // Empty - will be filled by distributeAllAssets
    assigned_equations: [],  // Empty - will be filled by distributeAllAssets
    assigned_tables: [],     // Empty - will be filled by distributeAllAssets
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset Distribution
// ─────────────────────────────────────────────────────────────────────────────

function distributeAllAssets(outline: OutlineSection[], ct: EnhancedClaimsTable): void {
  // Collect all body sections recursively (including subsections at any depth)
  const allBodySections = collectBodySections(outline);

  if (allBodySections.length === 0) return;

  // Distribute claims to body sections (only if not already assigned)
  const hasClaimsAssigned = allBodySections.some(s => s.assigned_claims.length > 0);
  if (!hasClaimsAssigned) {
    const claims = ct.claims || [];
    distributeEvenly(
      claims.map(c => c.claim_id),
      allBodySections,
      'assigned_claims'
    );
  }

  // Distribute formulas
  const formulas = ct.visual_assets?.formulas || [];
  distributeMissingAssets(
    formulas.map(f => String((f as any).evidence_id)),
    allBodySections,
    'assigned_equations'
  );

  // Distribute figures
  const figures = ct.visual_assets?.figures || [];
  distributeMissingAssets(
    figures.map(f => String((f as any).evidence_id)),
    allBodySections,
    'assigned_figures'
  );

  // Distribute tables
  const tables = ct.visual_assets?.tables || [];
  distributeMissingAssets(
    tables.map(t => String((t as any).evidence_id)),
    allBodySections,
    'assigned_tables'
  );
}

/**
 * Recursively collect all body sections (at any nesting level)
 */
function collectBodySections(sections: OutlineSection[]): OutlineSection[] {
  const result: OutlineSection[] = [];
  for (const section of sections) {
    if (section.type === 'body') {
      result.push(section);
    }
    if (section.subsections) {
      result.push(...collectBodySections(section.subsections));
    }
  }
  return result;
}

function distributeEvenly(
  ids: string[],
  sections: OutlineSection[],
  field: 'assigned_claims' | 'assigned_figures' | 'assigned_equations' | 'assigned_tables'
): void {
  if (ids.length === 0 || sections.length === 0) return;

  // Round-robin distribution
  for (let i = 0; i < ids.length; i++) {
    const sectionIdx = i % sections.length;
    sections[sectionIdx][field].push(ids[i]);
  }
}

function distributeMissingAssets(
  ids: string[],
  sections: OutlineSection[],
  field: 'assigned_figures' | 'assigned_equations' | 'assigned_tables'
): void {
  if (ids.length === 0 || sections.length === 0) return;

  const already = new Set<string>();
  for (const s of sections) {
    const list = (s as any)[field];
    if (!Array.isArray(list)) continue;
    for (const id of list) already.add(String(id));
  }

  const missing = ids.map(String).filter(id => id && !already.has(id));
  distributeEvenly(missing, sections, field);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function inferSectionType(title: string): SectionType {
  if (INTRO_PATTERNS.test(title)) return 'introduction';
  if (SUMMARY_PATTERNS.test(title)) return 'summary';
  return 'body';
}

function ensureIntroSummary(outline: OutlineSection[]): void {
  // Ensure first section is intro
  if (outline.length > 0 && outline[0].type !== 'introduction') {
    outline.unshift({
      number: '0',  // Temporary, will be renumbered
      title: 'Introduction',
      type: 'introduction',
      assigned_claims: [],
      assigned_figures: [],
      assigned_equations: [],
      assigned_tables: [],
    });
  }

  // Ensure last section is summary
  if (outline.length > 0 && outline[outline.length - 1].type !== 'summary') {
    outline.push({
      number: String(outline.length + 1),
      title: 'Summary',
      type: 'summary',
      assigned_claims: [],
      assigned_figures: [],
      assigned_equations: [],
      assigned_tables: [],
    });
  }

  // Renumber all sections recursively (including subsections)
  renumberSections(outline);
}

/**
 * Recursively renumber sections and their subsections
 */
function renumberSections(sections: OutlineSection[], parentNumber?: string): void {
  for (let i = 0; i < sections.length; i++) {
    const newNumber = parentNumber ? `${parentNumber}.${i + 1}` : String(i + 1);
    sections[i].number = newNumber;

    if (sections[i].subsections) {
      renumberSections(sections[i].subsections!, newNumber);
    }
  }
}

function extractConceptCandidates(text: string): string[] {
  const out = new Set<string>();

  for (const match of text.matchAll(/\bModel\s+[A-Z][A-Za-z0-9]*\b/g)) out.add(match[0]);
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:\([^)]+\))\b/g)) out.add(match[0]);

  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)) {
    out.add(match[0]);
    if (out.size >= 6) break;
  }

  return Array.from(out);
}

function buildCrossRefMap(
  sections: Array<{ number: string; title: string; claims: Claim[] }>
): GenerateOutlineResult['cross_ref_map'] {
  const defines: NonNullable<GenerateOutlineResult['cross_ref_map']>['defines'] = [];
  const uses: NonNullable<GenerateOutlineResult['cross_ref_map']>['uses'] = [];

  const firstDefineBySection = new Map<string, string>();

  for (const sec of sections) {
    const concepts = new Set<string>();
    concepts.add(sec.title);
    for (const c of sec.claims) {
      for (const cand of extractConceptCandidates(String(c.claim_text ?? ''))) concepts.add(cand);
      if (concepts.size >= 3) break;
    }

    const picked = Array.from(concepts).filter(Boolean).slice(0, 2);
    for (const concept of picked) {
      defines.push({ section: sec.number, concept });
      if (!firstDefineBySection.has(sec.number)) firstDefineBySection.set(sec.number, concept);
    }
  }

  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1];
    const curr = sections[i];
    const concept = firstDefineBySection.get(prev.number);
    if (!concept) continue;
    uses.push({ section: curr.number, concept, defined_in: prev.number });
  }

  return { defines, uses };
}

function buildCrossRefMapForOutline(outline: OutlineSection[], ct: EnhancedClaimsTable): GenerateOutlineResult['cross_ref_map'] {
  const claimById = new Map<string, Claim>(
    Array.isArray(ct.claims) ? (ct.claims as Claim[]).map(c => [String(c.claim_id), c] as const) : []
  );

  const bodySections = collectBodySections(outline).map(sec => ({
    number: sec.number,
    title: sec.title,
    claims: (sec.assigned_claims ?? []).map(id => claimById.get(String(id))).filter(Boolean) as Claim[],
  }));

  if (bodySections.length === 0) {
    return { defines: outline.map(s => ({ section: s.number, concept: s.title })), uses: [] };
  }

  return buildCrossRefMap(bodySections);
}
