import { describe, expect, it, vi } from 'vitest';

import { adjudicateQuantityPair } from '../../src/core/semantics/quantityAdjudicator.js';

describe('eval: SEM-01 quantity alignment authority cleanup (local-proof-only)', () => {
  it('invokes MCP sampling when available (contract smoke test)', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem01',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'match',
            canonical_quantity: 'mass:x3872',
            confidence: 0.9,
            reason_code: 'same_quantity',
          }),
        },
      ],
    });

    const adjudication = await adjudicateQuantityPair(
      { quantity: 'm_{X(3872)}', context: 'We quote m_{X(3872)} = 3871.69 MeV.', unit: 'MeV' },
      { quantity: 'mass of X(3872)', context: 'The mass of X(3872) is 3871.69 MeV.', unit: 'MeV' },
      { createMessage },
    );

    expect(createMessage).toHaveBeenCalled();
    expect(adjudication.provenance.backend).toBe('mcp_sampling');
    expect(adjudication.provenance.used_fallback).toBe(false);
    expect(adjudication.decision).toBe('match');
  });

  it('keeps only the deterministic unit-incompatible gate when sampling is absent', async () => {
    const adjudication = await adjudicateQuantityPair(
      { quantity: '\\Gamma_{X(3872)}', context: 'Width in MeV.', unit: 'MeV' },
      { quantity: '\\tau_{X(3872)}', context: 'Lifetime in ps.', unit: 'ps' },
    );

    expect(adjudication.decision).toBe('split');
    expect(adjudication.reason_code).toBe('unit_incompatible');
    expect(adjudication.provenance.backend).toBe('diagnostic');
    expect(adjudication.provenance.used_fallback).toBe(false);
  });

  it('fails closed instead of emitting heuristic match/split decisions when sampling is unavailable', async () => {
    const adjudication = await adjudicateQuantityPair(
      { quantity: 'mass of X(3872)', context: 'We measure the mass of X(3872): 3871.69 MeV.', unit: 'MeV' },
      { quantity: 'm_{X(3872)}', context: 'The value of m_{X(3872)} is 3871.69 MeV.', unit: 'MeV' },
    );

    expect(adjudication.decision).toBe('uncertain');
    expect(adjudication.canonical_quantity).toBe('unknown');
    expect(adjudication.reason_code).toBe('sampling_unavailable');
    expect(adjudication.provenance.backend).toBe('diagnostic');
    expect(adjudication.provenance.used_fallback).toBe(false);
  });

  it('fails closed when the sampling backend errors before returning a judgment', async () => {
    const adjudication = await adjudicateQuantityPair(
      { quantity: 'mass of X(3872)', context: 'We measure the mass of X(3872): 3871.69 MeV.', unit: 'MeV' },
      { quantity: 'm_{X(3872)}', context: 'The value of m_{X(3872)} is 3871.69 MeV.', unit: 'MeV' },
      { createMessage: vi.fn().mockRejectedValue(new Error('sampling offline')) },
    );

    expect(adjudication.decision).toBe('uncertain');
    expect(adjudication.reason_code).toBe('sampling_unavailable');
    expect(adjudication.provenance.backend).toBe('mcp_sampling');
    expect(adjudication.provenance.used_fallback).toBe(false);
  });
});
