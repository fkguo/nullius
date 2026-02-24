import type { EnhancedClaimsTable } from '../types.js';
import type { OutlineSection, OutlineWordBudget } from './types.js';

export interface OutlineCoverageCheck {
  pass: boolean;
  claims: {
    total: number;
    assigned: number;
    unassigned: string[];
    duplicated: string[];
  };
  assets: {
    equations_total: number;
    equations_assigned: number;
    figures_total: number;
    figures_assigned: number;
    tables_total: number;
    tables_assigned: number;
    unassigned: string[];
  };
  word_budget: {
    total_min: number;
    total_max: number;
    sections_valid: boolean;
  };
  feedback: string[];
}

function collectAllSections(outline: OutlineSection[]): OutlineSection[] {
  const out: OutlineSection[] = [];
  const stack = [...outline];
  while (stack.length > 0) {
    const s = stack.shift()!;
    out.push(s);
    if (Array.isArray(s.subsections)) stack.unshift(...s.subsections);
  }
  return out;
}

export function verifyOutlineCoverage(params: {
  outline: OutlineSection[];
  claims_table: EnhancedClaimsTable;
  word_budget?: OutlineWordBudget;
}): OutlineCoverageCheck {
  const feedback: string[] = [];
  const ct = params.claims_table;

  const allClaims = Array.isArray(ct?.claims) ? ct.claims : [];
  const allClaimIds = allClaims.map(c => String((c as any).claim_id));

  const allEquations = Array.isArray(ct?.visual_assets?.formulas) ? ct.visual_assets.formulas : [];
  const allFigures = Array.isArray(ct?.visual_assets?.figures) ? ct.visual_assets.figures : [];
  const allTables = Array.isArray(ct?.visual_assets?.tables) ? ct.visual_assets.tables : [];

  const allSections = collectAllSections(params.outline);

  const assignedClaimIds: string[] = [];
  for (const sec of allSections) assignedClaimIds.push(...(sec.assigned_claims ?? []).map(String));

  const claimCounts = new Map<string, number>();
  for (const id of assignedClaimIds) claimCounts.set(id, (claimCounts.get(id) ?? 0) + 1);

  const duplicated = Array.from(claimCounts.entries())
    .filter(([, n]) => n > 1)
    .map(([id]) => id)
    .sort();

  const assignedUnique = new Set(assignedClaimIds);
  const unassignedClaims = allClaimIds.filter(id => !assignedUnique.has(id));

  if (unassignedClaims.length > 0) {
    feedback.push(`${unassignedClaims.length} claim(s) not assigned to any section: ${unassignedClaims.join(', ')}`);
  }
  if (duplicated.length > 0) {
    feedback.push(`${duplicated.length} claim(s) assigned multiple times: ${duplicated.join(', ')}`);
  }

  const collectAssigned = (field: 'assigned_equations' | 'assigned_figures' | 'assigned_tables'): Set<string> => {
    const set = new Set<string>();
    for (const sec of allSections) {
      const ids = (sec as any)[field];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) set.add(String(id));
    }
    return set;
  };

  const assignedEquations = collectAssigned('assigned_equations');
  const assignedFigures = collectAssigned('assigned_figures');
  const assignedTables = collectAssigned('assigned_tables');

  const allEquationIds = allEquations.map((e: any) => String(e.evidence_id));
  const allFigureIds = allFigures.map((e: any) => String(e.evidence_id));
  const allTableIds = allTables.map((e: any) => String(e.evidence_id));

  const unassignedAssets: string[] = [];
  for (const id of allEquationIds) if (!assignedEquations.has(id)) unassignedAssets.push(id);
  for (const id of allFigureIds) if (!assignedFigures.has(id)) unassignedAssets.push(id);
  for (const id of allTableIds) if (!assignedTables.has(id)) unassignedAssets.push(id);

  if (unassignedAssets.length > 0) {
    feedback.push(`${unassignedAssets.length} asset(s) not assigned to any section: ${unassignedAssets.join(', ')}`);
  }

  const wb = params.word_budget;
  const sectionsValid = (() => {
    if (!wb) return false;
    if (!Array.isArray(wb.per_section) || wb.per_section.length !== params.outline.length) return false;
    return wb.per_section.every(b => Number.isFinite(b.min_words) && Number.isFinite(b.max_words) && b.min_words >= 0 && b.max_words >= b.min_words);
  })();

  const totalMin = wb?.per_section?.reduce((a, b) => a + (Number.isFinite(b.min_words) ? b.min_words : 0), 0) ?? 0;
  const totalMax = wb?.per_section?.reduce((a, b) => a + (Number.isFinite(b.max_words) ? b.max_words : 0), 0) ?? 0;

  if (wb && (totalMin <= 0 || totalMax <= 0)) {
    feedback.push('Word budget totals are not valid.');
  }

  const pass = unassignedClaims.length === 0 && duplicated.length === 0 && unassignedAssets.length === 0 && sectionsValid;

  return {
    pass,
    claims: {
      total: allClaimIds.length,
      assigned: assignedUnique.size,
      unassigned: unassignedClaims,
      duplicated,
    },
    assets: {
      equations_total: allEquationIds.length,
      equations_assigned: assignedEquations.size,
      figures_total: allFigureIds.length,
      figures_assigned: assignedFigures.size,
      tables_total: allTableIds.length,
      tables_assigned: assignedTables.size,
      unassigned: unassignedAssets,
    },
    word_budget: {
      total_min: totalMin,
      total_max: totalMax,
      sections_valid: sectionsValid,
    },
    feedback,
  };
}

