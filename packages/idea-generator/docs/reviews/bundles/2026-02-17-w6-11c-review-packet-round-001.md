# W6-11c Review Packet (Round-001) — SCS tuned retry still ITERATION_LIMIT + persist feasibility-failure artifacts

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

This round answers two operational questions:

1) **Solver question:** after the W6-11 x-formulation scaling upgrade, can an SCS “tuned” configuration (eps=1e-3 + normalize/scale knobs) reach approximately-feasible behavior suitable for third-solver cross-checks?
2) **Tooling question:** if feasibility fails (`ITERATION_LIMIT`, etc.), do we still write an auditable run directory (config/results/log) so negative results are reproducible and queryable?

## Deliverables under review

1) New SCS tuned config for v15b single-point test (Q2=10):
   - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2b_dispersion_n60_scs_q2a10_ximf_tuned_eps1e-3.json`

2) Kernel hardening: persist run artifacts even on feasibility failure:
   - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/julia/bochner_k0_socp_dispersion_bounds.jl`
   - Behavior change: create `runs/<slug>/` + write `config.json`, and on non-OPTIMAL feasibility write `results.json` + `log.txt` then raise an error.

3) New negative result + machine-checkable reuse:
   - Neg-result writeup: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/neg_results/2026-02-17-v15b-scs-tuned-eps1e-3-iteration-limit-v1.txt`
   - Failed-approach append-only record: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl`
   - Island progress event: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/islands/idea_island_progress_v1.jsonl`

## Key artifacts / reproduction

SCS tuned run (v15b, Q2=10):
- Config:
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v2b_dispersion_n60_scs_q2a10_ximf_tuned_eps1e-3.json`
- Run dir (now persisted even on failure):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-17-a-bochner-k0-socp-v15b-dispersion-reF-n60-scs-q2a10-ximf-tuned-eps1e-3-v1/`
- Summary evidence (termination + feasibility residuals):
  - `docs/reviews/bundles/2026-02-17-w6-11c-scs-tuned-iteration-limit-summary-v1.txt`

Verification commands (PASS) + failure hook (PASS):
- `idea-generator make validate`: `docs/reviews/bundles/2026-02-17-w6-11c-idea-generator-validate-v1.txt`
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-17-w6-11c-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project`:
  `docs/reviews/bundles/2026-02-17-w6-11c-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-17-w6-11c-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-17-w6-11c-failure-library-query-run-v1.txt`

## Claims under review (W6-11c)

1) **Solver claim (negative):** SCS tuned scaling/normalization still does **not** reach usable feasibility for this SOCP instance on laptop (termination `ITERATION_LIMIT` and large negative SOC/modulus margins in feasibility residual audit). Therefore SCS remains diagnostics-only unless it converges and passes explicit residual gates.

2) **Tooling claim:** persisting run artifacts on feasibility failure is a safe, evidence-first improvement:
   - does not change physics assumptions;
   - does not weaken success-path gates;
   - strengthens negative-result provenance (config/results/log always exist for failed feasibility runs).

## Reviewer questions

1) Is the kernel hardening implemented safely (no risk of overwriting run dirs; success path unchanged; failure results schema still valid JSON)?
2) Is the solver conclusion stated at the right strength (we do not overgeneralize beyond the tested instance)?
3) Any minimal extra diagnostics you recommend capturing for `ITERATION_LIMIT` feasibility runs (e.g., iteration count, primal/dual residual norms if available)?
4) VERDICT: READY to proceed with the next mainline unit treating SCS/COSMO as diagnostics-only and relying on Clarabel(primary)+ECOS(cross-check)?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.
