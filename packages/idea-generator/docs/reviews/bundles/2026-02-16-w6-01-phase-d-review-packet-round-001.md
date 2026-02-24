# W6-01 Phase D Review Packet (Round 001) — D0 Spectral LP v2 + Report/Island Updates

## Scope

This packet reviews the **Phase D (mainline, in-progress)** incremental deliverable for the pion-only, no-coupled-channel bootstrap campaign:

- A reproducible **LP-based envelope solver** for the D0 ($I=0,\ell=2$ / $2^{++}$) spectral density $\rho_2^0(s)$, using:
  - spectral-density parameterization pattern (arXiv:2505.19332),
  - SVZ moment targets quoted in arXiv:2403.10772,
  - pointwise positivity on a grid,
  - LP (SciPy HiGHS; no SDPB required).
- Run outputs and a first write-up in the single manuscript-style report (`NOT_FOR_CITATION`).
- Island progress stream updated (append-only, schema-validated).

Hard constraints to enforce:
- pion-only
- **no coupled-channel**
- laptop-only
- evidence-first + reproducible (commands/logs/outputs)

## Deliverables Added/Updated

### New numerics run (reproducible)

Project: `idea-runs/projects/pion-gff-bootstrap-positivity-pilot-2026-02-15`

- Run directory (v2): `runs/2026-02-16-d0-spectral-lp-v2/`
  - `results.json` (envelopes)
  - `config.json` (snapshot)
  - `log.txt` (includes `rho_min_min`)
  - `rho_envelope.png`
  - `F_abs_upper.png`

### Code + config

- `compute/d0_spectral_lp.py`
  - Refuses to overwrite non-empty run directories.
  - Adds a negativity sanity check (fail-fast if $\rho_{\min}$ is significantly negative).
- `compute/d0_spectral_lp_config_v1.json`

### Report and indices

- Report updated with method + reproduction + results + limitations:
  - `reports/draft.md`
- Evidence index updated:
  - `evidence/index.md`
- Island progress stream appended:
  - `artifacts/islands/idea_island_progress_v1.jsonl`

## Key Numerical Summary (v2)

From `runs/2026-02-16-d0-spectral-lp-v2/results.json`:
- scan grid: 80 points on $s\in[4+10^{-6},\,212]$
- $\min \rho_{\min}(s)\approx -6.1\times 10^{-16}$ (solver tolerance; effectively non-negative)
- $\max \rho_{\max}(s)\approx 2.3771$ (so $\max \sqrt{\rho_{\max}}\approx 1.5418$)
- derived $|F(s)|$ upper envelope range (conservative): $\sim 6.6$ to $\sim 1.27\times 10^2$

Summary artifact (generated from results):
- `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-d0-spectral-lp-v2-summary-v1.txt`

## Reproduction

From project root:
```bash
python3 compute/d0_spectral_lp.py
```

## Verification Commands + Evidence (PASS)

Board sync check:
- `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-board-sync-check-v1.txt`

Gates:
- `idea-generator`: `make validate`
  - `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-idea-generator-validate-v1.txt`
- `idea-runs`: `make validate`
  - `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-idea-runs-validate-v1.txt`
- `idea-runs`: `PROJECT=projects/pion-gff-bootstrap-positivity-pilot-2026-02-15 make validate-project`
  - `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-idea-runs-validate-project-v1.txt`
- failure library hook:
  - `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-failure-library-index-build-v1.txt`
  - `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-failure-library-query-run-v1.txt`

LP run evidence:
- `idea-generator/docs/reviews/bundles/2026-02-16-w6-01-phase-d-d0-spectral-lp-v2-run-v1.txt`

## Review Focus

1) **Constraint correctness**: Is the LP formulation consistent with the stated inequality ($\rho \ge |\mathcal{F}|^2$) and moment constraints as *quoted*?
2) **Auditability**: Are reproduction steps + outputs sufficient to support later tightening (Phase D mainline)?
3) **Scope discipline**: Any hidden coupled-channel leakage or non-pion drift?
4) **Next step readiness**: Is this deliverable READY to proceed to the next Phase D unit (mainline bound selection + tighter constraints, possibly adding $S$/$\eta(s)$ envelope)?

## Required Verdict Format

First line must be exactly `VERDICT: READY` or `VERDICT: NOT_READY`, with no preamble.

