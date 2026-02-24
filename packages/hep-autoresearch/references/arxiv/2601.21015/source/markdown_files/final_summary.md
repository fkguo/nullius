# Simulation summary (Nano)

### Global settings (applies to all simulations unless overridden)

- MadGraph/MG5_aMC@NLO version: 3.5.0
- Model: SMEFTATNLO UFO (dimension-6 SMEFT)
- Decays at generator level: MADSPIN used for reconstruction-level analysis
- Parton shower: PYTHIA8 v8.306 (reconstruction-level)
- Detector simulation: DELPHES 3.5.0
- Jet clustering: FASTJET 3.3.4
- NLO QCD corrections: approximated via an external K-factor (see Ref. [41, 42] in paper)
- Collider setup for LHC study: √s = 13.6 TeV, L = 300 fb⁻¹
- Generator-level reweighting: MADGRAPH5_AMC@NLO reweighting to full amplitude (parton level)
- Key references for external setups: morphing-based SBI/mL training references [6, 21–22], MadMiner-related works [10], and SMEFT/MG tooling references [35, 36, 37, 38, 39, 40]

### Simulation 1: Parton-level p p → W±Z in SMEFT (derivative learning vs morphing-aware approach)

- Overview
    - Purpose: Parton-level likelihood learning for W±Z in SMEFT to compare derivative-learning and morphing-aware approaches; uses repulsive ensembles to estimate uncertainty.
- Hard-scattering / matrix-element generation
    - Tools and versions
        - MadGraph5_aMC@NLO v3.5.0
        - SMEFTATNLO UFO model
    - Collider setup
        - Proton-proton collisions (center-of-mass energy not explicitly stated for this part; parton-level study)
    - Model and parameters
        - SMEFT with dimension-6 operators
        - Theory parameters: θ = (cΦWB, cWWW, c(3)Φq), reference θ0 = (0, 0, 0)
    - Processes and perturbative order
        - Hard process: p p → W± Z (parton level)
        - LO generation; subsequent analysis uses reweighting to include θ-dependence
        - Decays treated at parton level (noted as parton-level study)
    - PDFs and scales
        - Not specified in the parton-level description
    - Generator-level cuts
        - Not specified (no explicit generator-level cuts reported for this parton-level study)
- Reconstruction-level showering/hadronisation and detector (not applied at this stage)
- Event selection
    - Not applied at generator level (parton-level study)
- Fractions and morphing/derivative details
    - Morphing approach
        - Basis points for θ (morphing) used as in App. C
        - Basis points along coordinate axes with nine points:  
            θ1 = (−4, 0, 0), θ2 = (4, 0, 0)  
            θ3 = (0, −0.2, 0), θ4 = (0, 0.2, 0)  
            θ5 = (0, 0, −0.2), θ6 = (0, 0, 0.2)  
            θ7 = (−1.2, −0.09, 0), θ8 = (−1.2, 0, −0.09)  
            θ9 = (0, −0.09, −0.09)
        - Training per-basis-point networks; networks combined via morphing matrix inversion
    - Derivative learning
        - Derivatives of theReco-level cross-section w.r.t. θ learned from parton-level derivatives Ri(x) and Ri j(x)
        - Training at θ0 = 0
    - Training details
        - Morphing-aware sampling: 2×10⁵ events per morphing basis (total 2.5×10⁵ SM and 2.5×10⁵ BSM points in each dataset)
        - Derivative learning: 3×10⁵ events at θ0 = 0
        - Repulsive ensembles used to estimate training-data uncertainty
- Parton-level datasets
    - Morphing: 2.5×10⁵ SM + 2.5×10⁵ BSM events
    - Derivative learning: 3×10⁵ SM events
- Parton-level features
    - Inputs used for training: Mandelstam variables s and t, and W-boson charge
- Referenced external setups
    - Morphing-aware likelihood estimation framework: Ref. [6]
    - Derivative-learning framework: Refs. [21, 22]
    - L-GATr not applied at parton level (noted as parton-level benchmarking)
- Ambiguities and missing information
    - Center-of-mass energy for parton-level generation not explicitly stated
    - PDFs and scales not specified for parton-level generation
    - Generator-level cuts at parton level not specified

### Simulation 2: Reconstruction-level p p → W±Z with leptonic decays in SMEFT (derivative learning and L-GATr with fractional smearing)

- Overview
    - Purpose: Reconstruction-level likelihood inference for three SMEFT Wilson coefficients using leptonic W and Z decays; compares derivative learning and morphing-aware SBI; employs fractional smearing and Lorentz-equivariant L-GATr for likelihood learning.
- Hard-scattering / matrix-element generation
    - Tools and versions
        - MadGraph5_aMC@NLO v3.5.0
        - SMEFTATNLO UFO model
    - Collider setup
        - √s = 13.6 TeV; L = 300 fb⁻¹
    - Model and parameters
        - SMEFT with Wilson coefficients θ = (cΦWB, cWWW, c(3)Φq), θ0 = (0, 0, 0)
    - Processes and perturbative order
        - Process: p p → W± Z with leptonic decays (W→ℓν, Z→ℓℓ)
        - LO event generation; NLO corrections approximated by an external K-factor
    - Decays
        - W and Z decays to leptons via MADSPIN
    - PDFs and scales
        - Not specified
    - Generator-level cuts
        - Not specified
- Parton shower and hadronisation
    - Tool: PYTHIA8 v8.306
- Detector simulation
    - Tool: DELPHES 3.5.0
- Event selection
    - Pre-selection cuts (reconstruction-level, analysis-level)
        - Not detailed here (pre-selection is analysis-level; omitted per constraints)
- Fractional smearing (generator-to-reco density improvement)
    - Method
        - Fractional smearing: generate smeared copies of high-weight parton-level events to better sample sparse high-target regions
    - Procedure
        - Steps: compute mean µ and std σ of target r(zp|θ,θ0); assign fractional weights w; smear by copying events; threshold to decide further smearing
    - Training with fractional smearing
        - Loss for likelihood regression with fractional weights
- Training datasets
    - Parton-level morphing-aware training
        - Basis points: same as Simulation 1 (θ1–θ9)
    - Reconstruction-level datasets
        - Training: ~650k events
        - Validation: ~220k events
        - Test: ~200k events (generated without fractional smearing)
- Likelihood learning methods
    - Derivative learning (reco-level)
        - Focus: derivatives Ri and Ri j w.r.t. θ learned at SM point; networks conditioned on θ
    - Morphing-aware learning (reco-level)
        - Uses morphing basis with fractional-smearing to form rϕ and train accordingly
    - L-GATr
        - Lorentz-equivariant geometric algebra transformer used for likelihood learning
        - Input tokens: particle properties across Lorentz four-momenta embedded as spacetime algebra components
        - Output: scalar component of the multivector for the global token
- Reconstruction-level features
    - Three charged leptons and missing transverse energy (E_T^{miss})
    - Sum of lepton charges; number of jets
    - Reconstructed high-level observables: mℓℓ^Z, p_T^Z, p_T^{Wℓ}, m_T^W, m_T^{WZ}
- Basis points for morphing-aware W±Z reconstruction-level estimation
    - θ = (cΦWB, cWWW, c(3)Φq)
    - Point choices aligned with coordinate axes; exact basis points as listed in App. C
- Training details and architecture
    - Fractional-smearing threshold: t = 0.5
    - Networks: repulsive ensembles used for uncertainty estimation
    - L-GATr architecture: Lorentz-equivariant transformer with Lorentz-algebra-based tokens
- Results and references
    - Parton-level: derivative learning robust; morphing-aware performs adequately but not superior in this setup
    - Reconstruction-level: derivative learning yields reliable results; L-GATr provides further improvement for cWWW and c(3)Φq
    - Full-reco; SBI-based limits outperform cross-section or 1D mT^WZ histogram alone
- Ambiguities and missing information
    - PDFs and factorization/renormalization scales for reconstruction-level generation not specified
    - Explicit generator-level cuts and acceptance criteria for reco-level events not provided
    - Some detailed MG5 input settings (e.g., run cards, specific scale choices) are not reported in the text

References (generator/configuration sources)

- MadGraph/MG5_aMC@NLO v3.5.0 [35]
- SMEFT: SMEFTATNLO UFO model [36]
- MADSPIN for decays [37]
- PYTHIA8 v8.306 [38]
- DELPHES 3.5.0 [39]
- FASTJET 3.3.4 [40]
- NLO corrections and K-factor references [41, 42]
- Morphing-based SBI framework [6]
- Derivative-learning SBI references [21, 22]
- L-GATr Lorentz-equivariant transformer references [30–32]
- Additional MG/MadMiner references as cited in the paper

Notes

- Generator-level cuts and PDF/scale choices are largely unspecified in the text; where not stated, marked as unspecified.
- The reconstruction-level results rely on analysis-level pre-selection cuts; these are not included here to stay within generator-level configuration scope.


# Feedback

Here is a list of possible feedback for your summary:

1. Simulation blocks assessment:

- Simulation 1 (parton-level p p → W±Z in SMEFT) and Simulation 2 (reconstruction-level p p → W±Z with leptonic decays) are indeed distinct MC configurations; no splitting of a single chain into multiple blocks is evident. If any future text lists more blocks, ensure they reflect a genuine configuration change.

2. Out-of-scope items (dedicated section):

- Morphing-based SBI framework (morphing-aware likelihood) used across simulations.
- Derivative-learning SBI framework.
- L-GATr Lorentz-equivariant transformer for likelihood learning.
- Offline object definitions (jet algorithms, lepton isolation, MET definitions, b-tag working points).
- Event selection/cut flows, region definitions (SR/CR/VR).
- Trigger requirements.
- Histogram definitions, observables, binning.
- Background modelling, unfolding, scale factors.
- Any reported observables used for SBI/likelihood results (e.g., mℓℓ^Z, pT^Z, pT^Wℓ, mT^W, mT^WZ) as primary results are analysis-level and should be removed from the MC-generation section.

3. Missing essential generator-level details (reproducibility gaps) – Simulation 1:

- Center-of-mass energy for the parton-level generation is not stated.
- PDFs and factorization/renormalization scales are not specified for the parton-level run.
- Any generator-level cuts at parton level are not reported.
- MG5 input/run-card settings (scale choices, matching/merging scheme if any) are not provided.
- The external K-factor is mentioned but no numeric value or procedure is given, hindering exact reproduction.

4. Missing essential generator-level details (reproducibility gaps) – Simulation 2:

- PDFs and factorization/renormalization scales for reconstruction-level generation are not specified.
- Generator-level cuts or acceptance criteria at the MC level are not reported.
- MG5 input details (run cards, specific scale choices) are not documented.
- Exact K-factor value(s) used to approximate NLO corrections are not provided.

5. Inconsistencies and ambiguous numbers – Simulation 1:

- Training/event-count numbers appear inconsistent:
    - It states 2×10^5 events per morphing basis across nine basis points (implying up to 1.8×10^6 events for morphing alone), yet also says “total 2.5×10^5 SM and 2.5×10^5 BSM points in each dataset.” The discrepancy needs clarification to reproduce the dataset sizes correctly.

6. Observables and analysis-level content flagged for removal from MC configuration:

- The reconstruction-level features and high-level observables listed (e.g., mℓℓ^Z, pT^Z, pT^Wℓ, m_T^W, m_T^WZ) are analysis/observable definitions and should not be described as part of the MC-generation configuration. If kept, clearly separate them as analysis outputs, not generator-level settings.

7. General formatting/consistency notes:

- Some sections rely on references and App. C for basis-point definitions but do not provide explicit numerical values in-text for all readers; ensure all basis points and morphing matrices are fully specified or clearly linked to appendices to avoid ambiguity.
- Ensure consistent use of energy units and coordinate conventions when listing basis points to prevent misinterpretation.

8. Recommendations for improving reproducibility (concise):

- Explicitly state center-of-mass energy, PDFs, scales, and generator-level cuts for both Simulation 1 and Simulation 2.
- Provide exact MG5 run-card settings or a reproducible excerpt.
- Provide explicit K-factor values and how they are applied (and references to where they come from).
- Remove or relocate all ML/SBI/L-GATr content to a separate “analysis/ML methodology” section; keep the MC-generation section strictly to generator-level, shower, detector, and generator-level cuts.
- Resolve the training-event-count inconsistency in Simulation 1 and provide a clear breakdown of per-basis-point event counts and total dataset sizes.

9. Additional cross-checks:

- Verify that the SMEFT operator basis (θ = (cΦWB, cWWW, c(3)Φq)) and θ0 = 0 are consistently used across both simulations, including any reweighting or morphing steps, to avoid mismatches between parton-level and reconstruction-level interpretations.

## Output

Consider every point in this list and reply to each point separately in the form of an enumerated list, e.g.

1. Answer to point 1
2. Answer to point 2  
    ...

For each point:

- First state clearly whether applying this feedback would improve the summary, given the previously defined structure and content constraints.
- If it would improve the summary, briefly explain how you would incorporate it.
- If it would not improve the summary or would violate previous instructions (e.g. by adding unsupported information), explain why you reject it.

Only output the numbered list of answers to the feedback. Do not rewrite or modify the summary itself in this step.

# Feedback Response

1. Simulation blocks assessment

- Would improving: Yes.
- How to implement: Treat Simulation 1 and Simulation 2 as separate Simulation N blocks in the main summary, ensuring each reflects a genuine change in MC configuration (e.g., parton-level vs reconstruction-level, different modeling), rather than splitting a single chain.

2. Out-of-scope items (SBI, morphing, L-GATr, offline/object definitions, etc.)

- Would improving: Yes.
- How to implement: Move all ML/SBI/L-GATr content into a separate “Analysis/ML methodology” section; in the MC-generation sections keep only generator-level, showering, detector simulation configurations and generator-level cuts. Clearly label analysis outputs as analysis, not generator configuration.

3. Missing essential generator-level details – Simulation 1

- Would improving: Yes.
- How to implement: Add explicit placeholders for missing items (e.g., Center-of-mass energy, PDFs, factorization/renormalization scales, any generator-level cuts, MG5 run-card settings, and the numeric K-factor value or procedure). Mark these as “unspecified” where not stated, with references to where they would be specified.

4. Missing essential generator-level details – Simulation 2

- Would improving: Yes.
- How to implement: Similarly annotate missing items as unspecified: PDFs, scales, generator-level cuts, MG5 run-card details, and the exact NLO K-factor value(s) used; indicate how these would be applied.

5. Inconsistencies and ambiguous numbers – Simulation 1

- Would improving: Yes.
- How to implement: Flag the discrepancy in training/event counts (e.g., 2×10^5 vs 2.5×10^5 per basis) and add a note requesting a clarified dataset breakdown (per-basis-point counts and total dataset sizes) without changing reported values.

6. Observables and analysis-level content flagged for removal from MC configuration

- Would improving: Yes.
- How to implement: Remove analysis-level observables (e.g., mℓℓ^Z, pT^Z, pT^Wℓ, m_T^W, m_T^WZ) from the MC-generation sections; either place them in a separate “Analysis outputs” appendix or reference them as outputs of the SBI/likelihood analysis.

7. General formatting/consistency notes

- Would improving: Yes.
- How to implement: When basis points are used, either list explicit numbers in the main text or clearly reference App. C for the full list; ensure energy units and coordinate conventions are consistently stated to prevent misinterpretation.

8. Recommendations for improving reproducibility (concise)

- Would improving: Yes.
- How to implement: Add explicit COM energy, PDFs, scales, and MG5 run-card excerpts; provide exact K-factor values and application method; relocate ML/SBI/L-GATr content to a dedicated ML methodology section; resolve any training-count ambiguities with a clear per-point breakdown.

9. Additional cross-checks

- Would improving: Yes.
- How to implement: Include a consistency note confirming the SMEFT basis used (θ = (cΦWB, cWWW, c(3)Φq)) and θ0 = 0 is applied identically in both simulations, including any reweighting or morphing steps; reference where this is guaranteed (e.g., processing steps, reweighting schemes).


# Final Simulation summary

### Global settings (applies to all simulations unless overridden)

- Tools and models
    - MadGraph5_aMC@NLO v3.5.0
    - SMEFTATNLO UFO model (dimension-6 SMEFT)
    - MADSPIN (decay handling)
    - MG5_AMC@NLO reweighting to full amplitude
- Showering / detector
    - PYTHIA8 v8.306
    - DELPHES 3.5.0
    - FASTJET 3.3.4
- Collision setup
    - Proton-proton collisions
- Higher-order corrections
    - NLO QCD corrections approximated by an external K-factor (value not specified)
- References for external configurations
    - Morphing/IB methods and SBI framework references as in the paper
- Notes
    - Energy, PDFs, scales, and explicit generator-level cuts are unspecified where not stated in the text

### Simulation 1: Parton-level p p → W±Z in SMEFT (derivative learning vs morphing-aware approach)

- Overview
    - Parton-level study targeting the SMEFT parameter set θ = (cΦWB, cWWW, c(3)Φq) with reference θ0 = (0,0,0); comparison between derivative learning and morphing-aware likelihood estimation using repulsive ensembles (uncertainty estimation).
- Hard-scattering / matrix-element generation
    - Tools and versions
        - MadGraph5_aMC@NLO v3.5.0
    - Collider setup
        - Center-of-mass energy: unspecified
    - Model and parameters
        - SMEFT at dimension-6 with θ = (cΦW B, cWWW, c(3)Φq); θ0 = (0,0,0)
    - Processes and perturbative order
        - Process: p p → W± Z (parton level)
        - Perturbative order: LO (generation at MG5_AMC@NLO); reweighting to include θ-dependence
    - PDFs and scales
        - Not specified
    - Generator-level cuts
        - Not specified
- Parton shower and hadronisation
    - Not applied (parton-level study)
- Detector simulation
    - Not applied
- Event selection
    - Not specified at generator level
- Generator-level relations / methodology
    - Reweighting to full amplitude to incorporate θ-dependence
    - Morphing basis (detailed basis points provided in App. C)
    - Derivative learning via parton-level derivatives Ri(zp) and Ri j(zp)
- Data and training specifics (as reported)
    - Morphing-aware sampling
        - Basis points chosen along coordinate axes (nine θ-basis points)
        - Training per-basis networks combined via morphing matrix; losses defined to combine basis predictions
    - Derivative learning
        - Training at SM point θ0 with derivatives Ri, Ri j learned from parton-level information
    - Training counts (ambiguous in the source)
        - Morphing: mentions separate per-basis training with events at θ = −1, 0, 1; total dataset sizes reported with two inconsistent numbers (see ambiguities)
        - Derivative learning: training at θ0 with a distinct dataset size
    - Training uncertainty
        - Repulsive ensembles used to estimate training-data uncertainties
- Observables / inputs
    - Parton-level inputs include Mandelstam variables (e.g., s, t) and W-boson charge
- Referenced external setups
    - Morphing framework and derivative-learning framework as in Refs. [6], [21], [22], with MadMiner-related references
- Ambiguities and missing information
    - Center-of-mass energy for parton-level generation
    - PDFs and scales for parton-level run
    - Any generator-level cuts at parton level
    - Exact per-basis-point event counts and total dataset size (inconsistencies noted)
    - Numerical value or procedure for the external K-factor (not specified)

### Simulation 2: Reconstruction-level p p → W±Z with leptonic decays in SMEFT (derivative learning and fractional smearing; ML methods)

- Overview
    - Reconstruction-level analysis of W±Z in SMEFT with leptonic decays; three Wilson coefficients θ = (cΦWB, cWWW, c(3)Φq), θ0 = (0,0,0); comparison of derivative learning, morphing-aware SBI, and the L-GATr-based likelihood learning; employs fractional smearing to improve phase-space coverage.
- Hard-scattering / matrix-element generation
    - Tools and versions
        - MadGraph5_aMC@NLO v3.5.0
        - SMEFTATNLO UFO model
    - Collider setup
        - √s = 13.6 TeV; L = 300 fb⁻¹
    - Model and parameters
        - SMEFT with θ = (cΦWB, cWWW, c(3)Φq); θ0 = (0,0,0)
    - Processes and perturbative order
        - Process: p p → W± Z with leptonic decays
        - LO event generation; NLO corrections approximated by a K-factor; jet veto applied to mitigate NLO-PS dependence
    - PDFs and scales
        - Not specified
    - Generator-level cuts
        - Not specified at MG5 level
- Parton shower and hadronisation
    - Shower: PYTHIA8 v8.306
- Detector simulation
    - DELPHES 3.5.0
- Event selection
    - Pre-selection cuts at reconstruction level described in the text (not enumerated here to stay within generator-level scope)
- Generator-level relations / methodology
    - Reweighting at parton level to include θ-dependence (full amplitude for the reweighting)
    - Decays at generator level: MADSPIN for leptonic decays
- Fractional smearing
    - Rationale: to remap phase-space densities into sparsely populated regions
    - Procedure
        - Compute mean µ and standard deviation σ of the target r(zp|θ, θ0)
        - Initialize fractional weight w = 1 for all events
        - Smear by copying events n times with w = 1/n
        - Apply a threshold to decide further smearing (e.g., |w × r − µ| > tσ with t = 0.5)
        - Use the smeared weighted sample in the loss
- Reconstruction-level datasets and training
    - Training/validation/test sets
        - Training: ~650k events
        - Validation: ~220k events
        - Test: ~200k events (generated without fractional smearing)
- Likelihood learning methods
    - Derivative learning (reco-level)
        - Learn reco-level derivatives Ri i(x) and Ri j(x) w.r.t. θ at SM point; networks conditioned on θ
    - Morphing-aware learning (reco-level)
        - Use morphing basis with fractional smearing; combine basis predictions to form rϕ(x|θ, θ0)
    - L-GATr
        - Lorentz-equivariant geometric algebra transformer used for likelihood learning; processes particle tokens as spacetime-algebra elements
- Reconstruction-level features (network inputs)
    - Leptonic W and Z four-momenta (three leptons) and missing transverse energy
    - Global event features: sum of lepton charges, number of jets; reconstructed high-level observables (e.g., mℓℓ^Z, pT^Z, pT^{Wℓ}, mT^W, mT^{WZ}) used for analysis (not listed as generator-level settings)
- Basis points for morphing-aware reconstruction-level estimation
    - θ = (cΦWB, cWWW, c(3)Φq); basis points chosen along coordinate axes (as specified in App. C)
- Training details and architecture
    - Fractional-smearing threshold: t = 0.5
    - Uncertainty estimation: repulsive ensembles used for network predictions
    - L-GATr input: particle tokens embedded as vector grades in the spacetime algebra; scalar output selected from the global token
- Results (as reported, for context within MC chain)
    - Parton-level: derivative learning yields robust likelihood ratios; morphing-aware approach performs comparably or worse depending on parameter direction
    - Reconstruction-level: derivative learning provides reliable results; L-GATr yields further improvements for certain coefficients
    - Overall: SBI methods improve beyond rate or 1D histograms; fractional smearing enhances training stability
- Observables / inputs (analysis-level content)
    - Input features include three-lepton kinematics, MET, and higher-level event features; analysis outputs (e.g., mT distributions, invariant masses) are discussed in the paper but not enumerated as generator-level cards here
- Ambiguities and missing information
    - PDFs and factorization/renormalization scales for reconstruction-level generation
    - Generator-level cuts or acceptance criteria at the MC level
    - Exact MG5 run-card details and scale choices
    - Exact numerical value of the NLO K-factor used
- References
    - MG5_aMC@NLO v3.5.0 [35]
    - SMEFTATNLO UFO model [36]
    - MADSPIN [37]
    - PYTHIA8 v8.306 [38]
    - DELPHES 3.5.0 [39]
    - FASTJET 3.3.4 [40]
    - NLO K-factor references [41, 42]
- Analysis/ML methodology (separate)
    - Morphing-aware likelihood estimation (basis-based)
    - Derivative-learning SBI
    - Fractional smearing
    - L-GATr Lorentz-equivariant transformer
    - Training with repulsive ensembles for uncertainty estimation
    - App. C basis-point definitions; loss functions (MSE-based for morphing-aware reconstruction-level; BCE or MSE variants discussed in text)
- Ambiguities and missing information (ML side)
    - Explicit KG values for K-factors and jet veto thresholds are not provided
    - Full per-point dataset breakdown and exact counts across all basis points are not unambiguously stated