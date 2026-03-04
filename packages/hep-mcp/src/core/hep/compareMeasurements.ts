import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  HEP_RUN_BUILD_MEASUREMENTS,
  HEP_PROJECT_QUERY_EVIDENCE,
  invalidParams,
} from '@autoresearch/shared';

import type { RunArtifactRef } from '../runs.js';
import { getRun } from '../runs.js';
import { getRunArtifactPath, getRunArtifactsDir } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { BudgetTrackerV1, writeRunStepDiagnosticsArtifact } from '../diagnostics.js';
import { startRunStep, completeRunStep } from '../zotero/runSteps.js';
import { canonicalizeUnit } from '../../tools/research/config.js';

interface CompareInputRun {
  run_id: string;
  measurements_artifact_name?: string;
  label?: string;
}

interface CompareMeasurementEndpoint {
  run_id: string;
  project_id: string;
  paper_id: string;
  measurement_id: string;
  evidence_id: string;
  quantity_hint: string;
  quantity_normalized: string;
  value: number;
  uncertainty?: number;
  unit?: string;
  is_percentage: boolean;
  raw_match?: string;
  source_text_preview?: string;
  source: {
    label: string;
    artifact_name: string;
  };
}

interface CompareMeasurementFlag {
  flag_id: string;
  reason: 'pairwise_tension';
  quantity_normalized: string;
  unit: string;
  z_score: number;
  abs_delta: number;
  sigma_combined: number;
  interpretation: 'moderate_tension' | 'strong_tension' | 'very_strong_tension';
  lhs: CompareMeasurementEndpoint;
  rhs: CompareMeasurementEndpoint;
}

interface NotComparablePair {
  quantity_normalized: string;
  reason: 'unit_mismatch' | 'missing_unit' | 'missing_uncertainty' | 'non_positive_combined_sigma' | 'duplicate_source';
  lhs: CompareMeasurementEndpoint;
  rhs: CompareMeasurementEndpoint;
}

interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

interface MeasurementArtifactRow {
  measurement_id?: unknown;
  run_id?: unknown;
  project_id?: unknown;
  paper_id?: unknown;
  evidence_id?: unknown;
  quantity_hint?: unknown;
  quantity_normalized?: unknown;
  value?: unknown;
  uncertainty?: unknown;
  uncertainty_stat?: unknown;
  uncertainty_syst?: unknown;
  unit?: unknown;
  unit_raw?: unknown;
  is_percentage?: unknown;
  raw_match?: unknown;
  source_text_preview?: unknown;
}

interface ResolvedInputRun {
  run_id: string;
  project_id: string;
  artifact_name: string;
  label: string;
  measurements: CompareMeasurementEndpoint[];
  invalid_rows: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeQuantity(rawQuantity: unknown, rawHint: unknown): string | null {
  const q = typeof rawQuantity === 'string' ? rawQuantity.trim() : '';
  const hint = typeof rawHint === 'string' ? rawHint.trim() : '';
  const candidate = (q || hint).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!candidate || candidate === 'unknown') return null;
  return candidate;
}

function normalizeUnit(row: MeasurementArtifactRow): string | null {
  const isPercentage = Boolean(row.is_percentage);
  if (isPercentage) return '%';

  const fromUnit = typeof row.unit === 'string' ? row.unit.trim() : '';
  const fromUnitRaw = typeof row.unit_raw === 'string' ? row.unit_raw.trim() : '';
  const raw = fromUnit || fromUnitRaw;
  if (!raw) return null;
  const canonical = canonicalizeUnit(raw);
  const normalized = (canonical ?? raw).replace(/\s+/g, '');
  return normalized || null;
}

function measurementSigma(row: MeasurementArtifactRow): number | null {
  const direct = asFiniteNumber(row.uncertainty);
  if (direct !== null && direct > 0) return direct;

  const stat = asFiniteNumber(row.uncertainty_stat);
  const syst = asFiniteNumber(row.uncertainty_syst);
  const statPositive = stat !== null && stat > 0;
  const systPositive = syst !== null && syst > 0;

  if (statPositive && systPositive) return Math.hypot(stat!, syst!);
  if (statPositive) return stat!;
  if (systPositive) return syst!;
  return null;
}

function inferInterpretation(zScore: number): CompareMeasurementFlag['interpretation'] {
  if (zScore >= 5) return 'very_strong_tension';
  if (zScore >= 3) return 'strong_tension';
  return 'moderate_tension';
}

function missingMeasurementsArtifactError(params: {
  run_id: string;
  project_id: string;
  explicit_artifact_name?: string;
  available_artifacts?: string[];
}): Error {
  const explicit = params.explicit_artifact_name;
  const message = explicit
    ? `measurements_artifact_name not found in run artifacts: ${explicit}`
    : 'No measurements artifact found in source run artifacts';

  return invalidParams(message, {
    run_id: params.run_id,
    project_id: params.project_id,
    measurements_artifact_name: explicit,
    available_artifacts: params.available_artifacts,
    expected_pattern: 'hep_measurements_*.jsonl',
    next_actions: [
      {
        tool: HEP_RUN_BUILD_MEASUREMENTS,
        args: { run_id: params.run_id },
        reason: 'Build run-level measurements artifact before cross-run comparison.',
      },
    ],
  });
}

function resolveMeasurementsArtifactName(params: {
  run_id: string;
  project_id: string;
  explicit?: string;
}): string {
  if (params.explicit) {
    const explicitPath = getRunArtifactPath(params.run_id, params.explicit);
    if (!fs.existsSync(explicitPath)) {
      throw missingMeasurementsArtifactError({
        run_id: params.run_id,
        project_id: params.project_id,
        explicit_artifact_name: params.explicit,
      });
    }
    return params.explicit;
  }

  const artifactsDir = getRunArtifactsDir(params.run_id);
  const names = fs.readdirSync(artifactsDir)
    .filter(name => /^hep_measurements_.*\.jsonl$/.test(name));

  if (names.length === 0) {
    throw missingMeasurementsArtifactError({
      run_id: params.run_id,
      project_id: params.project_id,
      available_artifacts: [],
    });
  }

  const byMtimeDesc = names
    .map(name => ({ name, mtimeMs: fs.statSync(getRunArtifactPath(params.run_id, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));

  return byMtimeDesc[0]!.name;
}

function loadMeasurements(params: {
  run_id: string;
  project_id: string;
  label: string;
  artifact_name: string;
}): { measurements: CompareMeasurementEndpoint[]; invalid_rows: number } {
  const inPath = getRunArtifactPath(params.run_id, params.artifact_name);
  const lines = fs.readFileSync(inPath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean);

  const measurements: CompareMeasurementEndpoint[] = [];
  let invalidRows = 0;

  for (const line of lines) {
    let row: MeasurementArtifactRow;
    try {
      row = JSON.parse(line) as MeasurementArtifactRow;
    } catch {
      invalidRows += 1;
      continue;
    }

    const measurementId = typeof row.measurement_id === 'string' ? row.measurement_id : '';
    const paperId = typeof row.paper_id === 'string' ? row.paper_id : '';
    const evidenceId = typeof row.evidence_id === 'string' ? row.evidence_id : '';
    const value = asFiniteNumber(row.value);

    if (!measurementId || !paperId || !evidenceId || value === null) {
      invalidRows += 1;
      continue;
    }

    const quantityNormalized = normalizeQuantity(row.quantity_normalized, row.quantity_hint);
    if (!quantityNormalized) continue;

    const quantityHint = typeof row.quantity_hint === 'string' ? row.quantity_hint : quantityNormalized;
    const sigma = measurementSigma(row);
    const unit = normalizeUnit(row);
    const isPercentage = Boolean(row.is_percentage);

    measurements.push({
      run_id: params.run_id,
      project_id: params.project_id,
      paper_id: paperId,
      measurement_id: measurementId,
      evidence_id: evidenceId,
      quantity_hint: quantityHint,
      quantity_normalized: quantityNormalized,
      value,
      uncertainty: sigma ?? undefined,
      unit: unit ?? undefined,
      is_percentage: isPercentage,
      raw_match: typeof row.raw_match === 'string' ? row.raw_match : undefined,
      source_text_preview: typeof row.source_text_preview === 'string' ? row.source_text_preview : undefined,
      source: {
        label: params.label,
        artifact_name: params.artifact_name,
      },
    });
  }

  return { measurements, invalid_rows: invalidRows };
}

function makeArtifactName(params: {
  output_run_id: string;
  inputs: Array<{ run_id: string; artifact_name: string }>;
  min_tension_sigma: number;
}): string {
  const material = JSON.stringify({
    output_run_id: params.output_run_id,
    inputs: params.inputs,
    min_tension_sigma: params.min_tension_sigma,
  });
  return `hep_compare_measurements_${sha256Hex(material).slice(0, 16)}.json`;
}

function buildNextActions(params: {
  flags: CompareMeasurementFlag[];
  notComparablePairs: number;
  reasonCounts: Map<string, number>;
  inputRunIds: string[];
  projectId: string;
}): NextAction[] {
  const actions: NextAction[] = [];
  const suggestedReExtractRunIds = new Set<string>();

  if (params.flags.length > 0) {
    const topQuantities = [...new Set(params.flags.slice(0, 5).map(f => f.quantity_normalized))];
    actions.push({
      tool: HEP_PROJECT_QUERY_EVIDENCE,
      args: {
        project_id: params.projectId,
        query: topQuantities.join(' '),
        mode: 'lexical',
        limit: 10,
      },
      reason: `Review source evidence for ${params.flags.length} flagged tension(s). Top quantities: ${topQuantities.join(', ')}.`,
    });

    const strongFlags = params.flags.filter(f => f.interpretation === 'strong_tension' || f.interpretation === 'very_strong_tension');
    if (strongFlags.length > 0) {
      const affectedRunIds = [...new Set(strongFlags.flatMap(f => [f.lhs.run_id, f.rhs.run_id]))];
      for (const rid of affectedRunIds) {
        suggestedReExtractRunIds.add(rid);
        actions.push({
          tool: HEP_RUN_BUILD_MEASUREMENTS,
          args: { run_id: rid },
          reason: `Re-extract measurements for run ${rid} to check systematic uncertainties for ${strongFlags.length} strong/very-strong tension(s).`,
        });
      }
    }
  }

  const missingUncertainty = params.reasonCounts.get('missing_uncertainty') ?? 0;
  if (missingUncertainty > 0) {
    for (const rid of params.inputRunIds) {
      if (suggestedReExtractRunIds.has(rid)) continue;
      actions.push({
        tool: HEP_RUN_BUILD_MEASUREMENTS,
        args: { run_id: rid },
        reason: `${missingUncertainty} pair(s) skipped due to missing uncertainty. Re-extract with improved extraction to enable comparison.`,
      });
    }
  }

  return actions;
}

export async function compareProjectMeasurements(params: {
  run_id: string;
  input_runs: CompareInputRun[];
  min_tension_sigma: number;
  max_flags: number;
  include_not_comparable: boolean;
  output_artifact_name?: string;
  budget_hints?: {
    max_flags_provided?: boolean;
  };
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  compare_uri: string;
  summary: {
    input_runs: number;
    measurements_total: number;
    quantities_compared: number;
    pairwise_total: number;
    comparable_pairs: number;
    flagged_pairs: number;
    flagged_pairs_total: number;
    not_comparable_pairs: number;
    reason_counts: Record<string, number>;
    warnings_total: number;
    warnings: string[];
  };
  next_actions: NextAction[];
}> {
  const runId = params.run_id;
  const outputRun = getRun(runId);

  const { stepIndex, step } = await startRunStep(runId, 'hep_compare_measurements');
  const artifacts: RunArtifactRef[] = [];
  const warnings: string[] = [];
  const budget = new BudgetTrackerV1();

  const maxFlags = budget.resolveInt({
    key: 'hep.compare_measurements.max_flags',
    dimension: 'breadth',
    unit: 'pairs',
    arg_path: 'max_flags',
    tool_value: params.max_flags,
    tool_value_present: params.budget_hints?.max_flags_provided ?? true,
    default_value: 500,
    min: 1,
    max: 5000,
  });

  const uniqueInputRuns = Array.from(
    new Map(params.input_runs.map(item => [`${item.run_id}::${item.measurements_artifact_name ?? ''}::${item.label ?? ''}`, item])).values()
  );

  const resolvedInputs: ResolvedInputRun[] = [];
  let invalidRowsTotal = 0;

  try {
    for (const input of uniqueInputRuns) {
      const sourceRun = getRun(input.run_id);
      const artifactName = resolveMeasurementsArtifactName({
        run_id: input.run_id,
        project_id: sourceRun.project_id,
        explicit: input.measurements_artifact_name,
      });

      const sourceLabel = input.label?.trim() || `${sourceRun.project_id}/${input.run_id}`;
      const loaded = loadMeasurements({
        run_id: input.run_id,
        project_id: sourceRun.project_id,
        label: sourceLabel,
        artifact_name: artifactName,
      });

      invalidRowsTotal += loaded.invalid_rows;
      resolvedInputs.push({
        run_id: input.run_id,
        project_id: sourceRun.project_id,
        artifact_name: artifactName,
        label: sourceLabel,
        measurements: loaded.measurements,
        invalid_rows: loaded.invalid_rows,
      });
    }

    const allMeasurements = resolvedInputs.flatMap(item => item.measurements);
    const groups = new Map<string, CompareMeasurementEndpoint[]>();
    for (const row of allMeasurements) {
      const arr = groups.get(row.quantity_normalized) ?? [];
      arr.push(row);
      groups.set(row.quantity_normalized, arr);
    }

    const flagCandidates: CompareMeasurementFlag[] = [];
    const flags: CompareMeasurementFlag[] = [];
    const notComparable: NotComparablePair[] = [];
    const reasonCounts = new Map<string, number>();

    let pairwiseTotal = 0;
    let comparablePairs = 0;
    let notComparablePairs = 0;
    let flaggedCandidatesTotal = 0;
    let notComparableTruncated = false;

    const bumpReason = (reason: string): void => {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    };

    const pushNotComparable = (entry: NotComparablePair): void => {
      notComparablePairs += 1;
      bumpReason(entry.reason);
      if (!params.include_not_comparable) return;
      if (notComparable.length < 200) {
        notComparable.push(entry);
      } else {
        notComparableTruncated = true;
      }
    };

    for (const [quantity, rows] of groups.entries()) {
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          const lhs = rows[i]!;
          const rhs = rows[j]!;

          if (lhs.run_id === rhs.run_id) continue;

          pairwiseTotal += 1;

          if (lhs.paper_id === rhs.paper_id && lhs.measurement_id === rhs.measurement_id) {
            pushNotComparable({
              quantity_normalized: quantity,
              reason: 'duplicate_source',
              lhs,
              rhs,
            });
            continue;
          }

          if (!lhs.unit || !rhs.unit) {
            pushNotComparable({
              quantity_normalized: quantity,
              reason: 'missing_unit',
              lhs,
              rhs,
            });
            continue;
          }

          if (lhs.unit !== rhs.unit) {
            pushNotComparable({
              quantity_normalized: quantity,
              reason: 'unit_mismatch',
              lhs,
              rhs,
            });
            continue;
          }

          const lhsSigma = lhs.uncertainty;
          const rhsSigma = rhs.uncertainty;
          if (!(typeof lhsSigma === 'number' && lhsSigma > 0) || !(typeof rhsSigma === 'number' && rhsSigma > 0)) {
            pushNotComparable({
              quantity_normalized: quantity,
              reason: 'missing_uncertainty',
              lhs,
              rhs,
            });
            continue;
          }

          const sigmaCombined = Math.hypot(lhsSigma, rhsSigma);
          if (!(sigmaCombined > 0)) {
            pushNotComparable({
              quantity_normalized: quantity,
              reason: 'non_positive_combined_sigma',
              lhs,
              rhs,
            });
            continue;
          }

          comparablePairs += 1;
          const absDelta = Math.abs(lhs.value - rhs.value);
          const zScore = absDelta / sigmaCombined;

          if (zScore < params.min_tension_sigma) continue;

          const roundedZScore = Number(zScore.toFixed(6));
          const roundedDelta = Number(absDelta.toFixed(6));
          const roundedCombined = Number(sigmaCombined.toFixed(6));
          const flagId = `f_${sha256Hex(JSON.stringify({
            quantity,
            lhs: lhs.measurement_id,
            rhs: rhs.measurement_id,
            z: roundedZScore,
          })).slice(0, 16)}`;

          flagCandidates.push({
            flag_id: flagId,
            reason: 'pairwise_tension',
            quantity_normalized: quantity,
            unit: lhs.unit,
            z_score: roundedZScore,
            abs_delta: roundedDelta,
            sigma_combined: roundedCombined,
            interpretation: inferInterpretation(zScore),
            lhs,
            rhs,
          });
        }
      }
    }

    flaggedCandidatesTotal = flagCandidates.length;
    const sortedFlagCandidates = [...flagCandidates].sort((a, b) => {
      if (b.z_score !== a.z_score) return b.z_score - a.z_score;
      return a.flag_id.localeCompare(b.flag_id);
    });
    flags.push(...sortedFlagCandidates.slice(0, maxFlags));

    if (flaggedCandidatesTotal > maxFlags) {
      const message = `Flag list truncated at max_flags=${maxFlags}.`;
      warnings.push(message);
      budget.recordHit({
        key: 'hep.compare_measurements.max_flags',
        dimension: 'breadth',
        unit: 'pairs',
        limit: maxFlags,
        observed: flaggedCandidatesTotal,
        action: 'truncate',
        message,
        data: { flagged_candidates_total: flaggedCandidatesTotal, flagged_written: flags.length },
      });
    }

    if (notComparableTruncated) {
      const message = 'not_comparable list truncated at 200 entries.';
      warnings.push(message);
      budget.warn({ severity: 'info', code: 'not_comparable_truncated', message, data: { limit: 200, observed: notComparablePairs } });
    }

    if (invalidRowsTotal > 0) {
      const message = `Skipped ${invalidRowsTotal} malformed measurement rows across source artifacts.`;
      warnings.push(message);
      budget.warn({ severity: 'warning', code: 'invalid_measurement_rows', message, data: { invalid_rows_total: invalidRowsTotal } });
    }

    const artifactName = params.output_artifact_name ?? makeArtifactName({
      output_run_id: runId,
      inputs: resolvedInputs.map(item => ({ run_id: item.run_id, artifact_name: item.artifact_name })),
      min_tension_sigma: params.min_tension_sigma,
    });

    const nextActions = buildNextActions({
      flags,
      notComparablePairs,
      reasonCounts,
      inputRunIds: resolvedInputs.map(item => item.run_id),
      projectId: outputRun.project_id,
    });

    const compareRef = writeRunJsonArtifact(runId, artifactName, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      project_id: outputRun.project_id,
      policy: {
        flagging_only: true,
        min_tension_sigma: params.min_tension_sigma,
        max_flags: maxFlags,
        include_not_comparable: params.include_not_comparable,
        notes: [
          'This tool is a flagging mechanism, not a world-average combiner.',
          'Pairwise z-scores can miss correlated systematic effects; treat flags as review triggers.',
          'Quantity matching is lexical on quantity_normalized; semantically equivalent symbols may need manual harmonization.',
          'Duplicate-source guard uses paper_id + measurement_id; aliasing across extraction pipelines may require manual review.',
        ],
      },
      inputs: resolvedInputs.map(item => ({
        run_id: item.run_id,
        project_id: item.project_id,
        label: item.label,
        measurements_artifact_name: item.artifact_name,
        measurements_loaded: item.measurements.length,
        invalid_rows: item.invalid_rows,
      })),
      summary: {
        input_runs: resolvedInputs.length,
        measurements_total: allMeasurements.length,
        quantities_compared: groups.size,
        pairwise_total: pairwiseTotal,
        comparable_pairs: comparablePairs,
        flagged_pairs: flags.length,
        flagged_pairs_total: flaggedCandidatesTotal,
        not_comparable_pairs: notComparablePairs,
        reason_counts: Object.fromEntries(Array.from(reasonCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
        warnings_total: warnings.length,
        warnings: warnings.slice(0, 20),
      },
      flags,
      next_actions: nextActions,
      not_comparable: params.include_not_comparable ? notComparable : undefined,
    });
    artifacts.push(compareRef);

    const diag = writeRunStepDiagnosticsArtifact({
      run_id: runId,
      project_id: outputRun.project_id,
      step: step.step,
      step_index: stepIndex,
      ...budget.snapshot(),
    });
    artifacts.push(diag.run, diag.project);

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
      project_id: outputRun.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      compare_uri: compareRef.uri,
      summary: {
        input_runs: resolvedInputs.length,
        measurements_total: allMeasurements.length,
        quantities_compared: groups.size,
        pairwise_total: pairwiseTotal,
        comparable_pairs: comparablePairs,
        flagged_pairs: flags.length,
        flagged_pairs_total: flaggedCandidatesTotal,
        not_comparable_pairs: notComparablePairs,
        reason_counts: Object.fromEntries(Array.from(reasonCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))),
        warnings_total: warnings.length,
        warnings: warnings.slice(0, 20),
      },
      next_actions: nextActions,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'failed',
      artifacts,
      notes: message,
    });
    throw err;
  }
}
