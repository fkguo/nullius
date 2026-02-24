# W6-08 Review Packet (Round-002) — Q* dual-audit (v19) + Erratum on “identical program” + tail-const provenance check

NOT_FOR_CITATION. Tools disabled for reviewers.

## Purpose (address W6-08 Round-001 Opus blockers)

Round-001 Opus flagged 4 blockers (B1–B4). This packet closes them by:

1) **Reframing**: we no longer claim a *rigorous* “dual certificate”. We instead claim a **dual-audit**: independently recomputed dual objective + stationarity/cone sanity checks + explicit residual quotes.  
2) **Erratum**: we retract the “ECOS runs the identical conic program as Clarabel” wording; solver-dependent MOI bridges can change the inner form.  
3) **Tail constant provenance**: we quote the code-level integral that defines `tail_const_analytic(Q^*)` and provide an independent high-precision numerical cross-check.  
4) **Residual accounting**: we explicitly acknowledge the small negative SOC margin at $Q^*$ for v19 Clarabel and place it alongside the full-grid worst-case residuals (v18).

## Key artifacts / reproduction

Kernel:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/julia/bochner_k0_socp_dispersion_bounds.jl`
  - Tail integrals: `compute_tail_integrals` (includes `I_obj_tail[Q^2] = (1/\\pi)\\int Im\\_tail(s)/(s+Q^2)\\,ds` discretized by logspace + trapz)
  - Q* single-point dual-audit runs: v19 (Clarabel + ECOS)

Reference full-grid run (defines $Q^*$ on the probe grid; includes per-solve residuals):
- v18 (Clarabel; full Q2 grid):  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-socp-v18-dispersion-grid200-enf200-full-resaudit/`

Q* single-point dual-audit runs (v19; same JSON config intent; inner conic form may differ due to solver bridges — see Erratum):
- v19 Clarabel:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-socp-v19-dispersion-grid200-enf200-qstar-dualcert-clarabel/`
- v19 ECOS:  
  `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/runs/2026-02-16-a-bochner-k0-socp-v19-dispersion-grid200-enf200-qstar-dualcert-ecos/`

Auditable summaries / evidence:
- Dual-audit summary (v19): `docs/reviews/bundles/2026-02-17-w6-08-v19-qstar-dual-audit-summary-v2.txt`
- Erratum (solver-input non-identity): `docs/reviews/bundles/2026-02-17-w6-08-erratum-v19-not-identical-v1.txt`
- Inner-model stats + fingerprint (v19):  
  `docs/reviews/bundles/2026-02-16-w6-08-v19-inner-model-stats-v1.txt`  
  `docs/reviews/bundles/2026-02-16-w6-08-v19-inner-fingerprint-v1.txt`
- Tail-const high-precision cross-check (mpmath @ 80 dps): `docs/reviews/bundles/2026-02-16-w6-09-tail-const-mpmath-check-v1.txt`
- Full-grid worst-case residuals (v18): `docs/reviews/bundles/2026-02-16-w6-07-v18-residual-worstcase-v1.txt`

## Claim under review (updated phrasing)

Under the explicit single-channel assumptions encoded in v18/v19, the **contiguous positivity endpoint on the v18 probe grid** is
$$Q^*=15.438084455604\\,m_\\pi^2,$$
and the computed lower bound at that grid point is **numerically positive**.

We *do not* claim a rigorous “dual certificate”. Instead, we claim:
- a **primal value** (objective + tail constant) is positive, and
- an **independently recomputed dual objective** (plus the same tail constant) is consistent with the solver-reported dual objective to within numerical residuals,
- with explicit stationarity/cone checks and residual quotes.

## Q* numbers (v19; quoted)

Definition used in v19 runs:
$$A_{\\min}(-Q^2)=\\texttt{objective\\_value}(Q^2)+\\texttt{tail\\_const\\_analytic}(Q^2).$$

Dual-audit identity used (numerical audit, not a rigorous certificate):
$$A_{\\min}^{\\rm dual\\text{-}audit}(-Q^2)=\\texttt{dual\\_obj\\_recomputed}(Q^2)+\\texttt{tail\\_const\\_analytic}(Q^2).$$

From `docs/reviews/bundles/2026-02-17-w6-08-v19-qstar-dual-audit-summary-v2.txt`:
- v19 Clarabel at $Q^*$:
  - $A_{\\min}^{\\rm primal}=0.007284756916$
  - $A_{\\min}^{\\rm dual\\text{-}audit}=0.007284753671$
  - stationarity: `3.388e-07`, dual-cone violations: `0`
- v19 ECOS at $Q^*$ (robustness probe; not identical inner conic form):
  - $A_{\\min}^{\\rm primal}=0.018103849010$
  - $A_{\\min}^{\\rm dual\\text{-}audit}=0.018103849115$
  - stationarity: `4.268e-06`, dual-cone violations: `0`

## Addressing Round-001 Opus blockers

### B1. “Dual certificate” rigor gap → reframe to “dual-audit”

- We keep the **independent dual objective recomputation** (`dual_obj_recomputed`) and explicitly quote:
  - `stationarity_inf_norm`
  - `dual_cone_violations`
  - `dual_cone_min_margin`
- But we **drop the word “certified”** and do not assert strict dual feasibility / rigorous error-to-bound conversion.

Rationale: with JuMP/MOI + floating-point solvers, residual control is an audit trail, not a proof. The current evidence supports *numerical positivity on the probe grid* with auditable diagnostics.

### B2. Clarabel vs ECOS spread → diagnosed as solver-dependent MOI bridging (not “identical program”)

We retract the “identical conic program” statement.

Evidence (v19) shows the solver-input representations differ:
- model stats differ: `docs/reviews/bundles/2026-02-16-w6-08-v19-inner-model-stats-v1.txt`
- fingerprints differ (SHA256 mismatch): `docs/reviews/bundles/2026-02-16-w6-08-v19-inner-fingerprint-v1.txt`
- erratum: `docs/reviews/bundles/2026-02-17-w6-08-erratum-v19-not-identical-v1.txt`

We therefore treat ECOS as a **robustness probe** (same physics inputs + same discretization intent), not as a strict identical-program cross-solver certificate.

### B3. `tail_const_analytic` provenance → code-level definition + independent check

In the kernel (`compute_tail_integrals`), the tail model is `pQCD_2412_imF` and:
- the UV tail uses $s\\in[s_{\\max}, s_{\\max}\\cdot\\texttt{s\\_max\\_multiplier}]$ discretized in logspace with trapz weights,
- and the objective tail constant is:
$$\\texttt{tail\\_const\\_analytic}(Q^2)=\\frac{1}{\\pi}\\int_{s_{\\max}}^{s_2}\\frac{\\mathrm{Im}_{\\rm tail}(s)}{s+Q^2}\\,ds,$$
implemented as `I_obj_tail[q2] = sum(w_tail .* (Im_tail ./ (s_tail .+ q2))) / PI`.

Independent numerical cross-check (mpmath, 80 dps) at $Q^*$:
- `docs/reviews/bundles/2026-02-16-w6-09-tail-const-mpmath-check-v1.txt`
  - `tail_const_mpmath = -0.011306174539567...`
  - (compare to v19/v18 `tail_const_analytic = -0.011306175355874644` → agreement at ~`8e-10` level)

### B4. Negative SOC margin at $Q^*$ (Clarabel v19) → explicitly acknowledged

At $Q^*$, v19 Clarabel has `soc_min_margin = -1.961e-10` (see summary v2). We treat this as a small numerical feasibility violation (audit trail), not as a proof-level certificate. For context, the full-grid v18 worst-case residuals include similarly small margin violations:
- `docs/reviews/bundles/2026-02-16-w6-07-v18-residual-worstcase-v1.txt`

## Reviewer questions

1) With the explicit **reframing** (“dual-audit” not “dual certificate”) + **erratum** on solver-input non-identity, are there any remaining blockers to mark this stage `VERDICT: READY`?  
2) Is the evidence bundle sufficient for auditability (explicit residual quotes + tail-const cross-check + model-stats/fingerprint)?  
3) Any minimal additional instrumentation you recommend before we proceed to the next W6-01 phase?
