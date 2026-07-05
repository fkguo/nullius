"""Statistical correctness of the Beta construction used for Thompson sampling.

Tolerance policy (no hand-picked percentages): every Monte Carlo comparison
uses a 5-sigma band of the estimator's own standard error, derived below.
With 5 sigma the per-comparison false-failure probability is about 5.7e-7,
so the suite is effectively deterministic while remaining a real test.

Derivations used:

- Sample mean of N iid draws: SE_mean = sigma / sqrt(N), with
  sigma^2 = alpha*beta / ((alpha+beta)^2 (alpha+beta+1)) the exact Beta
  variance.
- Unbiased sample variance s^2 of N iid draws:
  Var(s^2) = mu4/N - sigma^4 (N-3) / (N (N-1)), with mu4 the exact central
  fourth moment. For the Beta distribution mu4 = (excess_kurtosis + 3) *
  sigma^4 and
  excess_kurtosis = 6 * ((alpha-beta)^2 (alpha+beta+1) - alpha*beta*(alpha+beta+2))
                    / (alpha*beta*(alpha+beta+2)*(alpha+beta+3)).
- Empirical CDF at a fixed point t: the indicator is Bernoulli(F(t)), so
  SE_cdf = sqrt(F(t) (1 - F(t)) / N).
- Tail and pairwise win probabilities: the MC estimate is a binomial
  fraction, SE = sqrt(p (1 - p) / N) with p the EXACT probability computed
  in rational arithmetic (integer-parameter Beta has closed forms; see
  helpers below), so the tolerance is anchored to theory, not to the sample.
"""

from __future__ import annotations

import math
import random
from fractions import Fraction

import pytest

import thompson_allocation as ta

N_SAMPLES = 200_000
SIGMAS = 5.0


# ---------------------------------------------------------------------------
# Exact theory helpers
# ---------------------------------------------------------------------------

def beta_moments(alpha: float, beta: float):
    """Exact mean, variance, and central fourth moment of Beta(alpha, beta)."""
    s = alpha + beta
    mean = alpha / s
    var = alpha * beta / (s * s * (s + 1.0))
    excess_kurtosis = (
        6.0
        * ((alpha - beta) ** 2 * (s + 1.0) - alpha * beta * (s + 2.0))
        / (alpha * beta * (s + 2.0) * (s + 3.0))
    )
    mu4 = (excess_kurtosis + 3.0) * var * var
    return mean, var, mu4


def mean_tolerance(var: float, n: int) -> float:
    return SIGMAS * math.sqrt(var / n)


def variance_tolerance(var: float, mu4: float, n: int) -> float:
    var_of_s2 = mu4 / n - var * var * (n - 3.0) / (n * (n - 1.0))
    return SIGMAS * math.sqrt(var_of_s2)


def exact_beta_function(m: int, n: int) -> Fraction:
    """B(m, n) = (m-1)! (n-1)! / (m+n-1)! for positive integers."""
    return Fraction(
        math.factorial(m - 1) * math.factorial(n - 1), math.factorial(m + n - 1)
    )


def exact_beta_tail(a: int, b: int, x: Fraction) -> Fraction:
    """P(X > x) for X ~ Beta(a, b) with integer a, b, rational x.

    Uses the binomial identity F(x) = P(Binomial(a+b-1, x) >= a), hence
    P(X > x) = sum_{j=0}^{a-1} C(a+b-1, j) x^j (1-x)^(a+b-1-j).
    """
    n = a + b - 1
    return sum(
        Fraction(math.comb(n, j)) * x**j * (1 - x) ** (n - j) for j in range(a)
    )


def exact_prob_x_greater_y(a1: int, b1: int, a2: int, b2: int) -> Fraction:
    """P(X > Y) for X ~ Beta(a1, b1), Y ~ Beta(a2, b2), all integer parameters.

    From P(X > y) = sum_{j=0}^{a1-1} C(n1, j) y^j (1-y)^(n1-j) with
    n1 = a1+b1-1, integrating against the Beta(a2, b2) density gives
    P(X > Y) = sum_{j=0}^{a1-1} C(n1, j) B(a2+j, b2+n1-j) / B(a2, b2).
    """
    n1 = a1 + b1 - 1
    total = Fraction(0)
    for j in range(a1):
        total += math.comb(n1, j) * exact_beta_function(a2 + j, b2 + n1 - j)
    return total / exact_beta_function(a2, b2)


def as_int_parameters(*values):
    """Round near-integer float Beta parameters for the exact rational formulas.

    ``beta_parameters`` works in floats, so a mathematically integer parameter
    can come out as 1.9999999999999998 (e.g. ``(1 - 0.8) * 5 + 1``). Truncation
    via ``int()`` would silently turn that into 1 and the exact formula would
    answer a different question — so we round to nearest and REFUSE anything
    that is not near-integer. (The sampler itself is unaffected: Beta parameters
    are continuous and an offset of order 1e-16 is far below every Monte Carlo
    tolerance used here.)
    """
    ints = []
    for value in values:
        nearest = round(value)
        assert abs(value - nearest) < 1e-9, f"parameter {value!r} is not near-integer"
        ints.append(int(nearest))
    return ints


def draws(alpha: float, beta: float, n: int, seed: int):
    rng = random.Random(seed)
    return [rng.betavariate(alpha, beta) for _ in range(n)]


def sample_mean_and_s2(values):
    n = len(values)
    mean = sum(values) / n
    s2 = sum((v - mean) ** 2 for v in values) / (n - 1)
    return mean, s2


# ---------------------------------------------------------------------------
# Self-checks of the exact helpers (rational arithmetic, no tolerance)
# ---------------------------------------------------------------------------

def test_exact_helpers_self_consistent():
    # Uniform vs uniform is a coin flip.
    assert exact_prob_x_greater_y(1, 1, 1, 1) == Fraction(1, 2)
    # No ties for continuous distributions: P(X>Y) + P(Y>X) = 1, exactly.
    for a1, b1, a2, b2 in [(2, 5, 5, 2), (2, 10, 9, 3), (9, 33, 33, 9)]:
        total = exact_prob_x_greater_y(a1, b1, a2, b2) + exact_prob_x_greater_y(
            a2, b2, a1, b1
        )
        assert total == 1
    # Uniform tail: P(X > x) = 1 - x.
    assert exact_beta_tail(1, 1, Fraction(1, 4)) == Fraction(3, 4)
    # Beta(2,1) has CDF x^2, so tail 1 - x^2.
    assert exact_beta_tail(2, 1, Fraction(1, 2)) == Fraction(3, 4)


# ---------------------------------------------------------------------------
# Construction basics
# ---------------------------------------------------------------------------

def test_beta_parameters_construction():
    assert ta.beta_parameters(0.0, 0) == (1.0, 1.0)
    assert ta.beta_parameters(1.0, 0) == (1.0, 1.0)  # zero evidence: value irrelevant
    assert ta.beta_parameters(0.25, 8) == (3.0, 7.0)
    alpha, beta = ta.beta_parameters(0.85, 40)
    assert math.isclose(alpha, 35.0) and math.isclose(beta, 7.0)


def test_beta_parameters_rejects_bad_input():
    with pytest.raises(ValueError):
        ta.beta_parameters(1.5, 3)
    with pytest.raises(ValueError):
        ta.beta_parameters(-0.1, 3)
    with pytest.raises(ValueError):
        ta.beta_parameters(0.5, -1)


# ---------------------------------------------------------------------------
# Sampler agrees with exact moments (5-sigma MC bands)
# ---------------------------------------------------------------------------

def test_sample_mean_and_variance_match_theory():
    cases = [  # (posterior value, evidence_count)
        (0.5, 0),
        (0.2, 3),
        (0.55, 12),
        (0.85, 40),
    ]
    for index, (value, count) in enumerate(cases):
        alpha, beta = ta.beta_parameters(value, count)
        mean, var, mu4 = beta_moments(alpha, beta)
        values = draws(alpha, beta, N_SAMPLES, seed=1000 + index)
        m_hat, s2_hat = sample_mean_and_s2(values)
        tol_m = mean_tolerance(var, N_SAMPLES)
        tol_v = variance_tolerance(var, mu4, N_SAMPLES)
        print(
            f"case value={value} n={count}: mean theory={mean:.6f} sample={m_hat:.6f} "
            f"tol={tol_m:.6f}; var theory={var:.6f} sample={s2_hat:.6f} tol={tol_v:.6f}"
        )
        assert abs(m_hat - mean) < tol_m, (
            f"mean off: |{m_hat} - {mean}| >= {tol_m} for Beta({alpha}, {beta})"
        )
        assert abs(s2_hat - var) < tol_v, (
            f"variance off: |{s2_hat} - {var}| >= {tol_v} for Beta({alpha}, {beta})"
        )


def test_zero_evidence_degenerates_to_uniform():
    alpha, beta = ta.beta_parameters(0.7, 0)  # value must be irrelevant at n=0
    assert (alpha, beta) == (1.0, 1.0)
    values = draws(alpha, beta, N_SAMPLES, seed=2026)
    mean, var, mu4 = beta_moments(1.0, 1.0)
    assert mean == 0.5 and math.isclose(var, 1.0 / 12.0)
    m_hat, s2_hat = sample_mean_and_s2(values)
    assert abs(m_hat - 0.5) < mean_tolerance(var, N_SAMPLES)
    assert abs(s2_hat - 1.0 / 12.0) < variance_tolerance(var, mu4, N_SAMPLES)
    # Distribution-level check: empirical CDF at fixed points, binomial SE.
    for t in (0.1, 0.25, 0.5, 0.75, 0.9):
        f_hat = sum(1 for v in values if v <= t) / N_SAMPLES
        tol = SIGMAS * math.sqrt(t * (1.0 - t) / N_SAMPLES)
        print(f"uniform CDF at t={t}: theory={t} sample={f_hat:.6f} tol={tol:.6f}")
        assert abs(f_hat - t) < tol


def test_concentration_grows_with_evidence():
    value = 0.8
    sds = {}
    for count in (0, 10, 1000):
        alpha, beta = ta.beta_parameters(value, count)
        mean, var, _ = beta_moments(alpha, beta)
        sds[count] = math.sqrt(var)
        # |posterior mean - value| = |1 - 2 value| / (n + 2) <= 1 / (n + 2): the
        # Laplace pseudo-counts bias the mean by at most 1/(n+2), exactly.
        assert abs(mean - value) <= 1.0 / (count + 2.0) + 1e-12
    assert sds[1000] < sds[10] < sds[0]  # exact theory ordering
    # Large-evidence sample statistics still match theory (5-sigma bands).
    alpha, beta = ta.beta_parameters(value, 1000)
    mean, var, mu4 = beta_moments(alpha, beta)
    values = draws(alpha, beta, N_SAMPLES, seed=3033)
    m_hat, s2_hat = sample_mean_and_s2(values)
    print(
        f"n=1000: mean theory={mean:.6f} sample={m_hat:.6f} "
        f"tol={mean_tolerance(var, N_SAMPLES):.6f}; sd theory={math.sqrt(var):.6f}"
    )
    assert abs(m_hat - mean) < mean_tolerance(var, N_SAMPLES)
    assert abs(s2_hat - var) < variance_tolerance(var, mu4, N_SAMPLES)


# ---------------------------------------------------------------------------
# Non-starvation: low-posterior ideas keep a mathematically nonzero and
# practically observable chance of drawing high
# ---------------------------------------------------------------------------

def test_low_posterior_tail_probability_exact_and_sampled():
    # posterior value 0.1 with 10 observations -> Beta(2, 10).
    alpha, beta = ta.beta_parameters(0.1, 10)
    assert as_int_parameters(alpha, beta) == [2, 10]
    p_exact = exact_beta_tail(2, 10, Fraction(1, 2))
    assert p_exact == Fraction(3, 512)  # = P(Binomial(11, 1/2) <= 1) = 12/2048
    assert p_exact > 0
    p = float(p_exact)
    values = draws(alpha, beta, N_SAMPLES, seed=4044)
    p_hat = sum(1 for v in values if v > 0.5) / N_SAMPLES
    tol = SIGMAS * math.sqrt(p * (1.0 - p) / N_SAMPLES)
    print(f"tail P(X>0.5) Beta(2,10): theory={p:.6f} sample={p_hat:.6f} tol={tol:.6f}")
    assert abs(p_hat - p) < tol


def test_weak_evidence_upset_probability_exact_and_sampled():
    # Weak evidence: value 0.2 vs 0.8, both with 5 observations.
    a_low, b_low = ta.beta_parameters(0.2, 5)   # Beta(2, 5)
    a_high, b_high = ta.beta_parameters(0.8, 5)  # Beta(5, 2)
    p_exact = exact_prob_x_greater_y(*as_int_parameters(a_low, b_low, a_high, b_high))
    assert p_exact > 0
    p = float(p_exact)
    rng = random.Random(5055)
    wins = 0
    for _ in range(N_SAMPLES):
        x_low = rng.betavariate(a_low, b_low)
        x_high = rng.betavariate(a_high, b_high)
        if x_low > x_high:
            wins += 1
    p_hat = wins / N_SAMPLES
    tol = SIGMAS * math.sqrt(p * (1.0 - p) / N_SAMPLES)
    print(
        f"upset P(low>high) n=5: theory={p:.6f} sample={p_hat:.6f} tol={tol:.6f} "
        f"(exact {p_exact})"
    )
    assert abs(p_hat - p) < tol

    # Strong evidence shrinks but never kills the upset probability: exact
    # rational comparison, no tolerance involved.
    a_low40, b_low40 = ta.beta_parameters(0.2, 40)   # Beta(9, 33)
    a_high40, b_high40 = ta.beta_parameters(0.8, 40)  # Beta(33, 9)
    p_exact40 = exact_prob_x_greater_y(
        *as_int_parameters(a_low40, b_low40, a_high40, b_high40)
    )
    print(f"upset P(low>high) n=40 exact: {float(p_exact40):.3e}")
    assert 0 < p_exact40 < p_exact
