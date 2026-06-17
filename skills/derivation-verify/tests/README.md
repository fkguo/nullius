# derivation-verify — tests

## Smoke test (Executor 1, Claude/Workflow-native)

[`smoke_args.json`](smoke_args.json) is a minimal 2-claim input (trivial arithmetic/calculus, no domain
knowledge) that exercises the full gate end-to-end: blind derivation ×2 per claim → comparator → (no
iteration needed). Run it from Claude Code with the Workflow tool:

```
Workflow({
  scriptPath: "<repo>/skills/derivation-verify/workflows/derivation_verify.js",
  args: <contents of smoke_args.json>     # object OR JSON string both accepted
})
```

**Expected result** (re-verified 2026-06-17 on the current executor, run `wf_1cb78385-168`):

```json
{ "total_claims": 2, "converged": 2, "unconverged": [], "clean_first_pass": 2,
  "needed_iteration": [],
  "matrix": [
    { "claim": "T1_sum",  "converged": true, "independent_confirmations": 2, "agreed_answer": "42",     "outliers": "none" },
    { "claim": "T2_deriv","converged": true, "independent_confirmations": 2, "agreed_answer": "3*x^2",  "outliers": "none" }
  ] }
```

### Regression guard this catches

Passing `args` as a JSON **string** (the Workflow tool serializes complex args to a string in some
environments) previously yielded `total_claims: 0` with **no agents spawned** — the gate silently did
nothing. The executor now parses a string `args`; this smoke test fails (0 claims) if that regresses.

## Executor 2 (CLI multi-backend)

`scripts/run_multi_backend.py` is a planned stub (raises `NotImplementedError`); no live test yet. When
implemented it must reproduce the same matrix on `smoke_args.json` using >=2 distinct model backends.
