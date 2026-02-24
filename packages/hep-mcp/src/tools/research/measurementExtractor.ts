/**
 * Measurement Extractor
 * Extracts numerical measurements with uncertainties from LaTeX papers
 *
 * Supports formats:
 * - 80.4 ± 0.1 GeV
 * - (1.23 ± 0.05) × 10^-3
 * - 125.10 +0.14 -0.11 GeV (asymmetric)
 * - 0.1181(11) (parenthetical uncertainty)
 * - $80.4^{+0.1}_{-0.2}$ (LaTeX superscript/subscript)
 * - 1.234^{+0.056}_{-0.078} × 10^{-4} (asymmetric + scientific)
 * - 1.23 ± 0.04 (stat) ± 0.05 (syst) (stat+syst uncertainties)
 * - (5.2 ± 0.3)% (percentage uncertainties)
 */

import { getPaperContent } from './paperContent.js';
import { resolveArxivId } from './arxivSource.js';
import { extractTables } from './extractTables.js';
import { type Table } from './latex/index.js';
import {
  parseTexFile,
  resolveAllIncludes,
  extractDocumentStructure,
} from './latex/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Measurement {
  /** Context hint from surrounding text (e.g., "mass", "width", "coupling") */
  quantity_hint: string;
  /** Central value */
  value: number;
  /** Symmetric uncertainty (for asymmetric, this is the average) */
  uncertainty: number;
  /** Asymmetric uncertainties if available */
  asymmetric?: {
    plus: number;
    minus: number;
  };
  /** Statistical uncertainty component */
  uncertainty_stat?: number;
  /** Systematic uncertainty component */
  uncertainty_syst?: number;
  /** Unit if detected */
  unit?: string;
  /** Whether the measurement is a percentage */
  is_percentage?: boolean;
  /** Surrounding text for context (±100 chars) */
  source_context: string;
  /** Where the measurement was found */
  source_location: 'abstract' | 'text' | 'table' | 'equation';
  /** Raw matched string */
  raw_match: string;
}

export interface MeasurementExtractionParams {
  /** Paper identifier: INSPIRE recid, arXiv ID, or DOI */
  identifier: string;
  /** Target physical quantities to search for (optional, improves precision) */
  target_quantities?: string[];
  /** Include measurements from tables (default: true) */
  include_tables?: boolean;
  /** Maximum measurements to return (default: 50) */
  max_results?: number;
}

export interface MeasurementExtractionResult {
  identifier: string;
  arxiv_id?: string;
  success: boolean;
  error?: string;
  measurements: Measurement[];
  summary: {
    total_found: number;
    from_abstract: number;
    from_text: number;
    from_tables: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Common physics units
const UNITS_PATTERN = '(?:GeV|MeV|keV|eV|TeV|fm|pb|fb|mb|nb|Hz|s|m|kg|K|rad)?';

// Pattern for symmetric uncertainty: value ± uncertainty [unit]
// Matches: 80.4 ± 0.1, 80.4 +/- 0.1, 80.4 pm 0.1
const SYMMETRIC_PATTERN = new RegExp(
  `(\\d+\\.?\\d*)\\s*(?:\\\\pm|±|\\+/-|\\+\\/-|\\+-|\\$\\\\pm\\$)\\s*(\\d+\\.?\\d*)\\s*${UNITS_PATTERN}`,
  'gi'
);

// Pattern for asymmetric uncertainty: value +upper -lower [unit]
// Matches: 125.10 +0.14 -0.11
const ASYMMETRIC_PATTERN = new RegExp(
  `(\\d+\\.?\\d*)\\s*\\+(\\d+\\.?\\d*)\\s*-(\\d+\\.?\\d*)\\s*${UNITS_PATTERN}`,
  'gi'
);

// Pattern for parenthetical uncertainty: value(uncertainty) [unit]
// Matches: 0.1181(11), 125.10(14)
const PARENTHETICAL_PATTERN = new RegExp(
  `(\\d+\\.\\d+)\\((\\d+)\\)\\s*${UNITS_PATTERN}`,
  'gi'
);

// Pattern for scientific notation with uncertainty
// Matches: (1.23 ± 0.05) × 10^-3
const SCIENTIFIC_PATTERN = new RegExp(
  `\\(?\\s*(\\d+\\.?\\d*)\\s*(?:\\\\pm|±|\\+/-)\\s*(\\d+\\.?\\d*)\\s*\\)?\\s*(?:\\\\times|×|\\*|x)\\s*10\\^?\\{?(-?\\d+)\\}?`,
  'gi'
);

// Pattern for LaTeX superscript/subscript asymmetric uncertainties
// Matches: $80.4^{+0.1}_{-0.2}$, 80.4^{+0.1}_{-0.2}, also reversed order ^{}_{} or _{}^{}
const LATEX_ASYMMETRIC_PATTERN = new RegExp(
  `\\$?(\\d+\\.?\\d*)\\s*(?:\\^\\{\\+?(\\d+\\.?\\d*)\\}\\s*_\\{-?(\\d+\\.?\\d*)\\}|_\\{-?(\\d+\\.?\\d*)\\}\\s*\\^\\{\\+?(\\d+\\.?\\d*)\\})\\s*${UNITS_PATTERN}\\$?`,
  'gi'
);

/**
 * Pattern for asymmetric uncertainty with scientific notation
 * Matches: 1.234^{+0.056}_{-0.078} × 10^{-4}
 * Captures: (1)value, (2)plus from ^{+}, (3)minus from _{-}, (4)exponent
 * Also handles reversed order _{-}^{+}
 */
const ASYM_SCIENTIFIC_PATTERN = new RegExp(
  `(\\d+\\.?\\d*)\\s*(?:\\^\\{\\+?(\\d+\\.?\\d*)\\}\\s*_\\{-?(\\d+\\.?\\d*)\\}|_\\{-?(\\d+\\.?\\d*)\\}\\s*\\^\\{\\+?(\\d+\\.?\\d*)\\})\\s*(?:\\\\times|×|\\*|x)\\s*10\\^?\\{?(-?\\d+)\\}?`,
  'gi'
);

/**
 * Pattern for statistical + systematic uncertainties
 * Matches: 1.23 ± 0.04 (stat) ± 0.05 (syst)
 *          1.23 ± 0.04_{stat} ± 0.05_{syst}
 *          1.23 ± 0.04^{stat} ± 0.05^{syst}
 * Captures: (1)value, (2)stat uncertainty, (3)syst uncertainty
 */
const STAT_SYST_PATTERN = new RegExp(
  `(\\d+\\.?\\d*)\\s*(?:\\\\pm|±|\\+/-)\\s*(\\d+\\.?\\d*)\\s*(?:\\(stat\\)|_\\{?stat\\}?|\\^\\{?stat\\}?)\\s*(?:\\\\pm|±|\\+/-)\\s*(\\d+\\.?\\d*)\\s*(?:\\(syst\\)|_\\{?syst\\}?|\\^\\{?syst\\}?)\\s*${UNITS_PATTERN}`,
  'gi'
);

/**
 * Pattern for percentage uncertainties
 * Matches: (5.2 ± 0.3)%
 *          5.2 ± 0.3%
 * Captures: (1)value, (2)uncertainty
 */
const PERCENT_PATTERN = new RegExp(
  `\\(?\\s*(\\d+\\.?\\d*)\\s*(?:\\\\pm|±|\\+/-)\\s*(\\d+\\.?\\d*)\\s*\\)?\\s*%`,
  'gi'
);

// Common physical quantity keywords
const QUANTITY_KEYWORDS = [
  'mass', 'width', 'lifetime', 'branching', 'coupling', 'constant',
  'cross section', 'decay', 'rate', 'momentum', 'energy', 'temperature',
  'luminosity', 'flux', 'radius', 'length', 'time', 'frequency',
  'amplitude', 'phase', 'angle', 'ratio', 'fraction', 'asymmetry',
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract context around a match position
 */
function extractContext(text: string, matchIndex: number, matchLength: number): string {
  const contextRadius = 100;
  const start = Math.max(0, matchIndex - contextRadius);
  const end = Math.min(text.length, matchIndex + matchLength + contextRadius);
  let context = text.slice(start, end);

  // Clean up LaTeX commands
  context = context
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return context;
}

/**
 * Extract quantity hint from context
 */
function extractQuantityHint(context: string, targetQuantities?: string[]): string {
  const contextLower = context.toLowerCase();

  // Check target quantities first
  if (targetQuantities) {
    for (const target of targetQuantities) {
      if (contextLower.includes(target.toLowerCase())) {
        return target;
      }
    }
  }

  // Check common keywords
  for (const keyword of QUANTITY_KEYWORDS) {
    if (contextLower.includes(keyword)) {
      return keyword;
    }
  }

  return 'unknown';
}

/**
 * Extract unit from match string
 */
function extractUnit(matchStr: string): string | undefined {
  const unitMatch = matchStr.match(/(GeV|MeV|keV|eV|TeV|fm|pb|fb|mb|nb|Hz|s|m|kg|K|rad)/i);
  return unitMatch ? unitMatch[1] : undefined;
}

/**
 * Calculate combined uncertainty from statistical and systematic components
 * Uses quadrature sum: sqrt(stat^2 + syst^2)
 */
function calculateCombinedUncertainty(stat: number, syst: number): number {
  return Math.sqrt(stat * stat + syst * syst);
}

/**
 * Convert parenthetical uncertainty to absolute value
 * e.g., 0.1181(11) means 0.1181 ± 0.0011
 */
function parseParentheticalUncertainty(value: string, uncertainty: string): number {
  // Find decimal places in value
  const decimalIndex = value.indexOf('.');
  if (decimalIndex === -1) {
    return parseInt(uncertainty);
  }

  const decimalPlaces = value.length - decimalIndex - 1;

  return parseInt(uncertainty) / Math.pow(10, decimalPlaces);
}

/**
 * Extract measurements from text using regex patterns
 */
function extractFromText(
  text: string,
  location: 'abstract' | 'text',
  targetQuantities?: string[]
): Measurement[] {
  const measurements: Measurement[] = [];

  // Symmetric uncertainties
  let match: RegExpExecArray | null;
  const symPattern = new RegExp(SYMMETRIC_PATTERN.source, 'gi');
  while ((match = symPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const uncertainty = parseFloat(match[2]);
    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value,
      uncertainty,
      unit: extractUnit(match[0]),
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // Asymmetric uncertainties
  const asymPattern = new RegExp(ASYMMETRIC_PATTERN.source, 'gi');
  while ((match = asymPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const plus = parseFloat(match[2]);
    const minus = parseFloat(match[3]);
    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value,
      uncertainty: (plus + minus) / 2,
      asymmetric: { plus, minus },
      unit: extractUnit(match[0]),
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // Parenthetical uncertainties
  const parenPattern = new RegExp(PARENTHETICAL_PATTERN.source, 'gi');
  while ((match = parenPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const uncertainty = parseParentheticalUncertainty(match[1], match[2]);
    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value,
      uncertainty,
      unit: extractUnit(match[0]),
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // Scientific notation
  const sciPattern = new RegExp(SCIENTIFIC_PATTERN.source, 'gi');
  while ((match = sciPattern.exec(text)) !== null) {
    const mantissa = parseFloat(match[1]);
    const mantissaUncertainty = parseFloat(match[2]);
    const exponent = parseInt(match[3]);
    const multiplier = Math.pow(10, exponent);

    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value: mantissa * multiplier,
      uncertainty: mantissaUncertainty * multiplier,
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // LaTeX superscript/subscript asymmetric uncertainties
  // Pattern captures: (1)value, (2)plus from ^{+}, (3)minus from _{-}, OR (4)minus from _{-}, (5)plus from ^{+}
  const latexAsymPattern = new RegExp(LATEX_ASYMMETRIC_PATTERN.source, 'gi');
  while ((match = latexAsymPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    // Handle both orderings: ^{+}_{-} or _{-}^{+}
    const plus = match[2] !== undefined ? parseFloat(match[2]) : parseFloat(match[5]);
    const minus = match[3] !== undefined ? parseFloat(match[3]) : parseFloat(match[4]);
    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value,
      uncertainty: (plus + minus) / 2,
      asymmetric: { plus, minus },
      unit: extractUnit(match[0]),
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // Asymmetric + scientific notation
  // Pattern captures: (1)value, (2)plus from ^{+}, (3)minus from _{-}, OR (4)minus from _{-}, (5)plus from ^{+}, (6)exponent
  const asymSciPattern = new RegExp(ASYM_SCIENTIFIC_PATTERN.source, 'gi');
  while ((match = asymSciPattern.exec(text)) !== null) {
    const mantissa = parseFloat(match[1]);
    // Handle both orderings: ^{+}_{-} or _{-}^{+}
    const mantissaPlus = match[2] !== undefined ? parseFloat(match[2]) : parseFloat(match[5]);
    const mantissaMinus = match[3] !== undefined ? parseFloat(match[3]) : parseFloat(match[4]);
    const exponent = parseInt(match[6]);
    const multiplier = Math.pow(10, exponent);

    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value: mantissa * multiplier,
      uncertainty: ((mantissaPlus + mantissaMinus) / 2) * multiplier,
      asymmetric: {
        plus: mantissaPlus * multiplier,
        minus: mantissaMinus * multiplier,
      },
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // Statistical + systematic uncertainties
  // Pattern captures: (1)value, (2)stat uncertainty, (3)syst uncertainty
  const statSystPattern = new RegExp(STAT_SYST_PATTERN.source, 'gi');
  while ((match = statSystPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const stat = parseFloat(match[2]);
    const syst = parseFloat(match[3]);
    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value,
      uncertainty: calculateCombinedUncertainty(stat, syst),
      uncertainty_stat: stat,
      uncertainty_syst: syst,
      unit: extractUnit(match[0]),
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  // Percentage uncertainties
  // Pattern captures: (1)value, (2)uncertainty
  const percentPattern = new RegExp(PERCENT_PATTERN.source, 'gi');
  while ((match = percentPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const uncertainty = parseFloat(match[2]);
    const context = extractContext(text, match.index, match[0].length);

    measurements.push({
      quantity_hint: extractQuantityHint(context, targetQuantities),
      value,
      uncertainty,
      is_percentage: true,
      source_context: context,
      source_location: location,
      raw_match: match[0],
    });
  }

  return measurements;
}

/**
 * Extract measurements from tables
 */
function extractFromTables(
  tables: Table[],
  targetQuantities?: string[]
): Measurement[] {
  const measurements: Measurement[] = [];

  for (const table of tables) {
    // Check caption for quantity hints
    const captionHint = table.caption
      ? extractQuantityHint(table.caption, targetQuantities)
      : 'unknown';

    // Process each row
    for (const row of table.data || []) {
      for (const cell of row) {
        // Try to extract measurements from cell content
        const cellMeasurements = extractFromText(cell, 'text', targetQuantities);
        for (const m of cellMeasurements) {
          measurements.push({
            ...m,
            source_location: 'table',
            quantity_hint: m.quantity_hint !== 'unknown' ? m.quantity_hint : captionHint,
            source_context: `[Table: ${table.caption || 'Untitled'}] ${m.source_context}`,
          });
        }
      }
    }
  }

  return measurements;
}

/**
 * Filter measurements by target quantities
 */
function filterByTargetQuantities(
  measurements: Measurement[],
  targetQuantities: string[]
): Measurement[] {
  if (!targetQuantities || targetQuantities.length === 0) {
    return measurements;
  }

  const targetsLower = targetQuantities.map(t => t.toLowerCase());

  return measurements.filter(m => {
    const contextLower = m.source_context.toLowerCase();
    return targetsLower.some(target => contextLower.includes(target));
  });
}

/**
 * Deduplicate measurements based on value and uncertainty
 */
function deduplicateMeasurements(measurements: Measurement[]): Measurement[] {
  const seen = new Set<string>();
  const unique: Measurement[] = [];

  for (const m of measurements) {
    const key = `${m.value.toFixed(6)}_${m.uncertainty.toFixed(6)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(m);
    }
  }

  return unique;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract numerical measurements from a paper
 */
export async function extractMeasurements(
  params: MeasurementExtractionParams
): Promise<MeasurementExtractionResult> {
  const {
    identifier,
    target_quantities,
    include_tables = true,
    max_results = 50,
  } = params;

  try {
    // Resolve arXiv ID
    const arxivId = await resolveArxivId(identifier);
    if (!arxivId) {
      return {
        identifier,
        success: false,
        error: 'Could not resolve arXiv ID',
        measurements: [],
        summary: { total_found: 0, from_abstract: 0, from_text: 0, from_tables: 0 },
      };
    }

    // Download LaTeX source
    const content = await getPaperContent({
      identifier: arxivId,
      prefer: 'latex',
      extract: true,
    });

    if (!content.success || content.source_type !== 'latex' || !content.main_tex) {
      return {
        identifier,
        arxiv_id: arxivId,
        success: false,
        error: content.fallback_reason || 'LaTeX source not available',
        measurements: [],
        summary: { total_found: 0, from_abstract: 0, from_text: 0, from_tables: 0 },
      };
    }

    // Parse LaTeX
    const doc = parseTexFile(content.main_tex);
    const resolved = resolveAllIncludes(doc);
    const structure = extractDocumentStructure(resolved.ast);

    // Extract from abstract
    const abstractMeasurements = structure.abstract
      ? extractFromText(structure.abstract, 'abstract', target_quantities)
      : [];

    // Extract from main text
    const textMeasurements = extractFromText(content.main_tex, 'text', target_quantities);

    // Extract from tables
    let tableMeasurements: Measurement[] = [];
    if (include_tables) {
      try {
        const tableResult = await extractTables({ identifier: arxivId });
        if (tableResult.tables && tableResult.tables.length > 0) {
          tableMeasurements = extractFromTables(tableResult.tables, target_quantities);
        }
      } catch {
        // Skip table extraction on error
      }
    }

    // Combine and filter
    let allMeasurements = [
      ...abstractMeasurements,
      ...textMeasurements,
      ...tableMeasurements,
    ];

    // Filter by target quantities if specified
    if (target_quantities && target_quantities.length > 0) {
      allMeasurements = filterByTargetQuantities(allMeasurements, target_quantities);
    }

    // Deduplicate
    allMeasurements = deduplicateMeasurements(allMeasurements);

    // Limit results
    const limitedMeasurements = allMeasurements.slice(0, max_results);

    return {
      identifier,
      arxiv_id: arxivId,
      success: true,
      measurements: limitedMeasurements,
      summary: {
        total_found: allMeasurements.length,
        from_abstract: abstractMeasurements.length,
        from_text: textMeasurements.length,
        from_tables: tableMeasurements.length,
      },
    };

  } catch (error) {
    return {
      identifier,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      measurements: [],
      summary: { total_found: 0, from_abstract: 0, from_text: 0, from_tables: 0 },
    };
  }
}
