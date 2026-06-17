# derivation-verify — backend-agnostic contract

Any executor (Executor 1 = Claude/Workflow-native; Executor 2 = CLI multi-backend) MUST consume this
input and produce this output, so a caller's `claims` port verbatim across executors.

## Input

```jsonc
{
  "context": "string",          // shared ground-truth equations / conventions, prepended to EVERY deriver + the comparator
  "max_iter": 3,                // optional (default 3): tie-break rounds before a claim is left unconverged; 0 disables iteration
  "claims": [
    {
      "id": "A1",               // short stable id
      "statement": "string",    // what to DERIVE BLIND — MUST NOT contain the answer
      "report_format": "string",// the exact canonical format for the answer (so derivations are comparable),
                                //   e.g. "a single rational like 2/3" or "Im A(i mu) as -pi/(4 mu)"
      "method0": "string",      // method hint for independent deriver #0 (a distinct route)
      "method1": "string"       // method hint for independent deriver #1 (a DIFFERENT distinct route)
    }
  ]
}
```

**Blindness requirement.** `statement` and `report_format` must not leak the answer; derivers receive
`context` + `statement` + their own `method` only. This is what makes the >=2 confirmations independent
rather than confirmatory.

## Per-claim algorithm (the gate)

1. **Derive (>=2, blind, method-diverse).** Spawn deriver #0 with `method0` and #1 with `method1`,
   each producing `{canonical_answer, derivation_summary, confidence}`. Derivers MAY run a CAS / numerics
   (sympy, mpmath, Julia, Mathematica) and MUST show the computation in `derivation_summary`.
2. **Compare (adjudicate by MATH equivalence, not strings).** An impartial comparator receives all
   derivations and returns `{majority_answer, majority_size, all_equivalent, outliers, correct_answer_adjudicated}`.
   It must treat e.g. `-pi/(4mu)` == `-(1/4)pi/mu`, and `(2m^2-mu^2)` (leading `-`) == `(mu^2-2m^2)`.
3. **Iterate to convergence.** While `majority_size < 2` and `rounds < max_iter`: add ONE fresh
   independent tie-break deriver (told the prior answers disagreed; instructed to ignore them and derive
   from scratch), then re-compare. Never resolve by majority of a single source — convergence requires
   `>= 2` *independent derivations* that the comparator finds mathematically equivalent. The contract
   carries exactly two method hints, so a tie-break round re-uses `method0`/`method1` (a seed-diverse,
   ignore-the-priors re-run, not a brand-new route); supply `method0`/`method1` as genuinely distinct
   routes for the strongest first pass. A dead comparator (transient backend failure) must degrade to an
   unconverged round, not crash the run.
4. A claim is **converged** iff `independent_confirmations (= majority_size) >= 2`.

## Output

```jsonc
{
  "total_claims": 0,
  "converged": 0,                       // count with independent_confirmations >= 2
  "unconverged": ["id", ...],
  "clean_first_pass": 0,                // converged with iterate_rounds == 0
  "needed_iteration": [{"claim":"id","rounds":N}],
  "matrix": [
    {
      "claim": "id",
      "converged": true,
      "independent_confirmations": 2,   // size of the agreeing cluster (>= 2 when converged)
      "total_derivations": 2,           // how many derivers ran (>= 2; more if iterated)
      "iterate_rounds": 0,
      "agreed_answer": "string",        // the majority canonical answer
      "adjudicated_correct": "string",  // the comparator's independently-recomputed correct answer + reason
      "outliers": "string"              // each non-majority derivation + its specific error, or "none"
    }
  ]
}
```

**Executor 2 extends this output (superset; Executor 1 fields all still present).** Each matrix row adds
`cross_family_confirmations` (# distinct model families in the agreeing cluster), `families` (families
that produced a derivation), and `adjudicated_matches_majority` (the R2 veto flag); the summary adds
`dropped_claims` (malformed/skipped claims). For Executor 2, `converged` means **R1 ∧ R2**:
`cross_family_confirmations >= 2` AND `adjudicated_matches_majority == true` — strictly stronger than
Executor 1's `majority_size >= 2`.

## Honesty / integrity invariants

- The leader (caller) does NOT declare convergence — the gate's `converged` flag, derived from >=2
  independent agreeing derivations, is the verdict. (Cf. the project rule "convergence-gate — no
  self-judgment".)
- Transient executor failures (rate limits, a crashed backend) must NOT count as a confirmation; the
  tie-break loop adds *successful* independent derivations until >=2 agree. Report unconverged claims
  honestly rather than padding the count.
- The comparator must recompute the contested quantity itself when adjudicating an outlier — not decide
  by vote alone.

## Executor notes

- **Executor 1 (Claude/Workflow-native, `workflows/derivation_verify.js`):** derivers/comparator are
  in-process Claude subagents (`agent()` with a JSON `schema`); "independent" = same model, distinct
  prompts/methods. Strong + fast lower bound on independence.
- **Executor 2 (CLI multi-backend, `scripts/run_multi_backend.py`, available):** derivers are separate
  CLIs (Claude/Codex/Gemini/OpenCode) via review-swarm's `run_multi_task.py` (one runner invocation per
  deriver/comparator, pinned to one model spec); "independent" = distinct model FAMILIES — the
  reliability ceiling. Same INPUT contract; output is the superset above. Convergence is stricter:
  - **R1 cross-family** — needs `>= 2` agreeing derivations from DISTINCT families (same-backend
    repeats do not count; mitigates same-model *representational collapse*).
  - **R2 adjudicator veto** — the comparator's independent recompute must match the agreeing cluster
    (`adjudicated_matches_majority`), else not converged (guards the "consensus trap").
  - **R3 diversity-first tie-break** — each round pulls an unused family first; bounded by `max_iter`
    (adaptive KS/Beta-Binomial stopping is a future enhancement).
