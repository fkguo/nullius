# W6-11 Review Packet (Round-001) — SOCP scaling upgrade (x-formulation) + SCS/COSMO reliability limits

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose

This round answers the operational question: “can we use a better optimization setup to rescue solver nonconvergence (SCS/COSMO) for dispersion-coupled SOCP cross-checks?”

Deliverables under review:
1) A **numerics-only** reformulation intended to improve conditioning (no physics change): optimize directly over the cut variable $x_i\\equiv\\mathrm{Im}F(s_i)$ and enforce cones using $x_i/\\sqrt{c_{\\rm fac}(s_i)}$.
2) A **solver-attribute pass-through** knob (`numerics.solver_attributes`) so solver-specific scaling can be tuned without code edits.
3) A **negative result**: even after scaling upgrades, SCS/COSMO are still not reliable as independent “validator solvers” for this SOCP family on a laptop (either `ITERATION_LIMIT` or “OPTIMAL but violates cones” under loose tolerances).

## Key artifacts / reproduction

Code (kernel; instance repo):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/julia/bochner_k0_socp_dispersion_bounds.jl`
  - Switch formulation to `x` (ImF grid) variable with cone-scaled coupling.
  - Adds `numerics.solver_attributes` pass-through (JSON -> MOI attributes).

Scaling diagnostic (evidence bundle):
- `docs/reviews/bundles/2026-02-17-w6-11-socp-scaling-diagnostic-v1.txt`
  - Shows objective coefficient dynamic range for v15b (Q2=10) drops from ~`2.9e7` (z-formulation) to ~`2.8e1` (x-formulation).

SCS loose-tolerance run (demonstrates “status is not enough”):
- Run dir:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-17-a-bochner-k0-socp-v15b-dispersion-reF-n60-scs-q2a10-ximf-eps1e-2-v1/`
- Summary (residual audit excerpt):  
  `docs/reviews/bundles/2026-02-17-w6-11-scs-optimal-but-violates-cones-summary-v1.txt`
- Neg-result writeup:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/neg_results/2026-02-17-v15b-scs-optimal-but-violates-cones-v1.txt`
- Failure library entry appended (machine-checkable):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl`

Verification commands (PASS) + failure hook (PASS):
- `idea-generator make validate`: `docs/reviews/bundles/2026-02-17-w6-11-idea-generator-validate-v1.txt`
- `idea-runs make validate`: `docs/reviews/bundles/2026-02-17-w6-11-idea-runs-validate-v1.txt`
- `idea-runs PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project`: `docs/reviews/bundles/2026-02-17-w6-11-idea-runs-validate-project-v1.txt`
- failure hook:
  - index build: `docs/reviews/bundles/2026-02-17-w6-11-failure-library-index-build-v1.txt`
  - query run: `docs/reviews/bundles/2026-02-17-w6-11-failure-library-query-v1.txt`

## Claim under review (W6-11)

1) **Equivalence claim (numerics-only):** the x-formulation is a change of variables
   $$x_i = z_i\\,\\sqrt{c_{\\rm fac}(s_i)}$$
   applied consistently to:
   - sum rules,
   - K0 positivity,
   - dispersion PV coupling,
   - and rotated SOC constraints for (Im-only cone) and (full modulus cone).
   Therefore it should not change physics assumptions or the intended conic feasible set (up to numerical tolerances/bridges), but it improves conditioning for first-order solvers.

2) **Practical solver claim:** even with improved scaling, SCS/COSMO do not currently provide a reliable independent cross-solver validator:
   - at tighter tolerances they can hit `ITERATION_LIMIT` at feasibility;
   - at loose tolerances SCS can report `OPTIMAL` while the returned primal violates cone constraints at O(1) level (detected by our residual audit).

3) **Process claim:** the above failure is now captured as a structured negative result (failure library), so future phases do not re-attempt it blindly.

## Reviewer questions

1) Is the x-formulation implementation consistent (no missing factor of $\\sqrt{c_{\\rm fac}}$ / $1/\\pi$ / weight placement), and is the “numerics-only equivalence” claim stated conservatively enough?
2) Is the negative result (SCS “OPTIMAL but cone-violating”) documented with sufficient evidence and correct interpretation (i.e., we do **not** treat solver status as proof of feasibility)?
3) Any minimal additional instrumentation or gating you recommend before any future use of SCS/COSMO in this pipeline?
4) VERDICT: READY to proceed to the next mainline unit (Phase K scans using Clarabel primary + ECOS cross-check), treating SCS/COSMO as diagnostics only?

## Required verdict format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble, and include the strict headers required by the contract checker.

