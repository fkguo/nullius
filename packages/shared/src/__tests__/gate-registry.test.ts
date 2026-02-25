import { describe, it, expect } from 'vitest';
import {
  GATE_REGISTRY,
  getGateSpec,
  getRegisteredGateNames,
  validateGates,
  isRegisteredGate,
  GateValidationError,
  type GateType,
} from '../gate-registry.js';

describe('GATE_REGISTRY', () => {
  it('should have unique gate names', () => {
    const names = GATE_REGISTRY.map(g => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should have all gate names in snake_case', () => {
    for (const gate of GATE_REGISTRY) {
      expect(gate.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('should have valid gate types', () => {
    const validTypes: GateType[] = ['approval', 'quality', 'budget'];
    for (const gate of GATE_REGISTRY) {
      expect(validTypes).toContain(gate.type);
    }
  });

  it('should have valid required_risk_level', () => {
    const validLevels = ['read', 'write', 'destructive'];
    for (const gate of GATE_REGISTRY) {
      expect(validLevels).toContain(gate.required_risk_level);
    }
  });

  it('should contain expected approval gates', () => {
    const names = GATE_REGISTRY.map(g => g.name);
    expect(names).toContain('approval_run_start');
    expect(names).toContain('approval_paperset');
    expect(names).toContain('approval_outline');
    expect(names).toContain('approval_draft');
    expect(names).toContain('approval_export');
  });
});

describe('getGateSpec', () => {
  it('should return spec for registered gates', () => {
    const spec = getGateSpec('approval_run_start');
    expect(spec).toBeDefined();
    expect(spec!.type).toBe('approval');
  });

  it('should return undefined for unknown gates', () => {
    expect(getGateSpec('unknown_gate')).toBeUndefined();
  });
});

describe('getRegisteredGateNames', () => {
  it('should return all registered names', () => {
    const names = getRegisteredGateNames();
    expect(names.length).toBe(GATE_REGISTRY.length);
    expect(names).toContain('approval_run_start');
    expect(names).toContain('budget_token');
  });
});

describe('validateGates', () => {
  it('should pass for valid gates', () => {
    expect(() => validateGates(['approval_run_start', 'approval_outline'])).not.toThrow();
  });

  it('should pass for empty list', () => {
    expect(() => validateGates([])).not.toThrow();
  });

  it('should throw GateValidationError for unknown gates', () => {
    try {
      validateGates(['approval_run_start', 'A6', 'mystery']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GateValidationError);
      expect((err as GateValidationError).invalidGates).toEqual(['A6', 'mystery']);
    }
  });
});

describe('isRegisteredGate', () => {
  it('should return true for registered gates', () => {
    expect(isRegisteredGate('approval_run_start')).toBe(true);
    expect(isRegisteredGate('quality_compile')).toBe(true);
  });

  it('should return false for unregistered gates', () => {
    expect(isRegisteredGate('A6')).toBe(false);
    expect(isRegisteredGate('')).toBe(false);
  });
});
