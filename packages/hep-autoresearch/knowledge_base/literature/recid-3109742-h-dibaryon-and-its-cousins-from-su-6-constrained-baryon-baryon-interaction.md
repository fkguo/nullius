# $H$ dibaryon and its cousins from SU(6)-constrained baryon-baryon interaction — Hu, Guo (2026)

RefKey: recid-3109742-h-dibaryon-and-its-cousins-from-su-6-constrained-baryon-baryon-interaction
INSPIRE recid: 3109742
Citekey: Hu:2026pyr
Authors: Hu, Guo
Publication: arXiv:2601.14922 [nucl-th]
Links:
- INSPIRE: https://inspirehep.net/literature/3109742
- arXiv: https://arxiv.org/abs/2601.14922

## Key points (to fill)

- Problem: Use SU(6) symmetry in LO nonrelativistic EFT to constrain $S$-wave baryon-baryon interactions; apply to $S=-2$ sector relevant for the $H$ dibaryon.
- Model: LO Lagrangian has two independent low-energy constants (LECs) $\tilde a,\tilde b$.
- Inputs to fix LECs: physical $NN$ scattering lengths + lattice-QCD $\Omega\Omega$ scattering length (HAL QCD).
  - $a_{NN}$: $^3S_1$ channel $5.4112(15)$ fm; $^1S_0$ channel $-23.7148(43)$ fm (Hackenburg 2006; see arXiv source).
  - $a_{\Omega\Omega}$ ($^1S_0$): $4.6(6)_\text{stat}(^{+1.2}_{-0.5})_\text{sys}$ fm (HAL QCD; see arXiv source).
- Strategy 2 provides explicit closed-form expressions for $\tilde a,\tilde b$ (Eq. (bsol) in the arXiv LaTeX source).
- Main qualitative outputs:
  - Two bound states below the $\Lambda\Lambda$ threshold (one deep, one shallow).
  - Two dominant resonance poles near the $\Sigma\Sigma$ and $\Sigma^*\Sigma^*$ thresholds.
  - Distinct signatures in $\Lambda\Lambda$ invariant-mass distributions (peak near threshold; cusp/dip near higher thresholds).

Local source pointers (snapshotted):
- INSPIRE JSON snapshot: [references/inspire/recid-3109742/literature.json](../../references/inspire/recid-3109742/literature.json)
- arXiv LaTeX source: [references/arxiv/2601.14922/source/main.tex](../../references/arxiv/2601.14922/source/main.tex)

Reproduction targets (W2 v1 candidate):
- Recompute $\tilde a,\tilde b$ at cutoff $\Lambda=1.0$ GeV for strategy 2 with $a_{NN}$ in $^3S_1$:
  - Table “Solved LECs…” (Table~4ch in LaTeX): $\tilde a \approx -6.9$ GeV$^{-2}$, $\tilde b \approx -9.3$ GeV$^{-2}$ (central values).
- Reproduce the four dominant poles and couplings in strategy 2 (Table~ES2 in LaTeX), at cutoff $\Lambda=1.0$ GeV.
- Optional later: reproduce the $\Lambda\Lambda$ invariant-mass lineshape feature (peak around 2246 MeV reported in text).

## Skepticism / checks to do

- What is the minimal falsifiable claim for us?
  - Given the same inputs (scattering lengths, masses, cutoff), we can reproduce Table~4ch (LECs + scattering lengths) and Table~ES2 (dominant pole positions/couplings) within declared tolerances.
- Unit/normalization traps to check early:
  - fm $\leftrightarrow$ GeV$^{-1}$ conversion (do not silently mix).
  - Scattering-length sign convention: they define $a_i=-\lim_{p_i\to 0} \mu_i T_{ii}/(2\pi)$ (see arXiv source).
  - Strategy-2 mass choices: uses physical $m_N,m_\Delta$ and lattice $m_\Omega=1712$ MeV when solving LECs; later uses physical baryon masses in Green’s functions.
- Numerical method traps to check:
  - Pole finding across Riemann sheets (branch choices, sheet labeling).
  - Cutoff scan $\Lambda\in[0.5,2.0]$ GeV and behavior near unitarity crossing ($\Lambda\approx 0.72$ GeV for $a_{\Lambda\Lambda}$ in strategy 2).

Verification status: W4 spec + W2 v1 Phase-1/2 implemented (LECs + Table~4ch scattering lengths computed; end-to-end vs table differences recorded; mass-input ambiguity noted)
What was checked:
- metadata (title/authors/links)
- arXiv LaTeX source snapshot exists (tables/equations available locally)
