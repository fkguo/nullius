// Numeric claim comparison — the execution semantics behind the claim-grounding
// `numeric_match` method (claim-grounding.ts couples this into the report contract).
//
// `compareNumericClaim` answers ONE question mechanically: given a claimed numeric
// value and the value located in the cited source (each with an optional stated
// uncertainty), do they agree under an EXPLICIT tolerance policy? The result is a
// verdict plus machine-readable details (actual deviation, the tolerance actually
// applied, and the decision path taken), so every verdict is independently
// re-checkable from its recorded input — the same anti-fakery posture as the
// span rule in claim-grounding.ts.
//
// ## Tolerance honesty (the falsification-gate rule)
//
// This module is the numeric-comparison instance of the repo-wide falsification
// philosophy (see the numerical-reliability gate's cross-check rule: agreement
// within a tolerance coarser than the effect being certified is NON-DIAGNOSTIC —
// "agree, but cannot resolve X" — never a pass). Concretely:
//
//   - The stated uncertainties define the finest scale at which the two values
//     can be distinguished (their combined uncertainty). An acceptance window
//     wider than NON_DIAGNOSTIC_SIGMA_CEILING * that combined uncertainty would
//     also accept values that are DECISIVELY different from the source value, so
//     satisfying it certifies nothing about agreement. When |difference| falls
//     inside such a window, the verdict is `incomparable`
//     (`non_diagnostic_tolerance`) — NOT `within_tolerance`.
//   - The guard is deliberately ASYMMETRIC: it blocks confirmation, never
//     rejection. Failing even an over-wide tolerance means the discrepancy
//     exceeds a window that was already wider than the decisive-separation
//     scale, so `mismatch` stands. A weak test can falsify; it cannot corroborate.
//   - When NO uncertainty is provided on either side there is no scale against
//     which to judge the tolerance — and silently omitting a stated uncertainty
//     would be exactly the way to smuggle a hollow pass around the guard. So a
//     tolerance-based confirmation without uncertainties is issued ONLY when the
//     caller explicitly attests that neither side states one
//     (`no_stated_uncertainty: true`); the verdict is then `within_tolerance`
//     with decision path `within_tolerance_no_uncertainty` (the weaker footing
//     stays visible). Without that attestation the result is `incomparable`
//     (`uncertainty_not_attested`): omission alone can never confirm. A false
//     attestation is active fabrication on the same level as a fake "verbatim"
//     span — and equally auditable, because the span quoting the source value
//     verbatim shows whether an uncertainty was stated next to it. Exact
//     equality is exempt: it is a windowless fact about the numbers as given,
//     with no tolerance to gerrymander. Rejection is likewise never blocked.
//
// ## Units and conventions (v1 scope)
//
// This comparator performs NO unit or convention conversion. Both values (and
// uncertainties, and any absolute tolerance) MUST already be expressed in the
// same units, normalization, and sign/scale conventions — conversion is the
// caller's responsibility. A surprising `mismatch` should first be audited for a
// unit / scale-factor / convention difference between the two sides.
//
// ## Two intended usages (choose the policy accordingly)
//
//   - Transcription equality ("the source carries this exact number"): compare
//     quoted numbers as numbers; use `absolute`/`relative` tolerance at the
//     rounding precision of the quoted digits. Stated uncertainties are part of
//     the quoted data, not noise on the comparison.
//   - Statistical compatibility ("this result agrees with the published one"):
//     use the `uncertainty_multiple` policy with a small multiple; the combined
//     uncertainty is the native scale of the comparison.
//
// Style mirrors claim-grounding.ts / staged-content.ts: locally-defined types,
// pure functions, no I/O, no external deps.

export type NumericComparisonVerdict = 'exact' | 'within_tolerance' | 'mismatch' | 'incomparable';

export const NUMERIC_COMPARISON_VERDICTS: readonly NumericComparisonVerdict[] = [
  'exact',
  'within_tolerance',
  'mismatch',
  'incomparable',
];

/** Explicit, orthogonal tolerance policies. Exactly one must be chosen; there is
 *  no default — a comparison without a stated acceptance policy is not a check. */
export type NumericTolerancePolicy =
  /** Accept |claimed - source| <= value (same units as the compared values). */
  | { kind: 'absolute'; value: number }
  /** Accept |claimed - source| <= value * |source|. Undefined when source_value is 0. */
  | { kind: 'relative'; value: number }
  /** Accept |claimed - source| <= multiple * combined uncertainty.
   *  Requires at least one side to carry a stated uncertainty. */
  | { kind: 'uncertainty_multiple'; multiple: number };

export const NUMERIC_TOLERANCE_KINDS = ['absolute', 'relative', 'uncertainty_multiple'] as const;
export type NumericToleranceKind = (typeof NUMERIC_TOLERANCE_KINDS)[number];

export type NumericClaimComparisonInput = {
  /** The value the claim asserts. Same units/conventions as source_value (caller's duty). */
  claimed_value: number;
  /** Stated uncertainty on the claimed value, when the claim carries one. Must be finite and > 0. */
  claimed_uncertainty?: number;
  /** The value located in the cited source (quote it verbatim in the supporting span). */
  source_value: number;
  /** Stated uncertainty on the source value, when the source states one. Must be finite and > 0. */
  source_uncertainty?: number;
  /** Explicit attestation that NEITHER side's source states an uncertainty for the
   *  compared value. Required (as `true`) for a tolerance-based confirmation when no
   *  uncertainty is supplied — silent omission alone cannot confirm (see the header:
   *  omitting a stated uncertainty is the hollow-pass channel this closes). Must not
   *  be `true` when an uncertainty IS supplied (contradictory input). A false
   *  attestation is auditable against the verbatim span quoting the source value. */
  no_stated_uncertainty?: boolean;
  tolerance: NumericTolerancePolicy;
};

/** Why the verdict came out the way it did — the machine-readable branch taken. */
export type NumericComparisonDecisionPath =
  /** Non-finite value, non-positive/non-finite uncertainty, or malformed tolerance → incomparable. */
  | 'invalid_input'
  /** claimed_value === source_value: exact equality of the numbers as given (tolerance not consulted). */
  | 'exact_equal'
  /** |difference| <= tolerance, and the tolerance is diagnostic against the combined uncertainty. */
  | 'within_tolerance'
  /** |difference| <= tolerance with no uncertainty on either side, and the caller
   *  explicitly attested `no_stated_uncertainty: true`. Verdict is within_tolerance;
   *  the path records the weaker epistemic footing (diagnosticity not assessable). */
  | 'within_tolerance_no_uncertainty'
  /** |difference| > tolerance → mismatch (stands even when the tolerance is over-wide). */
  | 'beyond_tolerance'
  /** |difference| <= tolerance, but the tolerance exceeds NON_DIAGNOSTIC_SIGMA_CEILING x
   *  combined uncertainty: passing it cannot distinguish agreement from a resolvable
   *  discrepancy → incomparable, not within_tolerance. */
  | 'non_diagnostic_tolerance'
  /** |difference| <= tolerance with no uncertainty on either side and NO explicit
   *  `no_stated_uncertainty: true` attestation → incomparable: a confirmation may not
   *  rest on silently omitted uncertainties. */
  | 'uncertainty_not_attested'
  /** uncertainty_multiple policy chosen but neither side carries an uncertainty → incomparable. */
  | 'uncertainty_policy_without_uncertainty'
  /** relative policy chosen but source_value is 0, so the relative scale is undefined → incomparable. */
  | 'relative_scale_undefined';

export const NUMERIC_COMPARISON_DECISION_PATHS: readonly NumericComparisonDecisionPath[] = [
  'invalid_input',
  'exact_equal',
  'within_tolerance',
  'within_tolerance_no_uncertainty',
  'beyond_tolerance',
  'non_diagnostic_tolerance',
  'uncertainty_not_attested',
  'uncertainty_policy_without_uncertainty',
  'relative_scale_undefined',
];

/** An acceptance window wider than this many combined standard deviations is
 *  non-diagnostic: a window that would also pass a decisively-different value
 *  (conventionally, a five-standard-deviation separation is decisive evidence of
 *  difference) cannot certify agreement. Boundary is inclusive on the diagnostic
 *  side: tolerance == ceiling * combined uncertainty still counts as diagnostic. */
export const NON_DIAGNOSTIC_SIGMA_CEILING = 5;

export type NumericClaimComparisonDetails = {
  /** claimed_value - source_value. null only when the input is invalid. */
  signed_difference: number | null;
  /** |claimed_value - source_value|. null only when the input is invalid. */
  absolute_difference: number | null;
  /** (claimed_value - source_value) / |source_value|. null when source_value is 0 or input invalid. */
  relative_difference: number | null;
  /** sqrt of the sum of squares of the PROVIDED uncertainties. null when neither side provides one. */
  combined_uncertainty: number | null;
  /** |difference| / combined_uncertainty. null when combined_uncertainty is null. */
  sigma_distance: number | null;
  /** The acceptance window actually applied, resolved to absolute units. null when unresolvable. */
  tolerance_used: number | null;
  decision_path: NumericComparisonDecisionPath;
  /** Human-readable justification for the verdict (decision_path is the machine-readable one). */
  reason: string;
};

export type NumericClaimComparisonResult = {
  verdict: NumericComparisonVerdict;
  details: NumericClaimComparisonDetails;
};

function invalidResult(reason: string): NumericClaimComparisonResult {
  return {
    verdict: 'incomparable',
    details: {
      signed_difference: null,
      absolute_difference: null,
      relative_difference: null,
      combined_uncertainty: null,
      sigma_distance: null,
      tolerance_used: null,
      decision_path: 'invalid_input',
      reason,
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate an optional stated uncertainty. Returns an error string, or null when acceptable.
 *  An EXPLICIT zero (or negative / non-finite) uncertainty is rejected rather than treated as
 *  "exact": a stated 0 is almost always a transcription placeholder (uncertainty not extracted),
 *  and accepting it would silently claim infinite resolution — collapsing the combined
 *  uncertainty toward 0 makes every finite tolerance non-diagnostic and every
 *  uncertainty_multiple window zero-width. A value genuinely quoted without an uncertainty
 *  must OMIT the field instead ("no uncertainty information", handled explicitly above). */
function uncertaintyError(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (!isFiniteNumber(value)) return `${label} must be a finite number when provided`;
  if (value <= 0) return `${label} must be > 0 when provided (omit the field for a value quoted without an uncertainty)`;
  return null;
}

function validateTolerance(tolerance: NumericTolerancePolicy): string | null {
  if (typeof tolerance !== 'object' || tolerance === null) return 'tolerance must be an object';
  switch (tolerance.kind) {
    case 'absolute':
    case 'relative':
      if (!isFiniteNumber(tolerance.value) || tolerance.value < 0) {
        return `tolerance.value must be a finite number >= 0 for kind '${tolerance.kind}'`;
      }
      return null;
    case 'uncertainty_multiple':
      if (!isFiniteNumber(tolerance.multiple) || tolerance.multiple < 0) {
        return "tolerance.multiple must be a finite number >= 0 for kind 'uncertainty_multiple'";
      }
      return null;
    default:
      return `tolerance.kind must be one of ${NUMERIC_TOLERANCE_KINDS.join(', ')}`;
  }
}

/** Compare a claimed numeric value against the value located in the cited source,
 *  under an explicit tolerance policy. Pure and deterministic: the verdict is a
 *  function of the recorded input only, so contract-side validators can recompute
 *  it and reject any hand-edited verdict.
 *
 *  Decision order: input validation → exact equality → tolerance resolution →
 *  non-diagnostic guard (confirmation only) → comparison. Boundary inclusive:
 *  |difference| == tolerance counts as within. Defensive at runtime: non-number
 *  fields yield `incomparable` (`invalid_input`), never a throw, so the function
 *  is safe to run on JSON-derived data during report parsing. */
export function compareNumericClaim(input: NumericClaimComparisonInput): NumericClaimComparisonResult {
  if (typeof input !== 'object' || input === null) {
    return invalidResult('input must be an object');
  }
  if (!isFiniteNumber(input.claimed_value)) {
    return invalidResult('claimed_value must be a finite number (NaN/Infinity are not comparable)');
  }
  if (!isFiniteNumber(input.source_value)) {
    return invalidResult('source_value must be a finite number (NaN/Infinity are not comparable)');
  }
  const claimedUncErr = uncertaintyError(input.claimed_uncertainty, 'claimed_uncertainty');
  if (claimedUncErr) return invalidResult(claimedUncErr);
  const sourceUncErr = uncertaintyError(input.source_uncertainty, 'source_uncertainty');
  if (sourceUncErr) return invalidResult(sourceUncErr);
  if (input.no_stated_uncertainty !== undefined && typeof input.no_stated_uncertainty !== 'boolean') {
    return invalidResult('no_stated_uncertainty must be a boolean when provided');
  }
  if (
    input.no_stated_uncertainty === true
    && (input.claimed_uncertainty !== undefined || input.source_uncertainty !== undefined)
  ) {
    return invalidResult(
      'no_stated_uncertainty: true contradicts a supplied uncertainty; drop the attestation or the uncertainty',
    );
  }
  const toleranceErr = validateTolerance(input.tolerance);
  if (toleranceErr) return invalidResult(toleranceErr);

  const signed = input.claimed_value - input.source_value;
  const absolute = Math.abs(signed);
  const relative = input.source_value === 0 ? null : signed / Math.abs(input.source_value);
  const provided = [input.claimed_uncertainty, input.source_uncertainty].filter(isFiniteNumber);
  const combined = provided.length > 0 ? Math.hypot(...provided) : null;
  const sigmaDistance = combined !== null ? absolute / combined : null;

  // Overflow guard: finite inputs can still overflow the derived quantities
  // (e.g. a subtraction or quadrature near the double range limit). The parser
  // requires finite-or-null detail fields, so surface the overflow as
  // invalid_input here instead of emitting non-finite details downstream.
  if (
    !Number.isFinite(absolute)
    || (relative !== null && !Number.isFinite(relative))
    || (combined !== null && !Number.isFinite(combined))
    || (sigmaDistance !== null && !Number.isFinite(sigmaDistance))
  ) {
    return invalidResult(
      'a derived quantity (difference, relative difference, combined uncertainty, or sigma distance) overflowed the double range; rescale the values before comparing',
    );
  }

  const base = {
    signed_difference: signed,
    absolute_difference: absolute,
    relative_difference: relative,
    combined_uncertainty: combined,
    sigma_distance: sigmaDistance,
  };

  // Exact equality of the numbers as given is a direct fact — it needs no
  // tolerance machinery and short-circuits before policy resolution.
  if (input.claimed_value === input.source_value) {
    return {
      verdict: 'exact',
      details: {
        ...base,
        tolerance_used: null,
        decision_path: 'exact_equal',
        reason: 'claimed_value and source_value are exactly equal as given',
      },
    };
  }

  // Resolve the policy to an absolute acceptance window.
  let toleranceUsed: number;
  switch (input.tolerance.kind) {
    case 'absolute':
      toleranceUsed = input.tolerance.value;
      break;
    case 'relative':
      if (input.source_value === 0) {
        return {
          verdict: 'incomparable',
          details: {
            ...base,
            tolerance_used: null,
            decision_path: 'relative_scale_undefined',
            reason: 'relative tolerance is undefined against a source_value of 0; use an absolute tolerance',
          },
        };
      }
      toleranceUsed = input.tolerance.value * Math.abs(input.source_value);
      break;
    case 'uncertainty_multiple':
      if (combined === null) {
        return {
          verdict: 'incomparable',
          details: {
            ...base,
            tolerance_used: null,
            decision_path: 'uncertainty_policy_without_uncertainty',
            reason:
              'uncertainty_multiple tolerance requires a stated uncertainty on at least one side; none was provided',
          },
        };
      }
      toleranceUsed = input.tolerance.multiple * combined;
      break;
  }

  // Same overflow guard for the resolved acceptance window (a relative or
  // uncertainty-multiple product can overflow even when every factor is finite).
  if (!Number.isFinite(toleranceUsed)) {
    return invalidResult(
      'the resolved tolerance overflowed the double range; rescale the tolerance or the values before comparing',
    );
  }

  if (absolute > toleranceUsed) {
    return {
      verdict: 'mismatch',
      details: {
        ...base,
        tolerance_used: toleranceUsed,
        decision_path: 'beyond_tolerance',
        reason:
          `|claimed - source| = ${absolute} exceeds the tolerance ${toleranceUsed}; `
          + 'if unexpected, check units, scale factors, and sign/normalization conventions on both sides '
          + '(this comparator performs no unit conversion)',
      },
    };
  }

  // |difference| <= tolerance. Before confirming, apply the non-diagnostic guard:
  // an acceptance window wider than NON_DIAGNOSTIC_SIGMA_CEILING * the combined
  // uncertainty would also pass a decisively-different value, so meeting it is not
  // evidence of agreement. This guard blocks CONFIRMATION only — the mismatch
  // branch above already returned, so rejection always stands (a weak test can
  // falsify but cannot corroborate).
  if (combined !== null && toleranceUsed > NON_DIAGNOSTIC_SIGMA_CEILING * combined) {
    return {
      verdict: 'incomparable',
      details: {
        ...base,
        tolerance_used: toleranceUsed,
        decision_path: 'non_diagnostic_tolerance',
        reason:
          `tolerance ${toleranceUsed} is wider than ${NON_DIAGNOSTIC_SIGMA_CEILING} * combined uncertainty `
          + `${combined}: agreement within it cannot be distinguished from a resolvable discrepancy `
          + `(observed |difference| = ${absolute}, sigma distance = ${sigmaDistance}); `
          + 'tighten the tolerance to the scale the stated uncertainties resolve',
      },
    };
  }

  if (combined === null) {
    // No uncertainty on either side: a tolerance-based CONFIRMATION may only rest
    // on the explicit attestation that no uncertainty is stated in the sources —
    // silent omission of a stated uncertainty is the hollow-pass channel the
    // non-diagnostic guard cannot see, so it is closed here mechanically.
    // (Rejection was never blocked: the mismatch branch already returned above.)
    if (input.no_stated_uncertainty !== true) {
      return {
        verdict: 'incomparable',
        details: {
          ...base,
          tolerance_used: toleranceUsed,
          decision_path: 'uncertainty_not_attested',
          reason:
            `|claimed - source| = ${absolute} is within the tolerance ${toleranceUsed}, but no uncertainty `
            + 'was provided on either side and no_stated_uncertainty: true was not attested; supply the '
            + 'stated uncertainties, or explicitly attest that the sources state none',
        },
      };
    }
    return {
      verdict: 'within_tolerance',
      details: {
        ...base,
        tolerance_used: toleranceUsed,
        decision_path: 'within_tolerance_no_uncertainty',
        reason:
          `|claimed - source| = ${absolute} is within the tolerance ${toleranceUsed}; no uncertainty is `
          + 'stated on either side (explicitly attested), so diagnosticity was not assessable',
      },
    };
  }

  return {
    verdict: 'within_tolerance',
    details: {
      ...base,
      tolerance_used: toleranceUsed,
      decision_path: 'within_tolerance',
      reason: `|claimed - source| = ${absolute} is within the tolerance ${toleranceUsed}, which is diagnostic against the combined uncertainty ${combined}`,
    },
  };
}
