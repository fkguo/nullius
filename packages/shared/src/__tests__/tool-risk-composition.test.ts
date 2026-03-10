import { describe, it, expect } from 'vitest';
import { composedRiskLevel, getToolRiskLevel, hasToolRiskEntry, PERMISSION_POLICY } from '../../src/tool-risk.js';

describe('H-11b: composedRiskLevel', () => {
  it('returns "read" for empty array', () => {
    expect(composedRiskLevel([])).toBe('read');
  });

  it('returns single level unchanged', () => {
    expect(composedRiskLevel(['read'])).toBe('read');
    expect(composedRiskLevel(['write'])).toBe('write');
    expect(composedRiskLevel(['destructive'])).toBe('destructive');
  });

  it('takes highest: read + write → write', () => {
    expect(composedRiskLevel(['read', 'write'])).toBe('write');
  });

  it('takes highest: read + destructive → destructive', () => {
    expect(composedRiskLevel(['read', 'destructive'])).toBe('destructive');
  });

  it('takes highest: write + destructive → destructive', () => {
    expect(composedRiskLevel(['write', 'destructive'])).toBe('destructive');
  });

  it('handles many items correctly', () => {
    expect(composedRiskLevel(['read', 'read', 'write', 'read'])).toBe('write');
    expect(composedRiskLevel(['read', 'read', 'read'])).toBe('read');
    expect(composedRiskLevel(['write', 'write', 'destructive', 'read'])).toBe('destructive');
  });
});

describe('H-11b: PERMISSION_POLICY', () => {
  it('has expected fields', () => {
    expect(PERMISSION_POLICY.destructive_requires_gate).toBe(true);
    expect(PERMISSION_POLICY.write_chain_requires_gate).toBe(false);
    expect(PERMISSION_POLICY.max_chain_length).toBe(10);
  });
});

describe('tool risk lookup helpers', () => {
  const table = {
    alpha: 'read',
    beta: 'destructive',
  } as const;

  it('getToolRiskLevel returns the mapped value', () => {
    expect(getToolRiskLevel('alpha', table)).toBe('read');
    expect(getToolRiskLevel('beta', table)).toBe('destructive');
  });

  it('getToolRiskLevel falls back when the entry is absent', () => {
    expect(getToolRiskLevel('missing', table)).toBe('read');
    expect(getToolRiskLevel('missing', table, 'write')).toBe('write');
  });

  it('hasToolRiskEntry detects presence accurately', () => {
    expect(hasToolRiskEntry('alpha', table)).toBe(true);
    expect(hasToolRiskEntry('missing', table)).toBe(false);
  });
});
