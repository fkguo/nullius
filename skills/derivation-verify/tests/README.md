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

## Executor 2 (CLI multi-backend) — offline unit suite

[`test_run_multi_backend.py`](test_run_multi_backend.py) exercises the gate's PURE logic + orchestration
with an **injected mock runner** — NO real CLI backends are spawned, so it is fast, deterministic, and
CI-safe. Run:

```
python3 -m pytest skills/derivation-verify/tests/test_run_multi_backend.py -q
```

It locks: cross-family convergence (R1), adjudicator veto (R2), diversity-first tie-break (R3), robust
JSON extraction from noisy CLI text (incl. Gemini startup noise + JSON-in-prose), and "a dead comparator
degrades the claim to unconverged, never crashes the matrix".

### Real cross-model smoke (manual; needs authed CLIs, slow/costly — not in CI)

```
python3 skills/derivation-verify/scripts/run_multi_backend.py \
  --claims skills/derivation-verify/tests/smoke_args.json \
  --backends claude/default,codex/default,gemini/default,opencode/default \
  --comparator codex/default --out /tmp/dv2_matrix.json
```

Expect `2/2 converged` with each row showing `cross_family_confirmations >= 2`. The mechanical
subprocess/arg/output-parsing path (everything the unit mock stubs) is validated against a fake runner;
a real run additionally validates the live model behaviour.
