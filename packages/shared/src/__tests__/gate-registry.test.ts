import { describe, expect, it } from 'vitest';
import {
  APPROVAL_GATE_IDS,
  APPROVAL_GATE_TO_POLICY_KEY,
  APPROVAL_REQUIRED_DEFAULTS,
  GATE_REGISTRY,
  GateValidationError,
  getApprovalGateSpecs,
  getApprovalPolicyKey,
  getGateSpec,
  getRegisteredGateNames,
  isApprovalGateId,
  isRegisteredGate,
  type GateType,
  validateGates,
} from '../gate-registry.js';

describe('GATE_REGISTRY', () => {
  it('should have unique gate ids', () => {
    const gateIds = GATE_REGISTRY.map((gate) => gate.gate_id);
    expect(new Set(gateIds).size).toBe(gateIds.length);
  });

  it('should use stable gate id formats', () => {
    for (const gate of GATE_REGISTRY) {
      expect(gate.gate_id).toMatch(/^(?:A[1-5]|[a-z][a-z0-9_]*)$/);
    }
  });

  it('should have valid gate types', () => {
    const validTypes: GateType[] = ['approval', 'quality', 'convergence'];
    for (const gate of GATE_REGISTRY) {
      expect(validTypes).toContain(gate.gate_type);
    }
  });

  it('should keep concrete registry entries fail-closed', () => {
    for (const gate of GATE_REGISTRY) {
      expect(gate.fail_behavior).toBe('fail-closed');
    }
  });

  it('should require audit trails for every registered gate', () => {
    for (const gate of GATE_REGISTRY) {
      expect(gate.audit_required).toBe(true);
      expect(typeof gate.policy).toBe('object');
    }
  });

  it('should contain expected approval and convergence gates', () => {
    const gateIds = GATE_REGISTRY.map((gate) => gate.gate_id);
    expect(gateIds).toContain('A1');
    expect(gateIds).toContain('A2');
    expect(gateIds).toContain('A3');
    expect(gateIds).toContain('A4');
    expect(gateIds).toContain('A5');
    expect(gateIds).toContain('team_convergence');
    expect(gateIds).toContain('draft_convergence');
  });

  it('should derive approval ids and policy keys from shared GateSpec without A0', () => {
    expect(APPROVAL_GATE_IDS).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    expect(APPROVAL_GATE_IDS).not.toContain('A0');
    expect(APPROVAL_GATE_TO_POLICY_KEY).toEqual({
      A1: 'mass_search',
      A2: 'code_changes',
      A3: 'compute_runs',
      A4: 'paper_edits',
      A5: 'final_conclusions',
    });
    expect(APPROVAL_REQUIRED_DEFAULTS).toEqual({
      mass_search: true,
      code_changes: true,
      compute_runs: true,
      paper_edits: true,
      final_conclusions: true,
    });
  });

  it('should keep approval gate scope aligned with policy.approval_category', () => {
    for (const gate of getApprovalGateSpecs()) {
      expect(gate.policy.approval_category).toBe(gate.scope);
    }
  });
});

describe('getGateSpec', () => {
  it('should return spec for registered gates', () => {
    const spec = getGateSpec('A1');
    expect(spec).toBeDefined();
    expect(spec!.gate_type).toBe('approval');
    expect(spec!.scope).toBe('mass_search');
  });

  it('should return undefined for unknown gates', () => {
    expect(getGateSpec('unknown_gate')).toBeUndefined();
  });
});

describe('getRegisteredGateNames', () => {
  it('should return all registered gate ids', () => {
    const gateIds = getRegisteredGateNames();
    expect(gateIds.length).toBe(GATE_REGISTRY.length);
    expect(gateIds).toContain('A1');
    expect(gateIds).toContain('team_convergence');
  });
});

describe('validateGates', () => {
  it('should pass for valid gates', () => {
    expect(() => validateGates(['A1', 'quality_compile'])).not.toThrow();
  });

  it('should pass for empty list', () => {
    expect(() => validateGates([])).not.toThrow();
  });

  it('should throw GateValidationError for unknown gates', () => {
    try {
      validateGates(['A1', 'A6', 'mystery']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GateValidationError);
      expect((err as GateValidationError).invalidGates).toEqual(['A6', 'mystery']);
    }
  });
});

describe('isRegisteredGate', () => {
  it('should return true for registered gates', () => {
    expect(isRegisteredGate('A1')).toBe(true);
    expect(isRegisteredGate('quality_compile')).toBe(true);
    expect(isRegisteredGate('team_convergence')).toBe(true);
  });

  it('should return false for unregistered gates', () => {
    expect(isRegisteredGate('A6')).toBe(false);
    expect(isRegisteredGate('')).toBe(false);
  });
});

describe('approval gate helpers', () => {
  it('should expose approval gate ids as a dedicated type guard', () => {
    expect(isApprovalGateId('A1')).toBe(true);
    expect(isApprovalGateId('A0')).toBe(false);
  });

  it('should return policy keys only for registered approval gates', () => {
    expect(getApprovalPolicyKey('A3')).toBe('compute_runs');
    expect(getApprovalPolicyKey('A0')).toBeUndefined();
    expect(getApprovalPolicyKey('quality_compile')).toBeUndefined();
  });
});
