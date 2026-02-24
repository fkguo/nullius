# research-writer — FK LaTeX Writing Style Profile (M0)

This file summarizes recurring writing/style patterns inferred from a scan of the user’s existing LaTeX manuscripts (Overleaf projects listed in the M0 corpus below). It is intended as **guidance** for drafting new text in a similar technical voice, not as a phrase bank to copy verbatim.

## 1) High-level voice

- **Physics-first, mechanism-first**: lead with the physical question, then the mechanism/constraint (unitarity/analyticity/symmetry/power counting), then the quantitative consequence.
- **Active but restrained**: frequent “We …” for actions/results (“We show/derive/find”), but avoid hype. Prefer concrete verbs.
- **Skeptical by default**: treat literature claims as inputs that can fail; when leaning on them, either validate (derivation/check/limit) or label as *unverified* with a plan + kill criterion.
- **Definition-hardened**: quantities are defined operationally; if a number is quoted, the definition and extraction procedure are explicit (and uncertainties are discussed).
- **Comparative and diagnostic**: comparisons to prior methods/results are used to isolate *why* things differ (e.g., left-hand cuts, crossing, coupled channels, thresholds).
- **PRL/letter targets (when applicable)**: compress the narrative (hook → mechanism → consequence) and avoid multi-paragraph scene-setting; keep the “why now” and the headline result front-loaded.

## 2) Paragraph mechanics (typical “moves”)

- **Context → gap → contribution** in the first 1–3 paragraphs of the Introduction.
- **Concrete signposting**:
  - “In this work, we …”
  - “This paper is organized as follows …”
  - “For simplicity, we …” / “Without loss of generality, …”
  - “As is well-known (see, e.g., …), …” when using standard facts.
- **Bridge equations to meaning**: after key equations, add a sentence explaining what controls the size/sign/limit; avoid leaving equations “hanging”.
- **Limit checks** are explicitly mentioned (threshold behavior, symmetry limits, scaling with parameters, consistency sum rules).
- **PRL/letter targets (when applicable)**:
  - Prefer a short italic lead paragraph (common “Introduction.—” letter style) instead of a long, sectioned preamble.
  - Keep signposting to 1–2 sentences; move long roadmaps and technical variants to appendices/supplemental.

## 3) Technical LaTeX conventions (RevTeX/physics norms)

- Nonbreaking references: `Eq.~\\eqref{...}`, `Fig.~\\ref{...}`, `Ref.~\\cite{...}`, `Refs.~\\cite{...}`.
- Acronyms: define on first use with parentheses (“quantum chromodynamics (QCD)”).
- Parenthetical “e.g.” frequently appears as `{\it e.g.},` inside parentheses.
- Numerical results:
  - include uncertainties and units when meaningful;
  - use “within uncertainties”, “moderate”, “mild”, “negligible” with justification (what was varied and what moved).
- Avoid custom macros in shared Markdown math (they won’t render); in LaTeX, macros are used sparingly and locally.

## 4) Results presentation norms

- **Headline numbers** appear with:
  - definition/observable,
  - where they come from (equation + artifact),
  - a minimal self-consistency check (sum rule, identity, scaling),
  - and a short interpretation (“negative sign indicates attraction”, “dominant contribution is …”).
- **Uncertainty accounting** is broken down by dominant sources when possible (“primary uncertainty stems from …; Regge model dependence is negligible in …”).
- **When disagreeing with literature**:
  - state the literature claim precisely,
  - identify the missing ingredient/assumption,
  - show a diagnostic that distinguishes scenarios.
- **PRL/letter targets (when applicable)**: keep the main-text results to the minimal set that carries the claim; move secondary scans/tables/variants to appendices/supplemental, but keep the diagnostic that differentiates scenarios in the main text.

## 5) Figure/table caption style

- Captions are **descriptive and self-contained**:
  - identify what is plotted,
  - color/line conventions,
  - and (if relevant) what cut/kinematic region is used.
- Figures are used as part of the argument (not decoration): captions and surrounding text point to what feature matters.
- **PRL/letter targets (when applicable)**: 1–2 key figures max; captions must be self-contained and interpret the feature that carries the argument.

## 6) “Auditability” add-ons for research-writer

To keep the paper arXiv-ready and auditable when generated from a `research-team` project:

- Any number quoted in the paper must have a **provenance pointer** (artifact path + key within JSON/CSV).
- Any external claim used in core reasoning must be either:
  - **validated** (derivation/check performed in `Draft_Derivation.md` or an artifact), or
  - marked **UNVERIFIED** with:
    - a validation plan (what to compute/check),
    - and a kill criterion (what failure would invalidate the claim).

## 7) Exemplar corpus (INSPIRE → arXiv sources)

To expand the exemplar corpus from your papers and coauthor papers (for **discussion-logic** learning only; no verbatim reuse), see:
- `assets/style/prl_style_corpus.md` (INSPIRE query + arXiv source downloader script)

For the distilled “how to discuss physics” guidance used during drafting, see:
- `assets/style/physics_discussion_logic_playbook.md`

## 8) M0 corpus (inputs scanned; read-only)

The following projects were used as the style corpus (no files modified):

- `/home/user/Dropbox/Apps/Overleaf/Jpsipi_JpsiK`
- `/home/user/Dropbox/Apps/Overleaf/BaryonBaryonNc`
- `/home/user/Dropbox/Apps/Overleaf/psip2Jpipi_dip`
- `/home/user/Dropbox/Apps/Overleaf/Ds1DKgamma`
- `/home/user/Dropbox/Apps/Overleaf/X(3872)fit`
- `/home/user/Dropbox/Apps/Overleaf/ERE with lhc 2`
- `/home/user/Dropbox/Apps/Overleaf/SigmaTerm`
- `/home/user/Dropbox/Apps/Overleaf/JpsipiTFF`
- `/home/user/Dropbox/Apps/Overleaf/GraviChPT_spinlessMatterField`
- `/home/user/Dropbox/Apps/Overleaf/EntanglmentDecuplet`
- `/home/user/Dropbox/Apps/Overleaf/JpsiNScatteringLength`
- `/home/user/Dropbox/Apps/Overleaf/etap2etapipi`
- `/home/user/Dropbox/Apps/Overleaf/ee2Jpsipp`
- `/home/user/Dropbox/Apps/Overleaf/D0(2100)_EPJC`
- `/home/user/Dropbox/Apps/Overleaf/Disc-Calculus`
- `/home/user/Dropbox/Apps/Overleaf/ee2gammaCplusHM`
- `/home/user/Dropbox/Apps/Overleaf/PRD Letter: piK_RoySteinerEq`
- `/home/user/Dropbox/Apps/Overleaf/PRD: piK_RoySteinerEq`
- `/home/user/Dropbox/Apps/Overleaf/Nature Commun.: GFFs of nucleon`
- `/home/user/Dropbox/Apps/Overleaf/ERE_lhc`
- `/home/user/Dropbox/Apps/Overleaf/OpenCharmTetraquarks`
- `/home/user/Dropbox/Apps/Overleaf/EntanglementHeavyMesons`
- `/home/user/Dropbox/Apps/Overleaf/Dispersive analyses of GFFs`
- `/home/user/Dropbox/Apps/Overleaf/XfromLatticeQCD`
- `/home/user/Dropbox/Apps/Overleaf/ZREFT-Letter`
- `/home/user/Dropbox/Apps/Overleaf/Chiral representations of the nucleon mass at leading two-loop order`
- `/home/user/Dropbox/Apps/Overleaf/Photoproduction_3872`
- `/home/user/Dropbox/Apps/Overleaf/IsovectorX`
- `/home/user/Dropbox/Apps/Overleaf/CompleteHHbarMultiplet`
- `/home/user/Dropbox/Apps/Overleaf/0--engilish`
- `/home/user/Dropbox/Apps/Overleaf/AnnHalo`
- `/home/user/Dropbox/Apps/Overleaf/ProtonTFF_DalitzDecay`
- `/home/user/Dropbox/Apps/Overleaf/cusps`
- `/home/user/Dropbox/Apps/Overleaf/XAtom`
- `/home/user/Dropbox/Apps/Overleaf/DN-scattering_length`
- `/home/user/Dropbox/Apps/Overleaf/Nature: A new  paradigm for heavy-light meson spectroscopy`
- `/home/user/Dropbox/Apps/Overleaf/axion-nucleon`
- `/home/user/Dropbox/Apps/Overleaf/XEFT`
- `/home/user/Dropbox/Apps/Overleaf/X3872dip`
- `/home/user/Dropbox/Apps/Overleaf/Xmassprecise`
- `/home/user/Dropbox/Apps/Overleaf/Neutron-halo scattering`
