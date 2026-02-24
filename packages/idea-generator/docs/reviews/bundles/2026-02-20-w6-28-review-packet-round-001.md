# W6-28 Review Packet (Round-001) — derive UV/ASR budget $\rightarrow$ binding $\rightarrow$ rerun to $Q^2=2\,\mathrm{GeV}^2$

NOT_FOR_CITATION. Tools disabled for reviewers.

## What is new in W6-28 (vs W6-26)?

W6-26 introduced a **UV/ASR budget artifact + gate**, but the budget was explicitly a **placeholder** supporting the prior tightened-stack band (soft ASR band tol$_{\rm ASR}=62$ + slope input).

W6-28 replaces the placeholder with a **machine-checkable derived UV/ASR budget** and enables **binding mode** so that the ASR tolerance is no longer hand-tuned, then reruns the $Q^2\in[0,2]\,\mathrm{GeV}^2$ band under binding.

This increment is intentionally “evidence-first”, even if the result is negative: the prior tightening is shown to rely on UV slack that is not accounted for by the derived UV-tail budget.

Scope remains pion-only; no coupled-channel.

## Derived UV/ASR budget (now the binding target)

Updated project artifact:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/assumptions/uv_asr_budget_v1.json`

Key fields (solver convention: $(1/\pi)\int ds\,\mathrm{Im}A(s)$ in $m_\pi^2$ units):
- `budget_mode=derived`
- `asr_target_mpi2=0`
- `asr_absolute_tolerance_mpi2=18.025175458263533`

Named budget components (absolute contributions, in $m_\pi^2$ units):
- cutoff remainder proxy: 2.9091230847368
- higher-order proxy: 4.762838446740632
- matching/DA normalization proxy: 9.223148555865038
- onset-window proxy: 1.1300653709210629

Interpretation note recorded in the artifact: this is a **pQCD-tail budget**, not a full OPE budget.

## Binding configs + new runs

Binding is activated by:
- `constraints.sum_rules.asr_budget_binding=true`
- `constraints.sum_rules.asr_absolute_tolerance = asr_absolute_tolerance_mpi2` (from the artifact)

### (A) Binding + slope enforced $\Rightarrow$ infeasible

Configs:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4cck_dispersion_grid200_enf200_multiq0to2gev_audit10_clarabel_asrbinding_uvbudget_derived_slope_tmd.json`
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4ccl_dispersion_grid200_enf200_q2_2gev_audit10_ecos_asrbinding_uvbudget_derived_slope_tmd.json`

Runs:
- Clarabel: `.../runs/2026-02-20-a-bochner-k0-socp-v112-dispersion-grid200-enf200-multiq0to2gev-audit10-clarabel-asrbinding-uvbudget-derived-slope-tmd/results.json` (INFEASIBLE)
- ECOS: `.../runs/2026-02-20-a-bochner-k0-socp-v113-dispersion-grid200-enf200-q2-2gev-audit10-ecos-asrbinding-uvbudget-derived-slope-tmd/results.json` (INFEASIBLE)

### (B) Binding + slope not enforced; implied-$f_1$ diagnostic; rerun band

Configs:
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4ccm_dispersion_grid200_enf200_multiq0to2gev_audit10_clarabel_asrbinding_uvbudget_derived_impliedf1.json`
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/compute/a_bochner_k0_socp_config_v4ccn_dispersion_grid200_enf200_q2_2gev_audit10_ecos_asrbinding_uvbudget_derived_impliedf1.json`

Runs:
- Clarabel: `.../runs/2026-02-20-a-bochner-k0-socp-v114-dispersion-grid200-enf200-multiq0to2gev-audit10-clarabel-asrbinding-uvbudget-derived-impliedf1/results.json` (OPTIMAL/OPTIMAL)
  - Plot: `.../runs/2026-02-20-a-bochner-k0-socp-v114-dispersion-grid200-enf200-multiq0to2gev-audit10-clarabel-asrbinding-uvbudget-derived-impliedf1/A_band_Q2_GeV2_0to2.png`
- ECOS: `.../runs/2026-02-20-a-bochner-k0-socp-v115-dispersion-grid200-enf200-q2-2gev-audit10-ecos-asrbinding-uvbudget-derived-impliedf1/results.json` (OPTIMAL/OPTIMAL)

Selected endpoint numbers at $Q^2=2\,\mathrm{GeV}^2$ ($Q^2/m_\pi^2\simeq 102.670538$):

| solver | $A_{\min}$ | $A_{\max}$ | status |
|---|---:|---:|---|
| Clarabel (v114) | -0.0647197417 | 0.3341474164 | OPTIMAL/OPTIMAL |
| ECOS (v115) | -0.0589916901 | 0.3268170096 | OPTIMAL/OPTIMAL |

Implied slope diagnostic under binding (from v114 `results.json`):
- $f_1\in[0.01693,0.34456]$

This excludes the previously used TMD/ChPT target $f_1\simeq 0.01198$ and explains infeasibility when that slope input is enforced under binding.

## Evidence note + manuscript update + negative-result record

Evidence note (repro commands + interpretation):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/evidence/2026-02-20-w6-28-uv-asr-budget-binding-rerun-v1.md`

Failure library update (machine-checkable negative result):
- appended to `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/artifacts/ideas/failed_approach_v1.jsonl`

Manuscript updated (adds W6-28 bullet in limitations list):
- `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15/reports/draft.md`

## Gates executed (PASS)

- `docs/reviews/bundles/2026-02-20-w6-28-idea-generator-validate-v1.txt`
- `docs/reviews/bundles/2026-02-20-w6-28-idea-runs-validate-v1.txt`
- `docs/reviews/bundles/2026-02-20-w6-28-idea-runs-validate-project-v1.txt`
- `docs/reviews/bundles/2026-02-20-w6-28-failure-library-index-build-v1.txt`
- `docs/reviews/bundles/2026-02-20-w6-28-failure-library-query-run-v1.txt`

## Questions for reviewers

1) Is the **derived-budget binding** setup and gate behavior correct and fail-closed (no hidden knob remains)?
2) Is it acceptable to mark W6-28 as `READY` as a research increment even though it **weakens** the prior tightened band (because it corrects a methodology/assumption gap)?
3) What is the **minimum next evidence** needed to close the “UV/OPE budget” gap (e.g., literature-backed pQCD/OPE remainder estimate, or an explicit sensitivity island over the tail model), before we revisit slope-tightening?

