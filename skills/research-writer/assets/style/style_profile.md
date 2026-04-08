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

The following project names were used as the style corpus (local paths intentionally omitted; no files modified):

- `Jpsipi_JpsiK`
- `BaryonBaryonNc`
- `psip2Jpipi_dip`
- `Ds1DKgamma`
- `X(3872)fit`
- `ERE with lhc 2`
- `SigmaTerm`
- `JpsipiTFF`
- `GraviChPT_spinlessMatterField`
- `EntanglmentDecuplet`
- `JpsiNScatteringLength`
- `etap2etapipi`
- `ee2Jpsipp`
- `D0(2100)_EPJC`
- `Disc-Calculus`
- `ee2gammaCplusHM`
- `PRD Letter: piK_RoySteinerEq`
- `PRD: piK_RoySteinerEq`
- `Nature Commun.: GFFs of nucleon`
- `ERE_lhc`
- `OpenCharmTetraquarks`
- `EntanglementHeavyMesons`
- `Dispersive analyses of GFFs`
- `XfromLatticeQCD`
- `ZREFT-Letter`
- `Chiral representations of the nucleon mass at leading two-loop order`
- `Photoproduction_3872`
- `IsovectorX`
- `CompleteHHbarMultiplet`
- `0--engilish`
- `AnnHalo`
- `ProtonTFF_DalitzDecay`
- `cusps`
- `XAtom`
- `DN-scattering_length`
- `Nature: A new  paradigm for heavy-light meson spectroscopy`
- `axion-nucleon`
- `XEFT`
- `X3872dip`
- `Xmassprecise`
- `Neutron-halo scattering`
