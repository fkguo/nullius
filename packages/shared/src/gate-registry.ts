/**
 * Generic Gate Registry (H-04, M-22).
 *
 * Gates are provider-neutral authority checkpoints used by approval,
 * quality, and convergence flows. Approval checkpoints are one gate type,
 * not the entire abstraction.
 */

export type GateType = 'approval' | 'quality' | 'convergence';
export type GateFailBehavior = 'fail-open' | 'fail-closed';
export type GatePolicy = Readonly<Record<string, unknown>>;

export interface GateSpec {
  gate_id: string;
  gate_type: GateType;
  scope: string;
  policy: GatePolicy;
  fail_behavior: GateFailBehavior;
  audit_required: boolean;
}

export const GATE_REGISTRY: readonly GateSpec[] = [
  {
    gate_id: 'A1',
    gate_type: 'approval',
    scope: 'mass_search',
    policy: { approval_category: 'mass_search' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'A2',
    gate_type: 'approval',
    scope: 'code_changes',
    policy: { approval_category: 'code_changes' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'A3',
    gate_type: 'approval',
    scope: 'compute_runs',
    policy: { approval_category: 'compute_runs' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'A4',
    gate_type: 'approval',
    scope: 'paper_edits',
    policy: { approval_category: 'paper_edits' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'A5',
    gate_type: 'approval',
    scope: 'final_conclusions',
    policy: { approval_category: 'final_conclusions' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'quality_compile',
    gate_type: 'quality',
    scope: 'paper_compile',
    policy: { check: 'latex_compile' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'quality_originality',
    gate_type: 'quality',
    scope: 'evidence_grounding',
    policy: { check: 'originality' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'team_convergence',
    gate_type: 'convergence',
    scope: 'research_team',
    policy: { result_schema: 'convergence_gate_result_v1' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
  {
    gate_id: 'draft_convergence',
    gate_type: 'convergence',
    scope: 'draft_review',
    policy: { result_schema: 'convergence_gate_result_v1' },
    fail_behavior: 'fail-closed',
    audit_required: true,
  },
] as const;

const GATE_BY_ID = new Map<string, GateSpec>(
  GATE_REGISTRY.map((gate) => [gate.gate_id, gate]),
);

if (GATE_BY_ID.size !== GATE_REGISTRY.length) {
  const gateIds = GATE_REGISTRY.map((gate) => gate.gate_id);
  const duplicates = gateIds.filter((gateId, index) => gateIds.indexOf(gateId) !== index);
  throw new Error(`GATE_REGISTRY has duplicate gate ids: ${duplicates.join(', ')}`);
}

export function getGateSpec(gateId: string): GateSpec | undefined {
  return GATE_BY_ID.get(gateId);
}

export function getRegisteredGateNames(): string[] {
  return [...GATE_BY_ID.keys()];
}

export class GateValidationError extends Error {
  constructor(public readonly invalidGates: string[]) {
    super(`Unknown gate(s): ${invalidGates.join(', ')}. Registered: ${[...GATE_BY_ID.keys()].join(', ')}`);
    this.name = 'GateValidationError';
  }
}

export function validateGates(gates: string[]): void {
  const invalid = gates.filter((gateId) => !GATE_BY_ID.has(gateId));
  if (invalid.length > 0) {
    throw new GateValidationError(invalid);
  }
}

export function isRegisteredGate(gateId: string): boolean {
  return GATE_BY_ID.has(gateId);
}
