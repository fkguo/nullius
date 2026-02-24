# W6-37 Review Packet (Round-001) — full-PSD SDP fail-closed + retry audit (trace $\hat\Theta^\pi$, S0)

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

Close a critical robustness gap in the tightening-island full-PSD SDP pathway:

- In W6-36, SCS can fail at an **interior** $Q^2$ point (e.g. $Q^2=2\,\mathrm{GeV}^2$) with `ITERATION_LIMIT` / `ALMOST_DUAL_INFEASIBLE`, producing `nan` in the reported band arrays.
- This must be treated as a **hard failure** (fail-closed), and we need auditable retry diagnostics to avoid wasting laptop time.

This increment is explicitly **tooling/robustness**, not a physics tightening claim (S-matrix constraints are still disk-only placeholder).

## Baseline failure mode (reference)

Existing run showing the silent-NaN hazard:

- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-21-theta-trace-s0-sdp-fullpsd-smoke-grid80-enf6-q2grid2-audit12-scs-eps1e-4-tuned-pqcdTh-anchorbudget-derived-bind-smatrix-placeholder/results.json`
  - at `Q2_mpi2≈102.6705` ($Q^2=2\,\mathrm{GeV}^2$): `min_status=ITERATION_LIMIT`, `max_status=ALMOST_DUAL_INFEASIBLE`, and the band contains `nan`.

## Changes in this increment (W6-37)

### 1) Kernel: retry ladder + attempts audit + fail-closed objectives

File:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/julia/theta_trace_s0_sdp_fullpsd_dispersion_bounds.jl`

Behavior:
- New config knob: `numerics.retry_policy` (optional).
- Each $(Q^2,\min/\max)$ solve is executed via a retry ladder:
  - attempts recorded under `results.json["results"]["solver_status"][i]["min_attempts"/"max_attempts"]` with `(max_iter, eps_abs/rel, termination_status, diag)`.
- **Fail-closed**: if any objective fails to reach OPTIMAL-like termination, the run:
  - writes `results.json` with `results.error`,
  - writes `log.txt` starting with `FAIL: ...`,
  - exits non-zero.

Warm-start policy:
- Cross-$Q^2$ warm-start defaults to **off** for SCS (can be enabled via `retry_policy.use_cross_q2_warm_start=true`).
- Within a retry ladder, best-effort start values from the last available iterate are used.

### 2) New configs + reruns

Configs (project-local):
- COSMO reference:
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/theta_trace_s0_sdp_fullpsd_config_smoke_grid80_enf6_q2grid2_audit13_cosmo_eps1e-4_pqcdTh_anchorbudget_derived_bind_smatrix_placeholder.json`
- SCS retry attempts (expected to fail-closed on this instance):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/theta_trace_s0_sdp_fullpsd_config_smoke_grid80_enf6_q2grid2_audit13_scs_retry_pqcdTh_anchorbudget_derived_bind_smatrix_placeholder.json`
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/theta_trace_s0_sdp_fullpsd_config_smoke_grid80_enf6_q2grid2_audit14_scs_retry_nowarm_pqcdTh_anchorbudget_derived_bind_smatrix_placeholder.json`

Run outputs:
- COSMO (success + plots):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-21-theta-trace-s0-sdp-fullpsd-smoke-grid80-enf6-q2grid2-audit13-cosmo-eps1e-4-pqcdTh-anchorbudget-derived-bind-smatrix-placeholder/Theta_hat_band_Q2_GeV2_0to2_zoom.png`
- SCS (FAIL, but now auditable; no silent NaNs consumed downstream):
  - `.../runs/2026-02-21-theta-trace-s0-sdp-fullpsd-smoke-grid80-enf6-q2grid2-audit13-scs-retry-pqcdTh-anchorbudget-derived-bind-smatrix-placeholder/results.json`
  - `.../runs/2026-02-21-theta-trace-s0-sdp-fullpsd-smoke-grid80-enf6-q2grid2-audit14-scs-retry-nowarm-pqcdTh-anchorbudget-derived-bind-smatrix-placeholder/results.json`

### 3) Documentation

- New evidence note:
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-21-w6-37-fullpsd-sdp-failclosed-retry-v1.md`
- Draft report updated (W6-37 bullet):
  - `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md`
- SSOT tracker updated:
  - `docs/plans/2026-02-12-implementation-plan-tracker.md` (W6-37 row + Update Log entry)

## Verification receipts (gates/hooks)

- `docs/reviews/bundles/2026-02-21-w6-37-idea-generator-validate-v1.txt`
- `docs/reviews/bundles/2026-02-21-w6-37-idea-runs-validate-v1.txt`
- `docs/reviews/bundles/2026-02-21-w6-37-idea-runs-validate-project-v1.txt`
- `docs/reviews/bundles/2026-02-21-w6-37-failure-library-index-build-v1.txt`
- `docs/reviews/bundles/2026-02-21-w6-37-failure-library-query-run-v1.txt`

Board preflight snapshot (no post-update yet in this round):
- `docs/reviews/bundles/2026-02-21-w6-37-board-sync-preflight-v1.txt`

## Reviewer questions (Round-001)

1) Is the **fail-closed** behavior correct and appropriately scoped (objective failures abort the run), given we want to prevent partial/`nan` artifacts from leaking into downstream claims?
2) Is the `numerics.retry_policy` interface/semantics sufficiently auditable, and are the logged attempt fields adequate for diagnosing solver issues without tools?
3) Any concerns with the default warm-start behavior (cross-$Q^2$ warm-start off for SCS)?
4) Given SCS still fails for the **max** objective at $Q^2=2\,\mathrm{GeV}^2$ even after retries, is it acceptable to proceed with **COSMO as primary** for the full-PSD SDP pathway under laptop budget, keeping SCS only as an optional/coarse smoke cross-check? Any minimal additional guardrails needed before moving to the real tightening step (He/Su-style internal $S(s)$ constraints as halfspaces/regions)?

