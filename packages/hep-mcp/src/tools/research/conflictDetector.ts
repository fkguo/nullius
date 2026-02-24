/**
 * Conflict Detector Module
 * Detects implicit conflicts between papers based on numerical measurements
 *
 * Features:
 * - Tension calculation between measurements
 * - Conflict classification (hard, soft, apparent)
 * - Compatible measurement grouping
 */

import * as api from '../../api/client.js';
import { extractMeasurements, type Measurement } from './measurementExtractor.js';
import { getConfig, validateRecids, getConversionFactor, areUnitsCompatible } from './config.js';
import { getToolSpec as getPdgToolSpec } from '@autoresearch/pdg-mcp/tooling';
import {
  PDG_GET_PROPERTY,
} from '@autoresearch/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConflictType = 'hard' | 'soft' | 'apparent';

export interface MeasurementWithSource extends Measurement {
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
}

export interface ConflictAnalysis {
  /** Type of conflict */
  conflict_type: ConflictType;
  /** Tension in units of sigma */
  tension_sigma: number;
  /** Physical quantity in conflict */
  quantity: string;
  /** Measurements involved */
  measurements: Array<{
    recid: string;
    title: string;
    value: number;
    uncertainty: number;
    year?: number;
  }>;
  /** Explanation */
  notes: string;
}

export interface CompatibleGroup {
  /** Physical quantity */
  quantity: string;
  /** Papers with compatible measurements */
  papers: Array<{ recid: string; title: string; }>;
  /** Combined value if calculable */
  combined_value?: string;
  /** Weighted average */
  weighted_average?: number;
  /** Combined uncertainty */
  combined_uncertainty?: number;
}

export interface ConflictDetectionParams {
  /** Paper identifiers to analyze */
  recids: string[];
  /** Target physical quantities to focus on (optional) */
  target_quantities?: string[];
  /** Minimum tension threshold in sigma (default: 3) */
  min_tension_sigma?: number;
  /** Include measurements from tables (default: true) */
  include_tables?: boolean;
}

export interface ConflictDetectionResult {
  success: boolean;
  error?: string;
  /** Non-fatal warnings (e.g. optional PDG baseline skipped) */
  warnings: string[];
  /** Detected conflicts */
  conflicts: ConflictAnalysis[];
  /** Compatible measurement groups */
  compatible_groups: CompatibleGroup[];
  /** Summary */
  summary: {
    papers_analyzed: number;
    total_measurements: number;
    hard_conflicts: number;
    soft_conflicts: number;
    apparent_conflicts: number;
    compatible_quantities: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Thresholds for conflict classification are loaded from config:
// - hardConflictThreshold (default 5.0): > 5σ
// - softConflictThreshold (default 3.0): 3-5σ
// Below 3σ is considered compatible or "apparent" conflict

// Common physical quantity synonyms for grouping
const QUANTITY_SYNONYMS: Record<string, string[]> = {
  'mass': ['mass', 'm', 'mh', 'mw', 'mz', 'mt', 'mb', 'mc', 'ms'],
  'width': ['width', 'gamma', 'decay width', 'total width'],
  'lifetime': ['lifetime', 'tau', 'mean life', 'half-life'],
  'coupling': ['coupling', 'g', 'alpha', 'constant', 'strength'],
  'branching': ['branching', 'br', 'branching ratio', 'fraction'],
  'cross section': ['cross section', 'sigma', 'xs', 'production'],
};

function wantsPdgWmassBaseline(targetQuantities?: string[]): boolean {
  if (!Array.isArray(targetQuantities) || targetQuantities.length === 0) return false;
  return targetQuantities.some(t => {
    const s = String(t).toLowerCase();
    if (s.includes('m_w') || s.includes('m w')) return true;
    if (/\bmw\b/.test(s)) return true;
    if (s.includes('w mass') || s.includes('w boson mass')) return true;
    if (s.includes('mass') && (s.includes('w boson') || /\bw\b/.test(s))) return true;
    return false;
  });
}

function symmetricUncertaintyFromAsymmetric(errPos: unknown, errNeg: unknown): number | null {
  const p = typeof errPos === 'number' ? Math.abs(errPos) : Number.isFinite(Number(errPos)) ? Math.abs(Number(errPos)) : NaN;
  const n = typeof errNeg === 'number' ? Math.abs(errNeg) : Number.isFinite(Number(errNeg)) ? Math.abs(Number(errNeg)) : NaN;
  if (Number.isFinite(p) && Number.isFinite(n)) return (p + n) / 2;
  if (Number.isFinite(p)) return p;
  if (Number.isFinite(n)) return n;
  return null;
}

type PdgGetPropertyOutput = {
  edition?: unknown;
  value?: {
    value?: unknown;
    error_positive?: unknown;
    error_negative?: unknown;
    unit_text?: unknown;
  };
};

async function tryGetPdgWmassBaseline(): Promise<{ measurement: MeasurementWithSource | null; warning?: string }> {
  const spec = getPdgToolSpec(PDG_GET_PROPERTY);
  if (!spec) {
    return { measurement: null, warning: 'pdg_baseline_skipped:pdg_get_property_unavailable' };
  }
  try {
    const parsed = spec.zodSchema.parse({
      particle: { name: 'W boson' },
      property: 'mass',
    });

    const out = (await spec.handler(parsed as any, {} as any)) as PdgGetPropertyOutput;
    const value = Number(out?.value?.value);
    if (!Number.isFinite(value)) {
      return { measurement: null, warning: 'pdg_baseline_skipped:missing_value' };
    }

    const unc = symmetricUncertaintyFromAsymmetric(out?.value?.error_positive, out?.value?.error_negative);
    if (!unc || !Number.isFinite(unc) || unc <= 0) {
      return { measurement: null, warning: 'pdg_baseline_skipped:missing_uncertainty' };
    }

    const unit = typeof out?.value?.unit_text === 'string' && out.value.unit_text.trim() ? out.value.unit_text.trim() : 'GeV';
    const editionRaw = typeof out?.edition === 'string' ? out.edition : null;
    const year = editionRaw && /\b(19|20)\d{2}\b/.test(editionRaw) ? Number(editionRaw.match(/\b(19|20)\d{2}\b/)![0]) : undefined;

    return {
      measurement: {
      quantity_hint: 'm_W',
      value,
      uncertainty: unc,
      unit,
      source_context: 'PDG world average (pdg_get_property)',
      source_location: 'abstract',
      raw_match: 'PDG',
      paper_recid: 'PDG',
      paper_title: editionRaw ? `PDG (${editionRaw})` : 'PDG (world average)',
      paper_year: year,
      },
    };
  } catch (error) {
    // Optional enhancement; never fail the main conflict detector.
    const msg = error instanceof Error ? error.message : String(error);
    console.debug(`[hep-research-mcp] PDG baseline (m_W): skipped - ${msg}`);
    return { measurement: null, warning: `pdg_baseline_skipped:${msg}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate tension between two measurements
 * T = |V_A - V_B| / sqrt(δ_A^2 + δ_B^2)
 */
function calculateTension(
  value1: number,
  uncertainty1: number,
  value2: number,
  uncertainty2: number
): number {
  const diff = Math.abs(value1 - value2);
  const combinedUncertainty = Math.sqrt(
    uncertainty1 * uncertainty1 + uncertainty2 * uncertainty2
  );

  if (combinedUncertainty === 0) {
    return diff > 0 ? Infinity : 0;
  }

  return diff / combinedUncertainty;
}

/**
 * Classify conflict type based on tension
 */
function classifyConflict(tension: number): ConflictType {
  const config = getConfig().criticalResearch;
  const hardThreshold = config?.hardConflictThreshold ?? 5.0;
  const softThreshold = config?.softConflictThreshold ?? 3.0;

  if (tension > hardThreshold) return 'hard';
  if (tension > softThreshold) return 'soft';
  return 'apparent';
}

/**
 * Normalize quantity hint to a standard form
 */
function normalizeQuantity(hint: string): string {
  const hintLower = hint.toLowerCase().trim();

  for (const [standard, synonyms] of Object.entries(QUANTITY_SYNONYMS)) {
    for (const synonym of synonyms) {
      if (hintLower.includes(synonym)) {
        return standard;
      }
    }
  }

  return hintLower;
}

/**
 * Group measurements by quantity
 */
function groupByQuantity(
  measurements: MeasurementWithSource[]
): Map<string, MeasurementWithSource[]> {
  const groups = new Map<string, MeasurementWithSource[]>();

  for (const m of measurements) {
    const normalizedQuantity = normalizeQuantity(m.quantity_hint);

    if (!groups.has(normalizedQuantity)) {
      groups.set(normalizedQuantity, []);
    }
    groups.get(normalizedQuantity)!.push(m);
  }

  return groups;
}

/**
 * Check if two measurements can be compared (same quantity, similar context)
 * Now includes automatic unit conversion for compatible units
 */
function areComparable(m1: MeasurementWithSource, m2: MeasurementWithSource): boolean {
  // Skip if from the same paper
  if (m1.paper_recid === m2.paper_recid) return false;

  // If both have units and they differ, check if conversion is possible
  if (m1.unit && m2.unit && m1.unit !== m2.unit) {
    // Check if units are compatible using config.ts function
    if (!areUnitsCompatible(m1.unit, m2.unit)) {
      // Units are incompatible (e.g., mass vs time)
      return false;
    }
    // If units are compatible, measurements are comparable
    // The actual conversion will happen in the conflict detection loop
  }

  // Check if values are in similar range (within 3 orders of magnitude)
  // Note: This check is now less strict since we handle unit conversions
  const ratio = Math.abs(m1.value / m2.value);
  if (ratio > 1e6 || ratio < 1e-6) {
    // Values differ by more than 6 orders of magnitude - likely different quantities
    return false;
  }

  return true;
}

/**
 * Calculate weighted average of measurements
 */
function calculateWeightedAverage(
  measurements: MeasurementWithSource[]
): { average: number; uncertainty: number } | undefined {
  if (measurements.length === 0) return undefined;

  let weightSum = 0;
  let weightedValueSum = 0;

  for (const m of measurements) {
    if (m.uncertainty <= 0) continue;

    const weight = 1 / (m.uncertainty * m.uncertainty);
    weightSum += weight;
    weightedValueSum += weight * m.value;
  }

  if (weightSum === 0) return undefined;

  const average = weightedValueSum / weightSum;
  const uncertainty = Math.sqrt(1 / weightSum);

  return { average, uncertainty };
}

/**
 * Format value with uncertainty
 */
function formatMeasurement(value: number, uncertainty: number): string {
  // Determine appropriate precision
  const uncertaintyOrder = Math.floor(Math.log10(uncertainty));
  const precision = Math.max(0, -uncertaintyOrder + 1);

  return `${value.toFixed(precision)} ± ${uncertainty.toFixed(precision)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect conflicts between measurements in a set of papers
 */
export async function detectConflicts(
  params: ConflictDetectionParams
): Promise<ConflictDetectionResult> {
  const {
    recids,
    target_quantities,
    min_tension_sigma = 3.0,
    include_tables = true,
  } = params;
  const warnings: string[] = [];

  // Validate recids
  const validationError = validateRecids(recids);
  if (validationError) {
    return {
      success: false,
      error: validationError,
      warnings,
      conflicts: [],
      compatible_groups: [],
      summary: {
        papers_analyzed: 0,
        total_measurements: 0,
        hard_conflicts: 0,
        soft_conflicts: 0,
        apparent_conflicts: 0,
        compatible_quantities: 0,
      },
    };
  }

  // Collect measurements from all papers (parallel fetch for performance)
  const allMeasurements: MeasurementWithSource[] = [];

  // Fetch paper data and measurements in parallel
  const fetchPromises = recids.map(async (recid) => {
    try {
      // Get paper metadata and extract measurements in parallel
      const [paper, measurementResult] = await Promise.all([
        api.getPaper(recid),
        extractMeasurements({
          identifier: recid,
          target_quantities,
          include_tables,
          max_results: 50,
        }),
      ]);

      if (measurementResult.success) {
        return {
          recid,
          paper,
          measurements: measurementResult.measurements,
        };
      }
      return null;
    } catch (error) {
      // Log at debug level for troubleshooting
      console.debug(`[hep-research-mcp] fetchPaperData (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  });

  // Wait for all parallel fetches
  const results = await Promise.all(fetchPromises);

  // Collect successful results
  for (const result of results) {
    if (result) {
      for (const m of result.measurements) {
        allMeasurements.push({
          ...m,
          paper_recid: result.recid,
          paper_title: result.paper.title,
          paper_year: result.paper.year,
        });
      }
    }
  }

  // Optional: include PDG world-average baseline when target quantity matches.
  if (wantsPdgWmassBaseline(target_quantities)) {
    const pdg = await tryGetPdgWmassBaseline();
    if (pdg.measurement) allMeasurements.push(pdg.measurement);
    if (pdg.warning) warnings.push(pdg.warning);
  }

  // Group measurements by quantity
  const groups = groupByQuantity(allMeasurements);

  // Detect conflicts and compatible groups
  const conflicts: ConflictAnalysis[] = [];
  const compatibleGroups: CompatibleGroup[] = [];

  for (const [quantity, measurements] of groups.entries()) {
    // Skip if only one measurement
    if (measurements.length < 2) continue;

    // Check all pairs for conflicts
    const conflictPairs: Array<{
      m1: MeasurementWithSource;
      m2: MeasurementWithSource;
      tension: number;
      unitsConverted: boolean;
    }> = [];

    for (let i = 0; i < measurements.length; i++) {
      for (let j = i + 1; j < measurements.length; j++) {
        const m1 = measurements[i];
        const m2 = measurements[j];

        if (!areComparable(m1, m2)) continue;

        // Convert units if needed to enable comparison
        let value1 = m1.value;
        let uncertainty1 = m1.uncertainty;
        let value2 = m2.value;
        let uncertainty2 = m2.uncertainty;
        let unitsConverted = false;

        // If units differ, convert m2 to m1's units using config.ts function
        if (m1.unit && m2.unit && m1.unit !== m2.unit) {
          const conversionFactor = getConversionFactor(m2.unit, m1.unit);
          if (conversionFactor !== null) {
            value2 = m2.value * conversionFactor;
            uncertainty2 = m2.uncertainty * conversionFactor;
            unitsConverted = true;
          } else {
            // Conversion failed despite areComparable check - skip this pair
            continue;
          }
        }

        const tension = calculateTension(
          value1, uncertainty1,
          value2, uncertainty2
        );

        if (tension >= min_tension_sigma) {
          conflictPairs.push({ m1, m2, tension, unitsConverted });
        }
      }
    }

    // Create conflict entries
    for (const { m1, m2, tension, unitsConverted } of conflictPairs) {
      const conflictType = classifyConflict(tension);

      let notes = `Tension of ${tension.toFixed(1)}σ between measurements`;

      // Add unit conversion note if applicable
      if (unitsConverted && m1.unit && m2.unit) {
        notes += ` (${m2.unit} converted to ${m1.unit})`;
      }
      notes += '. ';

      if (conflictType === 'hard') {
        notes += 'This is a significant disagreement that requires explanation.';
      } else if (conflictType === 'soft') {
        notes += 'This tension may indicate systematic effects or new physics.';
      } else {
        notes += 'This is a mild tension, possibly due to statistical fluctuation.';
      }

      conflicts.push({
        conflict_type: conflictType,
        tension_sigma: Math.round(tension * 10) / 10,
        quantity,
        measurements: [
          {
            recid: m1.paper_recid,
            title: m1.paper_title,
            value: m1.value,
            uncertainty: m1.uncertainty,
            year: m1.paper_year,
          },
          {
            recid: m2.paper_recid,
            title: m2.paper_title,
            value: m2.value,
            uncertainty: m2.uncertainty,
            year: m2.paper_year,
          },
        ],
        notes,
      });
    }

    // If no conflicts, create compatible group
    if (conflictPairs.length === 0 && measurements.length >= 2) {
      const weighted = calculateWeightedAverage(measurements);

      // Get unique papers
      const paperMap = new Map<string, { recid: string; title: string }>();
      for (const m of measurements) {
        paperMap.set(m.paper_recid, {
          recid: m.paper_recid,
          title: m.paper_title,
        });
      }

      compatibleGroups.push({
        quantity,
        papers: Array.from(paperMap.values()),
        combined_value: weighted
          ? formatMeasurement(weighted.average, weighted.uncertainty)
          : undefined,
        weighted_average: weighted?.average,
        combined_uncertainty: weighted?.uncertainty,
      });
    }
  }

  // Sort conflicts by tension (highest first)
  conflicts.sort((a, b) => b.tension_sigma - a.tension_sigma);

  // Calculate summary
  const hardCount = conflicts.filter(c => c.conflict_type === 'hard').length;
  const softCount = conflicts.filter(c => c.conflict_type === 'soft').length;
  const apparentCount = conflicts.filter(c => c.conflict_type === 'apparent').length;

  return {
    success: true,
    warnings,
    conflicts,
    compatible_groups: compatibleGroups,
    summary: {
      papers_analyzed: recids.length,
      total_measurements: allMeasurements.length,
      hard_conflicts: hardCount,
      soft_conflicts: softCount,
      apparent_conflicts: apparentCount,
      compatible_quantities: compatibleGroups.length,
    },
  };
}
