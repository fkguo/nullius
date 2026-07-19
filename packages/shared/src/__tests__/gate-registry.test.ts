import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_GATE_IDS,
  APPROVAL_GATE_TO_POLICY_KEY,
  APPROVAL_REQUIRED_DEFAULTS,
  GATE_REGISTRY,
  GateValidationError,
  LAUNCH_AUTHORIZATION_CHECKS,
  LAUNCH_AUTHORIZATION_RESULT_SCHEMA,
  LAUNCH_AUTHORIZATION_VERDICTS,
  getApprovalGateSpecs,
  getApprovalPolicyKey,
  getGateSpec,
  getLaunchAuthorizationPolicy,
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
      compute_runs: false, // A3 is opt-in (default off); enable for unattended runs
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

describe('A3 launch authorization policy', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const readSchema = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(repoRoot, 'meta/schemas', name), 'utf8'));

  it('should carry the launch-authorization policy on A3 and only on A3', () => {
    const policy = getLaunchAuthorizationPolicy('A3');
    expect(policy).toBeDefined();
    expect(policy!.result_schema).toBe(LAUNCH_AUTHORIZATION_RESULT_SCHEMA);
    expect(policy!.required_checks).toEqual(LAUNCH_AUTHORIZATION_CHECKS);
    for (const gate of GATE_REGISTRY) {
      if (gate.gate_id !== 'A3') {
        expect(getLaunchAuthorizationPolicy(gate.gate_id)).toBeUndefined();
      }
    }
    expect(getLaunchAuthorizationPolicy('unknown_gate')).toBeUndefined();
  });

  it('should keep verdicts and checks aligned with launch_authorization_v1.schema.json', () => {
    const schema = readSchema('launch_authorization_v1.schema.json') as {
      properties: {
        verdict: { enum: string[] };
        checks: { items: { properties: { check_id: { enum: string[] } } } };
      };
    };
    expect(schema.properties.verdict.enum).toEqual([...LAUNCH_AUTHORIZATION_VERDICTS]);
    expect(schema.properties.checks.items.properties.check_id.enum).toEqual([
      ...LAUNCH_AUTHORIZATION_CHECKS,
    ]);
  });

  it('should keep the gate_spec_v1 policy shape aligned with the registry constants', () => {
    const schema = readSchema('gate_spec_v1.schema.json') as {
      properties: {
        policy: {
          properties: {
            launch_authorization: {
              properties: {
                result_schema: { const: string };
                required_checks: { items: { enum: string[] } };
              };
            };
          };
        };
      };
    };
    const shape = schema.properties.policy.properties.launch_authorization;
    expect(shape.properties.result_schema.const).toBe(LAUNCH_AUTHORIZATION_RESULT_SCHEMA);
    expect(shape.properties.required_checks.items.enum).toEqual([
      ...LAUNCH_AUTHORIZATION_CHECKS,
    ]);
  });

  it('should refuse on every non-authorized verdict label', () => {
    // Every refusal verdict names what was falsified; authorized is the only pass.
    const refusals = LAUNCH_AUTHORIZATION_VERDICTS.filter((v) => v !== 'authorized');
    expect(refusals).toEqual([
      'invalid_record',
      'missing_plan_hash',
      'stale_review',
      'missing_review',
      'review_rejected',
      'reviewer_unavailable',
      'fingerprint_mismatch',
    ]);
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
