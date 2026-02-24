# 2026-02-02 — T16: strategy-2 LEC solve (Eq.(bsol) → Table~4ch) design notes

Context: baseline paper [@recid-3109742-h-dibaryon-and-its-cousins-from-su-6-constrained-baryon-baryon-interaction](../literature/recid-3109742-h-dibaryon-and-its-cousins-from-su-6-constrained-baryon-baryon-interaction.md).

## Goal

Turn the paper’s closed-form strategy-2 expressions for $(\tilde a,\tilde b)$ (Eq.(bsol) in `main.tex`) into a deterministic runner that:

1) Computes $(\tilde a,\tilde b)$ for the two $NN$ inputs ($^3S_1$ and $^1S_0$),
2) Extracts the corresponding Table~4ch **central values** from the LaTeX source (no manual retyping),
3) Reports absolute/relative differences in `analysis.json`,
4) Optionally runs a **diagnostic** “mass fit” to quantify which $m_\Delta$ would best match the table central values under the same formula.

## Evidence-first decisions

### 1) Table parsing instead of hardcoding

- We parse Table~4ch from the local LaTeX snapshot (`references/arxiv/2601.14922/source/main.tex`), and extract only the central values for strategy-2:
  - $\tilde a$ : `-6.9` (with $a_{NN}$ in $^3S_1$), `-6.7` (with $a_{NN}$ in $^1S_0$)
  - $\tilde b$ : `-9.3`, `-8.5`
- Anchors (line numbers) are recorded in `analysis.json` so a human can cross-check quickly.

This avoids “silent drift” if we later refresh the LaTeX source snapshot.

### 2) Units: derive fm↔GeV$^{-1}$ from SI constants

- We compute $\hbar c$ in GeV·fm from exact SI definitions, then derive:
  - `fm_to_gev_inv = 1/(ħc)`
  - `gev_inv_to_fm = ħc`
- This is recorded verbatim in `analysis.json#/results/units`, so downstream W2 phases can use the same conversion without magic constants.

Code pointer: `src/hep_autoresearch/toolkit/units.py`

### 3) Mass ambiguity: do not hide it

When evaluating Eq.(bsol) using the “paper_text” mass choices (physical $m_N,m_\Delta$; lattice $m_\Omega$), the resulting $(\tilde a,\tilde b)$ differ from Table~4ch central values by O(1–2) in GeV$^{-2}$ (especially $\tilde b$).

Because the LaTeX source does not explicitly list the exact numeric masses used in the solving stage (only a qualitative statement + an $m_\Omega$ footnote), we include:

- `schemes.paper_text`: compute directly using the user-specified masses (defaults follow the text).
- `schemes.delta_fit_to_table4ch`: **diagnostic** fit of $m_\Delta$ on a fixed grid to minimize the max-abs error vs Table~4ch central values, holding $(m_N,m_\Omega, a_{NN}, a_{\Omega\Omega}, \Lambda)$ fixed.

This provides a concrete “what would need to be true” number (a fitted $m_\Delta$) without claiming it is physically correct.

## Implementation pointers

- Runner: `scripts/run_w2v1_lec_solve.py`
- Toolkit: `src/hep_autoresearch/toolkit/w2v1_lec_solve.py`
- Artifacts (example tag): `artifacts/runs/M7-w2v1-lec-r1/lec_solve/`
  - `analysis.json` includes:
    - `#/results/table4ch_strategy2` (extracted table central values)
    - `#/results/schemes/*/rows/*/outputs` (computed $(\tilde a,\tilde b,\gamma)$)
    - `#/results/schemes/*/rows/*/compare_to_table4ch_strategy2` (diffs)
    - `#/results/fit_delta` (fit metadata + best-fit $m_\Delta$)

## Regression hook

Eval case E8 asserts:
- Table~4ch central values are successfully extracted (exact match), and
- the diagnostic fit error is bounded (`max_abs_err <= 0.15`).

File: `evals/cases/E8-w2v1-lec-solve/case.json`

## Open questions / next investigation

1) Confirm the intended numeric mass inputs for Eq.(bsol) solving stage:
   - If the table is computed with a non-physical “effective” $m_\Delta$ (e.g. ensemble value / decuplet proxy), we should locate and cite the authoritative source and remove the need for a fit.
2) Decide which scheme becomes the canonical input for Phase-2/3 (scattering lengths / poles):
   - default should likely remain `paper_text`, but Phase-2/3 reproduction may require an explicit “paper-consistent mass scheme” once verified.

