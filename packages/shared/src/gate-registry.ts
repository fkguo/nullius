/**
 * Gate Registry — Approval checkpoint abstraction (H-04).
 *
 * Gates are named checkpoints in automated workflows where human approval,
 * quality checks, or budget limits may block progression.
 * This module defines the schema and static registry; execution logic is Phase 2 (H-11b).
 */

import type { ToolRiskLevel } from './tool-risk.js';

// ── Gate Types ───────────────────────────────────────────────────────────────

/**
 * Categories of gates:
 * - approval:  Requires human sign-off before proceeding
 * - quality:   Automated quality check (e.g., compile, test, originality)
 * - budget:    Token/cost budget limit enforcement
 */
export type GateType = 'approval' | 'quality' | 'budget';

// ── GateSpec ─────────────────────────────────────────────────────────────────

export interface GateSpec {
  /** Unique gate name (snake_case, must be unique in the registry) */
  name: string;
  /** Gate category */
  type: GateType;
  /** Human-readable description of what this gate checks/approves */
  description: string;
  /** Minimum tool risk level that triggers this gate (relates to H-11a) */
  required_risk_level: ToolRiskLevel;
}

// ── Built-in Gate Registry ───────────────────────────────────────────────────

/**
 * Static gate registry. All gate names must be unique.
 * Convention: gate names use snake_case, prefixed by domain.
 *
 * Current gates (from REDESIGN_PLAN):
 * - A1..A5: Approval gates for the research workflow
 */
export const GATE_REGISTRY: readonly GateSpec[] = [
  {
    name: 'approval_run_start',
    type: 'approval',
    description: 'Human approval required before starting a run',
    required_risk_level: 'write',
  },
  {
    name: 'approval_paperset',
    type: 'approval',
    description: 'Human approval of curated paper set before outline generation',
    required_risk_level: 'write',
  },
  {
    name: 'approval_outline',
    type: 'approval',
    description: 'Human approval of outline before section writing begins',
    required_risk_level: 'write',
  },
  {
    name: 'approval_draft',
    type: 'approval',
    description: 'Human approval of draft before export/publish',
    required_risk_level: 'write',
  },
  {
    name: 'approval_export',
    type: 'approval',
    description: 'Human approval before destructive export operations',
    required_risk_level: 'destructive',
  },
  {
    name: 'quality_compile',
    type: 'quality',
    description: 'LaTeX compilation must succeed',
    required_risk_level: 'write',
  },
  {
    name: 'quality_originality',
    type: 'quality',
    description: 'Originality check must pass (no ungrounded claims)',
    required_risk_level: 'write',
  },
  {
    name: 'budget_token',
    type: 'budget',
    description: 'Token budget must not be exceeded for the current step',
    required_risk_level: 'read',
  },
] as const;

// ── Lookup & Validation ──────────────────────────────────────────────────────

const GATE_BY_NAME = new Map<string, GateSpec>(
  GATE_REGISTRY.map(g => [g.name, g])
);

// Module-load uniqueness check: if any duplicate name exists, the Map
// constructor silently overwrites. We detect this at module load.
if (GATE_BY_NAME.size !== GATE_REGISTRY.length) {
  const names = GATE_REGISTRY.map(g => g.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  throw new Error(`GATE_REGISTRY has duplicate gate names: ${dupes.join(', ')}`);
}

/** Get a gate spec by name, or undefined if not registered. */
export function getGateSpec(name: string): GateSpec | undefined {
  return GATE_BY_NAME.get(name);
}

/** Get all registered gate names. */
export function getRegisteredGateNames(): string[] {
  return [...GATE_BY_NAME.keys()];
}

export class GateValidationError extends Error {
  constructor(public readonly invalidGates: string[]) {
    super(`Unknown gate(s): ${invalidGates.join(', ')}. Registered: ${[...GATE_BY_NAME.keys()].join(', ')}`);
    this.name = 'GateValidationError';
  }
}

/**
 * Validate that all gate names in the list are registered.
 * @throws GateValidationError if any gate name is unknown.
 */
export function validateGates(gates: string[]): void {
  const invalid = gates.filter(g => !GATE_BY_NAME.has(g));
  if (invalid.length > 0) {
    throw new GateValidationError(invalid);
  }
}

/** Check if a gate name is registered (non-throwing). */
export function isRegisteredGate(name: string): boolean {
  return GATE_BY_NAME.has(name);
}
