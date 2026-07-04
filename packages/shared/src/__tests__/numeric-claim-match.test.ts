import { describe, expect, it } from 'vitest';
import {
  compareNumericClaim,
  NON_DIAGNOSTIC_SIGMA_CEILING,
  NUMERIC_COMPARISON_DECISION_PATHS,
  NUMERIC_COMPARISON_VERDICTS,
  type NumericClaimComparisonInput,
  type NumericTolerancePolicy,
} from '../numeric-claim-match.js';

function input(overrides: Partial<NumericClaimComparisonInput> = {}): NumericClaimComparisonInput {
  return {
    claimed_value: 1.2,
    claimed_uncertainty: 0.1,
    source_value: 1.19,
    source_uncertainty: 0.05,
    tolerance: { kind: 'uncertainty_multiple', multiple: 2 },
    ...overrides,
  };
}

describe('compareNumericClaim: exact', () => {
  it('returns exact for identical values (short-circuits before tolerance machinery)', () => {
    const out = compareNumericClaim(input({ claimed_value: 1.19, source_value: 1.19 }));
    expect(out.verdict).toBe('exact');
    expect(out.details.decision_path).toBe('exact_equal');
    expect(out.details.signed_difference).toBe(0);
    expect(out.details.absolute_difference).toBe(0);
    expect(out.details.tolerance_used).toBeNull();
  });

  it('short-circuits exact even when the uncertainty policy has no uncertainties to work with', () => {
    const out = compareNumericClaim({
      claimed_value: 1.2,
      source_value: 1.2,
      tolerance: { kind: 'uncertainty_multiple', multiple: 2 },
    });
    expect(out.verdict).toBe('exact');
    expect(out.details.decision_path).toBe('exact_equal');
  });
});

describe('compareNumericClaim: within_tolerance', () => {
  it('uncertainty_multiple: |diff| within k * combined uncertainty is within_tolerance and diagnostic', () => {
    const out = compareNumericClaim(input()); // |1.2 - 1.19| = 0.01, sigma = hypot(0.1, 0.05)
    expect(out.verdict).toBe('within_tolerance');
    expect(out.details.decision_path).toBe('within_tolerance');
    expect(out.details.combined_uncertainty).toBeCloseTo(Math.hypot(0.1, 0.05), 12);
    expect(out.details.tolerance_used).toBeCloseTo(2 * Math.hypot(0.1, 0.05), 12);
    expect(out.details.signed_difference).toBeCloseTo(0.01, 12);
    expect(out.details.sigma_distance).toBeCloseTo(0.01 / Math.hypot(0.1, 0.05), 12);
  });

  it('accepts a one-sided uncertainty (combined uncertainty = the provided one)', () => {
    const out = compareNumericClaim(input({ claimed_uncertainty: undefined }));
    expect(out.verdict).toBe('within_tolerance');
    expect(out.details.combined_uncertainty).toBeCloseTo(0.05, 12);
    expect(out.details.tolerance_used).toBeCloseTo(0.1, 12);
  });

  it('absolute tolerance with NO uncertainty confirms only under the explicit attestation', () => {
    const attested = compareNumericClaim({
      claimed_value: 1.2,
      source_value: 1.23,
      no_stated_uncertainty: true,
      tolerance: { kind: 'absolute', value: 0.05 },
    });
    expect(attested.verdict).toBe('within_tolerance');
    expect(attested.details.decision_path).toBe('within_tolerance_no_uncertainty');
    expect(attested.details.combined_uncertainty).toBeNull();
    expect(attested.details.sigma_distance).toBeNull();
    expect(attested.details.tolerance_used).toBe(0.05);
  });

  it('relative tolerance resolves against |source_value|', () => {
    const out = compareNumericClaim({
      claimed_value: 101,
      source_value: 100,
      no_stated_uncertainty: true,
      tolerance: { kind: 'relative', value: 0.05 },
    });
    expect(out.verdict).toBe('within_tolerance');
    expect(out.details.tolerance_used).toBeCloseTo(5, 12);
    expect(out.details.relative_difference).toBeCloseTo(0.01, 12);
  });

  it('boundary is inclusive: |difference| exactly equal to the tolerance is within', () => {
    // Powers of two so the difference and the tolerance are bit-exact equals.
    const out = compareNumericClaim({
      claimed_value: 1.5,
      claimed_uncertainty: 0.125,
      source_value: 1.25,
      source_uncertainty: 0.125,
      tolerance: { kind: 'absolute', value: 0.25 },
    });
    expect(out.details.absolute_difference).toBe(0.25);
    expect(out.details.tolerance_used).toBe(0.25);
    expect(out.verdict).toBe('within_tolerance');
    expect(out.details.decision_path).toBe('within_tolerance');
  });

  it('boundary is inclusive on the diagnostic side: multiple exactly at the ceiling still confirms', () => {
    const out = compareNumericClaim(input({
      claimed_value: 1.0,
      claimed_uncertainty: 0.1,
      source_value: 1.2,
      source_uncertainty: 0.1,
      tolerance: { kind: 'uncertainty_multiple', multiple: NON_DIAGNOSTIC_SIGMA_CEILING },
    }));
    expect(out.verdict).toBe('within_tolerance');
    expect(out.details.decision_path).toBe('within_tolerance');
  });
});

describe('compareNumericClaim: mismatch', () => {
  it('flags |diff| beyond the tolerance and hints at units/conventions in the reason', () => {
    const out = compareNumericClaim(input({ claimed_value: 2.4, claimed_uncertainty: undefined }));
    expect(out.verdict).toBe('mismatch');
    expect(out.details.decision_path).toBe('beyond_tolerance');
    expect(out.details.reason).toMatch(/unit/i);
    expect(out.details.reason).toMatch(/no unit conversion/i);
  });

  it('a zero absolute tolerance demands exactness: any difference is a mismatch', () => {
    const out = compareNumericClaim({
      claimed_value: 1.2000001,
      source_value: 1.2,
      tolerance: { kind: 'absolute', value: 0 },
    });
    expect(out.verdict).toBe('mismatch');
    expect(out.details.decision_path).toBe('beyond_tolerance');
  });

  it('falsification asymmetry: failing even an over-wide (non-diagnostic) window is still a mismatch', () => {
    // multiple = 50 is far beyond the diagnostic ceiling, but |diff| exceeds even
    // that window, so rejection stands: a weak test can falsify.
    const out = compareNumericClaim({
      claimed_value: 1.0,
      claimed_uncertainty: 0.001,
      source_value: 2.0,
      source_uncertainty: 0.001,
      tolerance: { kind: 'uncertainty_multiple', multiple: 50 },
    });
    expect(out.verdict).toBe('mismatch');
    expect(out.details.decision_path).toBe('beyond_tolerance');
  });
});

describe('compareNumericClaim: non-diagnostic tolerance is refused, not passed', () => {
  it('absolute tolerance far wider than the combined uncertainty cannot confirm a 35-sigma discrepancy', () => {
    // |diff| = 0.5 = ~35 sigma, hidden inside a tolerance of 10: the honest verdict
    // is incomparable (the window would also pass decisively-different values).
    const out = compareNumericClaim({
      claimed_value: 1.0,
      claimed_uncertainty: 0.01,
      source_value: 1.5,
      source_uncertainty: 0.01,
      tolerance: { kind: 'absolute', value: 10 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('non_diagnostic_tolerance');
    expect(out.details.tolerance_used).toBe(10);
    expect(out.details.sigma_distance).toBeCloseTo(0.5 / Math.hypot(0.01, 0.01), 9);
    expect(out.details.reason).toMatch(/cannot be distinguished/i);
  });

  it('an uncertainty multiple beyond the ceiling is refused even when the values agree', () => {
    const out = compareNumericClaim({
      claimed_value: 1.0,
      claimed_uncertainty: 0.001,
      source_value: 1.001,
      source_uncertainty: 0.001,
      tolerance: { kind: 'uncertainty_multiple', multiple: 50 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('non_diagnostic_tolerance');
  });

  it('the same wide relative tolerance flips from pass to refusal once uncertainties are stated', () => {
    const noUnc = compareNumericClaim({
      claimed_value: 101,
      source_value: 100,
      no_stated_uncertainty: true,
      tolerance: { kind: 'relative', value: 0.05 },
    });
    expect(noUnc.verdict).toBe('within_tolerance');
    expect(noUnc.details.decision_path).toBe('within_tolerance_no_uncertainty');

    const withUnc = compareNumericClaim({
      claimed_value: 101,
      claimed_uncertainty: 0.1,
      source_value: 100,
      source_uncertainty: 0.1,
      tolerance: { kind: 'relative', value: 0.05 }, // resolves to 5, vs 5*sigma ~ 0.7
    });
    expect(withUnc.verdict).toBe('incomparable');
    expect(withUnc.details.decision_path).toBe('non_diagnostic_tolerance');
  });
});

describe('compareNumericClaim: the no-uncertainty attestation closes silent omission', () => {
  it('a tolerance-based confirmation with no uncertainties and no attestation is incomparable', () => {
    // The hollow-pass channel: omit the uncertainties the source states and pick a
    // comfortable tolerance. Without the explicit attestation this cannot confirm.
    const out = compareNumericClaim({
      claimed_value: 1.2,
      source_value: 1.23,
      tolerance: { kind: 'absolute', value: 0.05 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('uncertainty_not_attested');
    expect(out.details.reason).toMatch(/no_stated_uncertainty/);
  });

  it('rejection needs no attestation: beyond-tolerance without uncertainties is still a mismatch', () => {
    const out = compareNumericClaim({
      claimed_value: 2.4,
      source_value: 1.19,
      tolerance: { kind: 'absolute', value: 0.05 },
    });
    expect(out.verdict).toBe('mismatch');
    expect(out.details.decision_path).toBe('beyond_tolerance');
  });

  it('exact equality needs no attestation (windowless fact about the numbers as given)', () => {
    const out = compareNumericClaim({
      claimed_value: 1.23,
      source_value: 1.23,
      tolerance: { kind: 'absolute', value: 0.05 },
    });
    expect(out.verdict).toBe('exact');
    expect(out.details.decision_path).toBe('exact_equal');
  });

  it('attesting no_stated_uncertainty while supplying an uncertainty is contradictory input', () => {
    const out = compareNumericClaim(input({ no_stated_uncertainty: true }));
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('invalid_input');
    expect(out.details.reason).toMatch(/contradicts/);
  });

  it('a non-boolean attestation is invalid input', () => {
    const out = compareNumericClaim({
      claimed_value: 1.2,
      source_value: 1.23,
      no_stated_uncertainty: 'yes' as unknown as boolean,
      tolerance: { kind: 'absolute', value: 0.05 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('invalid_input');
  });
});

describe('compareNumericClaim: derived-quantity overflow', () => {
  it('a finite pair whose difference overflows is invalid input, not a non-finite detail', () => {
    const out = compareNumericClaim({
      claimed_value: 1.7e308,
      source_value: -1.7e308,
      tolerance: { kind: 'absolute', value: 1 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('invalid_input');
    expect(out.details.reason).toMatch(/overflow/i);
    expect(out.details.signed_difference).toBeNull();
  });

  it('a resolved tolerance that overflows is invalid input', () => {
    const out = compareNumericClaim({
      claimed_value: 1e10,
      source_value: 2e10,
      no_stated_uncertainty: true,
      tolerance: { kind: 'relative', value: 1e308 }, // 1e308 * 2e10 overflows
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('invalid_input');
    expect(out.details.reason).toMatch(/tolerance overflowed/i);
  });
});

describe('compareNumericClaim: incomparable policy/scale failures', () => {
  it('uncertainty_multiple without any stated uncertainty is incomparable', () => {
    const out = compareNumericClaim({
      claimed_value: 1.2,
      source_value: 1.19,
      tolerance: { kind: 'uncertainty_multiple', multiple: 2 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('uncertainty_policy_without_uncertainty');
    expect(out.details.combined_uncertainty).toBeNull();
    // The deviation itself is still reported for the audit trail.
    expect(out.details.signed_difference).toBeCloseTo(0.01, 12);
  });

  it('relative tolerance against a source value of 0 is incomparable', () => {
    const out = compareNumericClaim({
      claimed_value: 0.1,
      source_value: 0,
      tolerance: { kind: 'relative', value: 0.1 },
    });
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('relative_scale_undefined');
    expect(out.details.relative_difference).toBeNull();
  });
});

describe('compareNumericClaim: input validation', () => {
  function expectInvalid(bad: NumericClaimComparisonInput, reasonPattern: RegExp): void {
    const out = compareNumericClaim(bad);
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('invalid_input');
    expect(out.details.reason).toMatch(reasonPattern);
    expect(out.details.signed_difference).toBeNull();
    expect(out.details.tolerance_used).toBeNull();
  }

  it('rejects NaN values', () => {
    expectInvalid(input({ claimed_value: Number.NaN }), /claimed_value/);
    expectInvalid(input({ source_value: Number.NaN }), /source_value/);
  });

  it('rejects infinite values (Infinity === Infinity must NOT count as exact)', () => {
    expectInvalid(
      input({ claimed_value: Number.POSITIVE_INFINITY, source_value: Number.POSITIVE_INFINITY }),
      /claimed_value/,
    );
  });

  it('rejects an explicit zero uncertainty (omit the field instead)', () => {
    expectInvalid(input({ claimed_uncertainty: 0 }), /claimed_uncertainty.*> 0/);
    expectInvalid(input({ source_uncertainty: 0 }), /source_uncertainty.*> 0/);
  });

  it('rejects negative and non-finite uncertainties', () => {
    expectInvalid(input({ claimed_uncertainty: -0.1 }), /claimed_uncertainty/);
    expectInvalid(input({ source_uncertainty: Number.NaN }), /source_uncertainty/);
    expectInvalid(input({ source_uncertainty: Number.POSITIVE_INFINITY }), /source_uncertainty/);
  });

  it('rejects malformed tolerances', () => {
    expectInvalid(input({ tolerance: { kind: 'absolute', value: -1 } }), /tolerance\.value/);
    expectInvalid(input({ tolerance: { kind: 'absolute', value: Number.NaN } }), /tolerance\.value/);
    expectInvalid(input({ tolerance: { kind: 'uncertainty_multiple', multiple: -2 } }), /tolerance\.multiple/);
    expectInvalid(
      input({ tolerance: { kind: 'nonsense' } as unknown as NumericTolerancePolicy }),
      /tolerance\.kind/,
    );
  });

  it('rejects invalid input before the exact-equality short-circuit', () => {
    // Identical values but a broken tolerance record: validation wins.
    const out = compareNumericClaim(input({
      claimed_value: 1.2,
      source_value: 1.2,
      tolerance: { kind: 'absolute', value: Number.NaN },
    }));
    expect(out.verdict).toBe('incomparable');
    expect(out.details.decision_path).toBe('invalid_input');
  });
});

describe('exported constants', () => {
  it('enumerate all verdicts and decision paths', () => {
    expect(NUMERIC_COMPARISON_VERDICTS).toContain('exact');
    expect(NUMERIC_COMPARISON_VERDICTS).toContain('incomparable');
    expect(NUMERIC_COMPARISON_DECISION_PATHS).toContain('non_diagnostic_tolerance');
    expect(NUMERIC_COMPARISON_DECISION_PATHS).toContain('within_tolerance_no_uncertainty');
    expect(NUMERIC_COMPARISON_DECISION_PATHS).toContain('uncertainty_not_attested');
    expect(NON_DIAGNOSTIC_SIGMA_CEILING).toBeGreaterThan(0);
  });
});
