# 2026-02-02 — T18: Table~4ch scattering lengths (strategy-2) implementation notes

Baseline paper: [@recid-3109742-h-dibaryon-and-its-cousins-from-su-6-constrained-baryon-baryon-interaction](../literature/recid-3109742-h-dibaryon-and-its-cousins-from-su-6-constrained-baryon-baryon-interaction.md)

## Goal

Implement the paper’s coupled-channel scattering-length computation in a deterministic, audit-friendly way:

- potential matrix $V(\tilde a,\tilde b)$ (Eq.(V))
- Green’s function $G_i=-(\mu_i/(2\pi))(\Lambda+i p_i)$ (Eq.(G))
- $T(E)=-(V^{-1}-G(E))^{-1}$
- scattering length definition: $a_i=-\lim_{p_i\to 0} (\mu_i T_{ii})/(2\pi)$

and compare the resulting strategy-2 central values to Table~4ch.

## Implementation choices

### 1) Inputs are explicit and auditable

- LEC inputs are read from the Phase-1 artifacts:
  - `artifacts/runs/M7-w2v1-lec-r1/lec_solve/analysis.json`
- Table~4ch strategy-2 scattering-length central values are parsed directly from `main.tex` (no retyping).
- Physical baryon masses for the Green’s function are provided as explicit CLI parameters with reasonable defaults (isospin-averaged approximations).

Runner: `scripts/run_w2v1_scattering_lengths.py`

### 2) Decompose “does the math work?” vs “do we match the paper end-to-end?”

The output includes two computed blocks:

- `computed.table4ch_lecs`: uses the **rounded** $(\tilde a,\tilde b)$ from the Table~4ch LEC rows as input, then computes scattering lengths. This isolates the Eq.(V)/Eq.(G)/matrix-inversion pipeline.
- `computed.lec_run:<scheme>`: uses LECs computed by Phase-1 Eq.(bsol) solver (currently we regress the `delta_fit_to_table4ch` scheme) and computes scattering lengths. This is the end-to-end check.

### 3) Rounding sensitivity (notably for $a_{\Lambda\Lambda}$ in the 1S0 column)

Table~4ch reports $(\tilde a,\tilde b)$ to only one decimal place, but $a_{\Lambda\Lambda}$ can be extremely sensitive to small changes in $\tilde a$ near a unitarity crossing.

Consequence:
- The 3S1 column is stable and used as the primary regression target (E9).
- The 1S0 column is computed and recorded, but not used as a strict regression gate yet (until we confirm unrounded inputs / exact mass choices).

## Artifacts

- Run tag: `M8-w2v1-scattlen-r1`
- Directory: `artifacts/runs/M8-w2v1-scattlen-r1/scattering_lengths/`
- Key JSON pointers:
  - Table extraction: `analysis.json#/results/table4ch_strategy2_scattering_lengths`
  - End-to-end comparison: `analysis.json#/results/computed/lec_run:delta_fit_to_table4ch/3S1/compare/max_abs_err_vs_table4ch`

## Regression hook

- Eval case: `evals/cases/E9-w2v1-scattering-lengths/case.json`
- Gate: bound the max-abs error for the **strategy-2, NN(3S1)** column at cutoff $\Lambda=1.0$ GeV.

## Open questions

1) Confirm the exact mass inputs used in the LEC solving stage (Phase-1) so that the cutoff-scan diagnostic can reproduce the paper’s unitarity crossing location (e.g. $\Lambda\approx 0.72$ GeV for 3S1).
2) Decide whether to switch Phase-2’s default to “table-consistent unrounded LECs” once we have an authoritative source (or reproduce them via Eq.(bsol) with verified mass inputs).

