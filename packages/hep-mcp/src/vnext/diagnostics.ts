import * as fs from 'fs';

import type { RunArtifactRef } from './runs.js';
import { getProjectArtifactPath, getRunArtifactPath } from './paths.js';

export type BudgetDimensionV1 = 'breadth' | 'depth' | 'budget';
export type BudgetSourceKindV1 = 'tool_args' | 'env' | 'default';
export type WarningSeverityV1 = 'info' | 'warning' | 'error';

export interface HepWarningV1 {
  version: 1;
  created_at: string;
  severity: WarningSeverityV1;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface BudgetSourceV1 {
  kind: BudgetSourceKindV1;
  arg_path?: string;
  env_var?: string;
  default_value?: number;
  raw_value?: unknown;
}

export interface BudgetEntryV1 {
  key: string;
  dimension: BudgetDimensionV1;
  value: number;
  unit?: string;
  source: BudgetSourceV1;
}

export type BudgetHitActionV1 = 'truncate' | 'cap' | 'skip' | 'clamp';

export interface BudgetHitV1 {
  key: string;
  dimension: BudgetDimensionV1;
  unit?: string;
  limit: number;
  observed: number;
  action: BudgetHitActionV1;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunStepDiagnosticsArtifactV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  step: string;
  step_index: number;
  budgets: BudgetEntryV1[];
  hits: BudgetHitV1[];
  warnings: HepWarningV1[];
  artifacts: {
    run_diagnostics_uri: string;
    project_diagnostics_uri: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export class BudgetTrackerV1 {
  private budgetsByKey = new Map<string, BudgetEntryV1>();
  private hits: BudgetHitV1[] = [];
  private warnings: HepWarningV1[] = [];

  resolveInt(params: {
    key: string;
    dimension: BudgetDimensionV1;
    unit?: string;
    arg_path?: string;
    tool_value?: unknown;
    tool_value_present?: boolean;
    env_var?: string;
    default_value: number;
    min?: number;
    max?: number;
  }): number {
    const min = params.min ?? 0;
    const max = params.max ?? Number.POSITIVE_INFINITY;

    const toolValuePresent = params.tool_value_present ?? params.tool_value !== undefined;
    const fromTool = toolValuePresent ? toFiniteInt(params.tool_value) : null;
    const fromEnv = (() => {
      const envVar = params.env_var;
      if (!envVar) return null;
      return toFiniteInt(process.env[envVar]);
    })();

    let value: number;
    let source: BudgetSourceV1;

    if (fromTool !== null) {
      value = fromTool;
      source = {
        kind: 'tool_args',
        arg_path: params.arg_path,
        raw_value: toolValuePresent ? params.tool_value : undefined,
      };
    } else if (fromEnv !== null) {
      value = fromEnv;
      source = {
        kind: 'env',
        env_var: params.env_var,
        raw_value: params.env_var ? process.env[params.env_var] : undefined,
      };
    } else {
      value = Math.trunc(params.default_value);
      source = {
        kind: 'default',
        default_value: params.default_value,
      };
    }

    if (!Number.isFinite(value)) value = Math.trunc(params.default_value);
    value = Math.max(min, Math.min(max, value));

    if (!this.budgetsByKey.has(params.key)) {
      this.budgetsByKey.set(params.key, {
        key: params.key,
        dimension: params.dimension,
        value,
        unit: params.unit,
        source,
      });
    }

    return value;
  }

  recordHit(params: BudgetHitV1): void {
    this.hits.push(params);
    this.warnings.push({
      version: 1,
      created_at: nowIso(),
      severity: 'warning',
      code: 'budget_hit',
      message: params.message,
      data: {
        key: params.key,
        dimension: params.dimension,
        unit: params.unit,
        limit: params.limit,
        observed: params.observed,
        action: params.action,
        ...(params.data ?? {}),
      },
    });
  }

  warn(params: Omit<HepWarningV1, 'version' | 'created_at'> & { data?: Record<string, unknown> }): void {
    this.warnings.push({
      version: 1,
      created_at: nowIso(),
      severity: params.severity,
      code: params.code,
      message: params.message,
      data: params.data,
    });
  }

  snapshot(): { budgets: BudgetEntryV1[]; hits: BudgetHitV1[]; warnings: HepWarningV1[] } {
    const budgets = Array.from(this.budgetsByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
    const hits = [...this.hits];
    const warnings = [...this.warnings];
    return { budgets, hits, warnings };
  }
}

export function writeRunStepDiagnosticsArtifact(params: {
  run_id: string;
  project_id: string;
  step: string;
  step_index: number;
  budgets: BudgetEntryV1[];
  hits: BudgetHitV1[];
  warnings: HepWarningV1[];
}): { run: RunArtifactRef; project: RunArtifactRef; payload: RunStepDiagnosticsArtifactV1 } {
  const suffix = `step_${pad3(params.step_index + 1)}_${params.step}_diagnostics.json`;
  const runArtifactName = suffix;
  const projectArtifactName = `run_${params.run_id}_${suffix}`;

  const runUri = `hep://runs/${encodeURIComponent(params.run_id)}/artifact/${encodeURIComponent(runArtifactName)}`;
  const projectUri = `hep://projects/${encodeURIComponent(params.project_id)}/artifact/${encodeURIComponent(projectArtifactName)}`;

  const payload: RunStepDiagnosticsArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: params.run_id,
    project_id: params.project_id,
    step: params.step,
    step_index: params.step_index,
    budgets: params.budgets,
    hits: params.hits,
    warnings: params.warnings,
    artifacts: {
      run_diagnostics_uri: runUri,
      project_diagnostics_uri: projectUri,
    },
  };

  fs.writeFileSync(getRunArtifactPath(params.run_id, runArtifactName), JSON.stringify(payload, null, 2), 'utf-8');
  fs.writeFileSync(getProjectArtifactPath(params.project_id, projectArtifactName), JSON.stringify(payload, null, 2), 'utf-8');

  return {
    run: { name: runArtifactName, uri: runUri, mimeType: 'application/json' },
    project: { name: projectArtifactName, uri: projectUri, mimeType: 'application/json' },
    payload,
  };
}

export interface ProjectDiagnosticsArtifactV1 {
  version: 1;
  generated_at: string;
  project_id: string;
  operation: string;
  budgets: BudgetEntryV1[];
  hits: BudgetHitV1[];
  warnings: HepWarningV1[];
  artifacts: {
    project_diagnostics_uri: string;
  };
  meta?: Record<string, unknown>;
}

export function writeProjectDiagnosticsArtifact(params: {
  project_id: string;
  operation: string;
  artifact_name: string;
  budgets: BudgetEntryV1[];
  hits: BudgetHitV1[];
  warnings: HepWarningV1[];
  meta?: Record<string, unknown>;
}): { project: RunArtifactRef; payload: ProjectDiagnosticsArtifactV1 } {
  const projectUri =
    `hep://projects/${encodeURIComponent(params.project_id)}/artifact/${encodeURIComponent(params.artifact_name)}`;

  const payload: ProjectDiagnosticsArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    project_id: params.project_id,
    operation: params.operation,
    budgets: params.budgets,
    hits: params.hits,
    warnings: params.warnings,
    artifacts: { project_diagnostics_uri: projectUri },
    meta: params.meta,
  };

  fs.writeFileSync(getProjectArtifactPath(params.project_id, params.artifact_name), JSON.stringify(payload, null, 2), 'utf-8');
  return {
    project: { name: params.artifact_name, uri: projectUri, mimeType: 'application/json' },
    payload,
  };
}
