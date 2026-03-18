import * as fs from 'fs';
import { createHash } from 'crypto';
import { invalidParams } from '@autoresearch/shared';

import type { RunArtifactRef } from '../runs.js';
import { getRun } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';
import { createHepRunArtifactRef, makeHepRunArtifactUri, makeHepRunManifestUri } from '../runArtifactUri.js';
import { startRunStep, completeRunStep } from '../zotero/runSteps.js';
import { canonicalizeUnit, detectUnitCategory } from '../../tools/research/config.js';
import type { LatexLocatorV1 } from '../evidence.js';

type EvidenceType =
  | 'title'
  | 'abstract'
  | 'section'
  | 'paragraph'
  | 'equation'
  | 'figure'
  | 'table'
  | 'theorem'
  | 'citation_context';

export interface EvidenceCatalogItemV1Like {
  version?: number;
  evidence_id: string;
  project_id: string;
  paper_id: string;
  type: EvidenceType;
  locator: LatexLocatorV1;
  text: string;
  normalized_text?: string;
  meta?: Record<string, unknown>;
}

export interface HepMeasurementArtifactItemV1 {
  version: 1;
  measurement_id: string;
  run_id: string;
  project_id: string;
  paper_id: string;
  evidence_id: string;
  evidence_type: EvidenceType;
  locator: LatexLocatorV1;
  quantity_hint: string;
  quantity_normalized: string;
  value: number;
  uncertainty: number;
  asymmetric?: { plus: number; minus: number };
  uncertainty_stat?: number;
  uncertainty_syst?: number;
  unit_raw?: string;
  unit?: string;
  unit_category?: string;
  is_percentage?: boolean;
  raw_match: string;
  source_text_preview: string;
}

export interface HepMeasurementsMetaV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  source: {
    latex_catalog_artifact_name: string;
    include_types: EvidenceType[];
  };
  budgets: {
    max_results: number;
  };
  stats: {
    evidence_items_scanned: number;
    measurements_found: number;
    measurements_written: number;
    unknown_unit: number;
  };
  by_quantity: Record<string, number>;
  by_unit: Record<string, number>;
  warnings: string[];
  artifacts: {
    measurements_uri: string;
    meta_uri: string;
    diagnostics_uri?: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function cleanLatexForUnitScan(input: string): string {
  return input
    .replace(/\\(mathrm|text)\{([^}]*)\}/g, '$2')
    .replace(/\\[ ,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUnitCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, '')
    .replace(/\\(mathrm|text)\{([^}]*)\}/g, '$2')
    .replace(/\{(-?\d+)\}/g, '$1')
    .replace(/²/g, '^2');
}

function unitFromToken(token: string): string | null {
  const normalized = normalizeUnitCandidate(token);
  if (!normalized) return null;

  const direct = canonicalizeUnit(normalized);
  if (direct) return direct;

  // e.g. fb^{-1} / fb^-1 / 1/fb → /fb
  const inv = normalized.match(/^([a-zA-Zμ]+)\^-1$/);
  if (inv?.[1]) {
    const candidate = `/${inv[1]}`;
    return canonicalizeUnit(candidate);
  }
  const inv2 = normalized.match(/^1\/([a-zA-Zμ]+)$/);
  if (inv2?.[1]) {
    const candidate = `/${inv2[1]}`;
    return canonicalizeUnit(candidate);
  }

  return null;
}

function extractUnitToken(matchStr: string): { unit_raw?: string; unit?: string; unit_category?: string } {
  const cleaned = cleanLatexForUnitScan(matchStr);
  const candidates = cleaned.match(/[A-Za-zμ/][A-Za-z0-9μ/^\-²{}]*/g) ?? [];
  for (const token of candidates) {
    const unit = unitFromToken(token);
    if (!unit) continue;
    const category = detectUnitCategory(unit);
    return { unit_raw: token, unit, unit_category: category ?? undefined };
  }
  return {};
}

function extractUnitNearSpan(text: string, start: number, end: number): { unit_raw?: string; unit?: string; unit_category?: string } {
  const forward = text.slice(end, Math.min(text.length, end + 64));
  const f = extractUnitToken(forward);
  if (f.unit) return f;

  const near = text.slice(Math.max(0, start - 24), Math.min(text.length, end + 24));
  const n = extractUnitToken(near);
  if (n.unit) return n;

  const ctx = extractContext(text, start, end - start);
  return extractUnitToken(ctx);
}

function extractContext(text: string, matchIndex: number, matchLength: number): string {
  const contextRadius = 120;
  const start = Math.max(0, matchIndex - contextRadius);
  const end = Math.min(text.length, matchIndex + matchLength + contextRadius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

const QUANTITY_KEYWORDS = [
  'mass',
  'width',
  'lifetime',
  'branching',
  'branching ratio',
  'cross section',
  'sigma',
  'coupling',
  'constant',
  'temperature',
  'luminosity',
  'rate',
];

const QUANTITY_SYNONYMS: Record<string, string[]> = {
  mass: ['mass', 'm', 'mh', 'mw', 'mz', 'mt', 'mb', 'mc', 'ms'],
  width: ['width', 'gamma', 'decay width', 'total width'],
  lifetime: ['lifetime', 'tau', 'mean life', 'half-life'],
  coupling: ['coupling', 'g', 'alpha', 'constant', 'strength'],
  branching: ['branching', 'br', 'branching ratio', 'fraction'],
  'cross section': ['cross section', 'sigma', 'xs', 'production'],
  luminosity: ['luminosity', 'integrated luminosity'],
};

function extractQuantityHint(context: string, targetQuantities?: string[]): string {
  const contextLower = context.toLowerCase();

  if (targetQuantities) {
    for (const target of targetQuantities) {
      if (contextLower.includes(target.toLowerCase())) {
        return target;
      }
    }
  }

  for (const keyword of QUANTITY_KEYWORDS) {
    if (contextLower.includes(keyword)) return keyword;
  }

  return 'unknown';
}

function normalizeQuantityHint(hint: string): string {
  const hintLower = hint.toLowerCase().trim();
  if (!hintLower) return 'unknown';

  for (const [standard, synonyms] of Object.entries(QUANTITY_SYNONYMS)) {
    for (const synonym of synonyms) {
      if (hintLower.includes(synonym)) return standard;
    }
  }
  return hintLower;
}

function parseParentheticalUncertainty(value: string, uncertainty: string): number {
  const decimalIndex = value.indexOf('.');
  if (decimalIndex === -1) return parseInt(uncertainty, 10);
  const decimalPlaces = value.length - decimalIndex - 1;
  return parseInt(uncertainty, 10) / Math.pow(10, decimalPlaces);
}

function calculateCombinedUncertainty(stat: number, syst: number): number {
  return Math.sqrt(stat * stat + syst * syst);
}

type ParsedMeasurement = {
  start: number;
  end: number;
  value: number;
  uncertainty: number;
  asymmetric?: { plus: number; minus: number };
  uncertainty_stat?: number;
  uncertainty_syst?: number;
  unit_raw?: string;
  unit?: string;
  unit_category?: string;
  is_percentage?: boolean;
  raw_match: string;
};

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function extractMeasurementsFromText(text: string): ParsedMeasurement[] {
  const spans: Array<{ start: number; end: number }> = [];
  const out: ParsedMeasurement[] = [];

  const add = (m: Omit<ParsedMeasurement, 'unit_raw' | 'unit' | 'unit_category'>) => {
    if (!Number.isFinite(m.value) || !Number.isFinite(m.uncertainty)) return;
    if (m.uncertainty < 0) return;
    if (spans.some(s => overlaps(s.start, s.end, m.start, m.end))) return;

    const units = extractUnitToken(m.raw_match);
    out.push({
      start: m.start,
      end: m.end,
      value: m.value,
      uncertainty: m.uncertainty,
      asymmetric: m.asymmetric,
      uncertainty_stat: m.uncertainty_stat,
      uncertainty_syst: m.uncertainty_syst,
      unit_raw: units.unit_raw,
      unit: units.unit,
      unit_category: units.unit_category,
      is_percentage: m.is_percentage,
      raw_match: m.raw_match,
    });
    spans.push({ start: m.start, end: m.end });
  };

  const statSystPattern = new RegExp(
    String.raw`(\d+\.?\d*)\s*(?:\\pm|±|\+/-)\s*(\d+\.?\d*)\s*(?:\(stat\)|_\{?stat\}?|\^\{?stat\}?)\s*(?:\\pm|±|\+/-)\s*(\d+\.?\d*)\s*(?:\(syst\)|_\{?syst\}?|\^\{?syst\}?)`,
    'gi'
  );
  let match: RegExpExecArray | null;
  while ((match = statSystPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const stat = parseFloat(match[2]);
    const syst = parseFloat(match[3]);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value,
      uncertainty: calculateCombinedUncertainty(stat, syst),
      uncertainty_stat: stat,
      uncertainty_syst: syst,
      raw_match: match[0],
    });
  }

  const latexAsymPattern = new RegExp(
    String.raw`\$?(\d+\.?\d*)\s*(?:\^\{\+?(\d+\.?\d*)\}\s*_\{-?(\d+\.?\d*)\}|_\{-?(\d+\.?\d*)\}\s*\^\{\+?(\d+\.?\d*)\})\$?`,
    'gi'
  );
  while ((match = latexAsymPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const plus = match[2] !== undefined ? parseFloat(match[2]) : parseFloat(match[5]);
    const minus = match[3] !== undefined ? parseFloat(match[3]) : parseFloat(match[4]);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value,
      uncertainty: (plus + minus) / 2,
      asymmetric: { plus, minus },
      raw_match: match[0],
    });
  }

  const asymPattern = new RegExp(String.raw`(\d+\.?\d*)\s*\+(\d+\.?\d*)\s*-(\d+\.?\d*)`, 'gi');
  while ((match = asymPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const plus = parseFloat(match[2]);
    const minus = parseFloat(match[3]);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value,
      uncertainty: (plus + minus) / 2,
      asymmetric: { plus, minus },
      raw_match: match[0],
    });
  }

  const scientificPattern = new RegExp(
    String.raw`\(?\s*(\d+\.?\d*)\s*(?:\\pm|±|\+/-)\s*(\d+\.?\d*)\s*\)?\s*(?:\\times|×|\*|x)\s*10\^?\{?(-?\d+)\}?`,
    'gi'
  );
  while ((match = scientificPattern.exec(text)) !== null) {
    const mantissa = parseFloat(match[1]);
    const mantissaUnc = parseFloat(match[2]);
    const exponent = parseInt(match[3], 10);
    const multiplier = Math.pow(10, exponent);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value: mantissa * multiplier,
      uncertainty: mantissaUnc * multiplier,
      raw_match: match[0],
    });
  }

  const parentheticalPattern = new RegExp(String.raw`(\d+\.\d+)\((\d+)\)`, 'gi');
  while ((match = parentheticalPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const uncertainty = parseParentheticalUncertainty(match[1], match[2]);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value,
      uncertainty,
      raw_match: match[0],
    });
  }

  const percentPattern = new RegExp(String.raw`\(?\s*(\d+\.?\d*)\s*(?:\\pm|±|\+/-)\s*(\d+\.?\d*)\s*\)?\s*%`, 'gi');
  while ((match = percentPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const uncertainty = parseFloat(match[2]);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value,
      uncertainty,
      is_percentage: true,
      raw_match: match[0],
    });
  }

  const symmetricPattern = new RegExp(String.raw`(\d+\.?\d*)\s*(?:\\pm|±|\+/-|\+\\/-|\\+-)\s*(\d+\.?\d*)`, 'gi');
  while ((match = symmetricPattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    const uncertainty = parseFloat(match[2]);
    add({
      start: match.index,
      end: match.index + match[0].length,
      value,
      uncertainty,
      raw_match: match[0],
    });
  }

  return out;
}

function makeArtifactNames(params: {
  latex_catalog_artifact_name: string;
  include_types: EvidenceType[];
  max_results: number;
  measurements_artifact_name?: string;
  meta_artifact_name?: string;
}): { measurementsName: string; metaName: string } {
  if (params.measurements_artifact_name && params.meta_artifact_name) {
    return { measurementsName: params.measurements_artifact_name, metaName: params.meta_artifact_name };
  }

  const material = JSON.stringify({
    latex_catalog_artifact_name: params.latex_catalog_artifact_name,
    include_types: params.include_types,
    max_results: params.max_results,
  });
  const hash = sha256Hex(material).slice(0, 16);
  return {
    measurementsName: params.measurements_artifact_name ?? `hep_measurements_${hash}.jsonl`,
    metaName: params.meta_artifact_name ?? `hep_measurements_${hash}_meta.json`,
  };
}

export async function buildRunMeasurements(params: {
  run_id: string;
  latex_catalog_artifact_name: string;
  include_types: EvidenceType[];
  target_quantities?: string[];
  max_results: number;
  measurements_artifact_name?: string;
  meta_artifact_name?: string;
  budget_hints?: {
    max_results_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  measurements_uri: string;
  meta_uri: string;
  summary: {
    evidence_items_scanned: number;
    measurements_found: number;
    measurements_written: number;
    warnings_total: number;
    warnings: string[];
  };
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'hep_measurements');
  const artifacts: RunArtifactRef[] = [];
  const warnings: string[] = [];
  const budget = new BudgetTrackerV1();

  const maxResults = budget.resolveInt({
    key: 'hep.measurements.max_results',
    dimension: 'breadth',
    unit: 'items',
    arg_path: 'max_results',
    tool_value: params.max_results,
    tool_value_present: params.budget_hints?.max_results_provided ?? true,
    env_var: 'HEP_BUDGET_HEP_MEASUREMENTS_MAX_RESULTS',
    default_value: 500,
    min: 1,
    max: 50_000,
  });

  const includeTypes = Array.from(new Set(params.include_types)).sort() as EvidenceType[];

  const { measurementsName, metaName } = makeArtifactNames({
    latex_catalog_artifact_name: params.latex_catalog_artifact_name,
    include_types: includeTypes,
    max_results: maxResults,
    measurements_artifact_name: params.measurements_artifact_name,
    meta_artifact_name: params.meta_artifact_name,
  });

  const inPath = getRunArtifactPath(runId, params.latex_catalog_artifact_name);
  if (!fs.existsSync(inPath)) {
    throw invalidParams('latex_catalog_artifact_name not found in run artifacts', {
      run_id: runId,
      artifact_name: params.latex_catalog_artifact_name,
    });
  }

  const outPath = getRunArtifactPath(runId, measurementsName);
  const out = fs.createWriteStream(outPath, { encoding: 'utf-8' });

  const byQuantity = new Map<string, number>();
  const byUnit = new Map<string, number>();
  let unknownUnit = 0;
  let evidenceItemsScanned = 0;
  let measurementsFound = 0;
  let measurementsWritten = 0;
  let truncated = false;

  const seen = new Set<string>();

  const maxWarningExamples = 10;
  const unknownUnitExamples: string[] = [];

  const pushCount = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const pushMeasurement = (item: EvidenceCatalogItemV1Like, m: ParsedMeasurement) => {
    const ctx = extractContext(item.text, m.start, m.end - m.start);
    const hint = extractQuantityHint(ctx, params.target_quantities);
    const normalizedQuantity = normalizeQuantityHint(hint);

    const extractedUnits = extractUnitNearSpan(item.text, m.start, m.end);
    const unitCandidate = extractedUnits.unit ?? m.unit;
    const unitRaw = extractedUnits.unit_raw ?? m.unit_raw;
    const unitCanonical = unitCandidate ? canonicalizeUnit(unitCandidate) : null;
    const unitFinal = unitCanonical ?? unitCandidate;
    const unitCategory = unitFinal ? detectUnitCategory(unitFinal) : extractedUnits.unit_category ?? null;

    const measurementIdMaterial = JSON.stringify({
      paper_id: item.paper_id,
      evidence_id: item.evidence_id,
      raw_match: m.raw_match,
      value: m.value,
      uncertainty: m.uncertainty,
      unit: unitFinal ?? null,
      is_percentage: Boolean(m.is_percentage),
    });
    const measurementId = `m_${sha256Hex(measurementIdMaterial).slice(0, 16)}`;
    if (seen.has(measurementId)) return;
    seen.add(measurementId);

    measurementsFound += 1;
    if (measurementsWritten >= maxResults) {
      truncated = true;
      return;
    }

    const unitKey = unitFinal ?? 'unknown';
    pushCount(byQuantity, normalizedQuantity);
    pushCount(byUnit, unitKey);

    if (!unitFinal && !m.is_percentage) {
      unknownUnit += 1;
      if (unknownUnitExamples.length < maxWarningExamples) {
        unknownUnitExamples.push(`${m.raw_match} @${item.paper_id}/${item.evidence_id}`);
      }
    }

    const rec: HepMeasurementArtifactItemV1 = {
      version: 1,
      measurement_id: measurementId,
      run_id: runId,
      project_id: item.project_id,
      paper_id: item.paper_id,
      evidence_id: item.evidence_id,
      evidence_type: item.type,
      locator: item.locator,
      quantity_hint: hint,
      quantity_normalized: normalizedQuantity,
      value: m.value,
      uncertainty: m.uncertainty,
      asymmetric: m.asymmetric,
      uncertainty_stat: m.uncertainty_stat,
      uncertainty_syst: m.uncertainty_syst,
      unit_raw: unitRaw,
      unit: unitFinal ?? undefined,
      unit_category: unitCategory ?? undefined,
      is_percentage: m.is_percentage,
      raw_match: m.raw_match,
      source_text_preview: item.text.slice(0, 240),
    };

    out.write(`${JSON.stringify(rec)}\n`);
    measurementsWritten += 1;
  };

  try {
    const input = fs.createReadStream(inPath, { encoding: 'utf-8' });
    let buffer = '';

    await new Promise<void>((resolve, reject) => {
      input.on('error', reject);
      input.on('data', chunk => {
        buffer += chunk;
        while (true) {
          const idx = buffer.indexOf('\n');
          if (idx === -1) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const trimmed = line.trim();
          if (!trimmed) continue;

          let item: EvidenceCatalogItemV1Like | null = null;
          try {
            item = JSON.parse(trimmed) as EvidenceCatalogItemV1Like;
          } catch {
            warnings.push('invalid_jsonl_line');
            continue;
          }

          if (!item || typeof item.text !== 'string' || typeof item.evidence_id !== 'string') continue;
          if (!includeTypes.includes(item.type)) continue;

          evidenceItemsScanned += 1;
          const ms = extractMeasurementsFromText(item.text);
          for (const m of ms) {
            pushMeasurement(item, m);
          }
        }
      });
      input.on('end', () => resolve());
    });

    if (buffer.trim()) {
      try {
        const item = JSON.parse(buffer) as EvidenceCatalogItemV1Like;
        if (item && typeof item.text === 'string' && includeTypes.includes(item.type)) {
          evidenceItemsScanned += 1;
          for (const m of extractMeasurementsFromText(item.text)) pushMeasurement(item, m);
        }
      } catch {
        // ignore trailing partial
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      out.destroy();
    } catch {
      // ignore
    }
    try {
      await completeRunStep({
        runId,
        stepIndex,
        stepStart: step,
        status: 'failed',
        artifacts,
        notes: message,
      });
    } catch {
      // ignore
    }
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });

  if (truncated) {
    const msg = `Measurements truncated at max_results=${maxResults}.`;
    warnings.push(msg);
    budget.recordHit({
      key: 'hep.measurements.max_results',
      dimension: 'breadth',
      unit: 'items',
      limit: maxResults,
      observed: measurementsFound,
      action: 'truncate',
      message: msg,
      data: { measurements_found: measurementsFound, measurements_written: measurementsWritten },
    });
  }

  if (unknownUnit > 0) {
    const msg =
      `Unknown units for ${unknownUnit} measurements (examples: ${unknownUnitExamples.slice(0, maxWarningExamples).join(' | ')}).`;
    warnings.push(msg);
    budget.warn({ severity: 'warning', code: 'unknown_unit', message: msg });
  }

  const measurementsUri = makeHepRunArtifactUri(runId, measurementsName);
  const measurementsRef: RunArtifactRef = createHepRunArtifactRef(runId, measurementsName, 'application/x-ndjson');
  artifacts.push(measurementsRef);

  const diag = writeRunStepDiagnosticsArtifact({
    run_id: runId,
    project_id: run.project_id,
    step: step.step,
    step_index: stepIndex,
    ...budget.snapshot(),
  });
  artifacts.push(diag.run, diag.project);

  const metaPayload: HepMeasurementsMetaV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    source: {
      latex_catalog_artifact_name: params.latex_catalog_artifact_name,
      include_types: includeTypes,
    },
    budgets: {
      max_results: maxResults,
    },
    stats: {
      evidence_items_scanned: evidenceItemsScanned,
      measurements_found: measurementsFound,
      measurements_written: measurementsWritten,
      unknown_unit: unknownUnit,
    },
    by_quantity: Object.fromEntries(Array.from(byQuantity.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    by_unit: Object.fromEntries(Array.from(byUnit.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
    warnings,
    artifacts: {
      measurements_uri: measurementsUri,
      meta_uri: makeHepRunArtifactUri(runId, metaName),
      diagnostics_uri: diag.run.uri,
    },
  };

  const metaRef = writeRunJsonArtifact(runId, metaName, metaPayload);
  artifacts.push(metaRef);

  artifacts.sort((a, b) => a.name.localeCompare(b.name));

  await completeRunStep({
    runId,
    stepIndex,
    stepStart: step,
    status: 'done',
    artifacts,
  });

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: makeHepRunManifestUri(runId),
    artifacts,
    measurements_uri: measurementsUri,
    meta_uri: metaRef.uri,
    summary: {
      evidence_items_scanned: evidenceItemsScanned,
      measurements_found: measurementsFound,
      measurements_written: measurementsWritten,
      warnings_total: warnings.length,
      warnings: warnings.slice(0, 20),
    },
  };
}
