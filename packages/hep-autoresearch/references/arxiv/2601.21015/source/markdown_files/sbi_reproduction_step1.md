I’ve read `/pdf_files/test.pdf` and extracted the MadGraph-related setup. In brief, the paper specifies:

- **Collider:** pp at $\sqrt{s} = 13.6\,\text{TeV}$  
  ⇒ `ebeam1 = ebeam2 = 6800.`
- **Generator:** MADGRAPH5_AMC@NLO 3.5.0, **LO** generation only; parton shower with Pythia8 8.306; detector simulation with Delphes 3.5.0.
- **Model:** SMEFTATNLO with Wilson coefficients $(c_{\Phi WB}, c_{WWW}, c^{(3)}_{\Phi q})$ varied (morphing basis points listed in the paper).
- **Process:** $pp \to W^\pm Z$ (leptonic decays handled via MadSpin).
- **Event counts:** the paper quotes various sample sizes (e.g. 300k / 100k parton-level, $\mathcal{O}(10^5\text{–}10^6)$ reconstruction-level), which can be mapped to `nevents` if desired.

However, for constructing **`run_card.dat`** the paper is silent or ambiguous on several critical points:

1. **PDFs** (`pdlabel`, `lhaid`)  
   No PDF set or LHAPDF ID is given.
2. **Scale choice**  
   No renormalization or factorization scale definition (fixed vs. dynamical) is specified.
3. **Generator-level cuts**  
   Lepton and jet $p_T$, $\eta$, and mass-window cuts are given as *analysis-level* selections, but it is not stated whether any of these were already imposed at generator level.
4. **Matching / merging**  
   No statement on MLM, FxFx, or CKKW-L; no number of extra jets; no `xqcut`, `qcut`, or `ickkw`.
5. **Jet algorithm and radius**  
   FastJet is mentioned, but the algorithm (anti-$k_T$ assumed?) and jet radius $R$ are not specified.
6. **Seeds and technical switches**  
   No `iseed`, no NLO K-factor value, and no other technical run-card switches are documented.

To proceed and generate concrete `run_card.dat` files, I need your preferences for the missing pieces.  
Please reply point by point:

1. **MadGraph version for which the cards should be tailored**
   - Use the paper’s version (MG5_aMC 3.5.0) as reference, but ensure syntax compatibility with your local setup?
   - Or strictly target a different version? If so, please specify.

2. **PDF choice (LO)**
   - Proposal: use an LO NNPDF set, e.g.  
     `pdlabel = lhapdf`, `lhaid = 315000` (NNPDF31_lo_as_0130).
   - Alternatively, specify a different PDF set / LHAPDF ID.

3. **Scale setting**
   - Use a standard *dynamical* scale (e.g. MG5 default for $pp \to WZ$)?
   - Or use a fixed scale, e.g. $\mu_R = \mu_F = m_W + m_Z$?
   - Please specify your preferred scheme (saying “use MG5 default dynamical” is fine).

4. **Generator-level cuts**
   The paper’s cuts (e.g. $p_T(\ell) > 15\,\text{GeV}$, $|\eta(\ell)| < 2.5$, jet $p_T > 20\,\text{GeV}$, $m_{\ell\ell}^Z$ window, $m_T^W$, $E_T^{\text{miss}}$) are described as analysis-level. For the run card:
   - Use **minimal loose cuts** (very loose $p_T$ / $|\eta|$, no tight mass windows), leaving the paper’s cuts to the analysis?
   - Or implement the paper’s selections directly as **generator-level cuts**, as closely as possible?

5. **Matching / merging**
   - For an inclusive LO $pp \to WZ$ sample, a common choice is **no matching / merging** (i.e. `ickkw = 0`; all QCD radiation from the shower).
   - Alternatively, set up MLM or FxFx merging. If so, please specify the scheme and approximate merging scales (`xqcut`, `qcut`).

6. **Jet definition**
   - Specify a jet algorithm and radius for consistency (e.g. anti-$k_T$, $R = 0.4$)?
   - Or leave jet clustering entirely to the analysis (no jet-related generator cuts beyond loose defaults)?

7. **`nevents` and number of run cards**
   - One base `run_card.dat` (with `nevents` adjusted manually)?
   - Or multiple run cards reflecting the main sample types in the paper (parton-level derivative sample, morphing-aware sample, reconstruction-level sample), differing only in `nevents` and comments?
   - If specific values are desired, please list them (e.g. 300000 for derivative training, 100000 for validation).

8. **Output location and overwriting**
   - Proposed output directory: `/output/test_run_cards/`.
   - Is it acceptable to create this directory and **overwrite any existing files with the same names**?

Once I have your answers, I will generate one or more `run_card.dat` files, plus a short README explaining which choices are taken from the paper and which are assumptions.
