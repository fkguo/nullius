# M0 — Style sources (representative files opened)

This is a minimal “audit trail” of representative `.tex` sources (sampled from the corpus listed in `assets/style/style_profile.md`) that were manually inspected to extract writing/voice conventions. It is not an exhaustive corpus dump.

- `<local_overleaf_root>/Jpsipi_JpsiK/Jpsipi_v1.tex`
- `<local_overleaf_root>/ZREFT-Letter/ZREFT.tex`
- `<local_overleaf_root>/PRD Letter: piK_RoySteinerEq/main.tex`
- `<local_overleaf_root>/Nature Commun.: GFFs of nucleon/main_arxiv.tex`
- `<local_overleaf_root>/Disc-Calculus/main-JHEP.tex`

## Exemplar PRL-style papers (arXiv sources opened)

Representative arXiv LaTeX sources downloaded via INSPIRE and manually inspected for discussion-logic patterns (paths not stored in this repo):

- `arXiv:2412.00190` (dispersive HLbL / muon $g-2$; intro + diagnostics/uncertainty narration)
- `arXiv:2503.04883` (EW contribution to muon $g-2$; “bottom line” framing + uncertainty hierarchy)
- `arXiv:2506.02597` (ab initio radii; problem framing + discrepancy diagnosis)

## N=10 exemplar set (auto packs + dual-model maps)

Downloaded via the INSPIRE query in `assets/style/prl_style_corpus.md` and processed with:
- `scripts/bin/research_writer_learn_discussion_logic.py` (N=10; masking on; optional Claude+Gemini clean-room extraction)

Papers (arXiv sources; titles sanitized):
- `arXiv:2506.02597` (2025) — Ab Initio Study of the Radii of Oxygen Isotopes
- `arXiv:2503.04883` (2025) — Improved Evaluation of the Electroweak Contribution to Muon g-2
- `arXiv:2502.12074` (2025) — Lattice QCD Study of Pion Electroproduction and Weak Production from a Nucleon
- `arXiv:2412.00190` (2024) — Complete Dispersive Evaluation of the Hadronic Light-by-Light Contribution to Muon g-2
- `arXiv:2411.14935` (2024) — Ab Initio Study of the Beryllium Isotopes Be7 to Be12
- `arXiv:2411.08098` (2024) — Precision Evaluation of the η- and η′-Pole Contributions to Hadronic Light-by-Light Scattering in the Anomalous Magnetic Moment of the Muon
- `arXiv:2409.18577` (2024) — Light Λ Hypernuclei Studied with Chiral Hyperon-Nucleon and Hyperon-Nucleon-Nucleon Forces
- `arXiv:2408.09375` (2024) — Effective-Range Expansion with a Long-Range Force
- `arXiv:2407.16659` (2024) — ω Meson from Lattice QCD
- `arXiv:2405.20210` (2024) — Anisotropic Flow in Fixed-Target Pb208+Ne20 Collisions as a Probe of Quark-Gluon Plasma

## N=50 exemplar set (auto packs + dual-model maps)

Downloaded via the INSPIRE query in `assets/style/prl_style_corpus.md` and processed with dual-model extraction into:
- `<discussion_logic_out_dir>` (not stored in this repo)

Papers (arXiv sources; IDs sorted by recency):
- `arXiv:2506.02597`
- `arXiv:2503.04883`
- `arXiv:2502.12074`
- `arXiv:2412.00190`
- `arXiv:2411.14935`
- `arXiv:2411.08098`
- `arXiv:2409.18577`
- `arXiv:2408.09375`
- `arXiv:2407.16659`
- `arXiv:2405.20210`
- `arXiv:2405.18469`
- `arXiv:2404.17444`
- `arXiv:2402.05995`
- `arXiv:2309.02037`
- `arXiv:2309.01558`
- `arXiv:2307.02532`
- `arXiv:2306.11439`
- `arXiv:2306.04500`
- `arXiv:2303.09441`
- `arXiv:2205.10994`
- `arXiv:2204.06005`
- `arXiv:2201.02565`
- `arXiv:2112.06929`
- `arXiv:2111.14191`
- `arXiv:2109.12961`
- `arXiv:2105.12095`
- `arXiv:2105.04563`
- `arXiv:2102.02825`
- `arXiv:2012.11602`
- `arXiv:2012.08281`
- `arXiv:2012.04599`
- `arXiv:2011.14517`
- `arXiv:2010.09420`
- `arXiv:2009.07795`
- `arXiv:2009.06248`
- `arXiv:2009.04479`
- `arXiv:2003.04886`
- `arXiv:2002.07184`
- `arXiv:1912.05105`
- `arXiv:1910.11846`
- `arXiv:1903.07969`
- `arXiv:1903.03625`
- `arXiv:1902.11221`
- `arXiv:1811.12482`
- `arXiv:1811.11181`
- `arXiv:1805.01471`
- `arXiv:1712.06595`
- `arXiv:1711.09342`
- `arXiv:1708.02245`
- `arXiv:1702.05177`

## N=96 exemplar set (PRL hep-ph multi-author filter; auto packs + dual-model maps)

Downloaded via INSPIRE (most recent PRL; hep-ph; ≤10 authors; authors: Xiang.Dong.Ji.1, H.X.Zhu.1, Feng.Yuan.1, Jian.Zhou.2, M.Pospelov.1) and processed with dual-model extraction into:

- `<discussion_logic_out_dir>/prl_hep-ph_xdj_hxz_fy_jz_mpospelov`

Progress + audit artifacts (written by the script, not stored in this repo):
- `PROGRESS.md` (should read `Dual-model complete: 96/96`)
- `corpus/records_order.json` (INSPIRE order + titles + years)
