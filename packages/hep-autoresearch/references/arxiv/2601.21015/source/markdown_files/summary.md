## Physical process and setup

This dataset is a Delphes-level effective-field-theory (EFT) sample of top–antitop production at the LHC. The hard process is

$$pp \to t\bar t$$

at a center-of-mass energy $\sqrt{s} = 13\,\text{TeV}$, generated with MadGraph5\_aMC@NLO 3.7.0, interfaced to Pythia8 for parton showering and hadronization and to Delphes 3.5.0 for fast detector simulation. The EFT model is `dim6top_LO_UFO` with `DIM6=1` and `FCNC=0`. In the DIM6 block of the UFO param card the EFT scale is set to $\lambda = 1\,\text{TeV}$ and, among the listed Wilson coefficients, only the chromomagnetic operator coefficient $c_{tG}$ is non-zero; all other entries in that block are set to zero.

Three MG5 processes are used internally: SM LO and SM NLO $pp \to t\bar t$ samples (for constructing an $m_{t\bar t}$-dependent $K$-factor) and a LO EFT UFO $pp \to t\bar t$ sample used for the final dataset.

## Dataset contents and observables

The main artifact is the NumPy archive

- `/output/dataset/output/dataset/ufo_ttbar_reweighted.npz`,

containing $N = 100000$ events. Arrays are fixed-shape; the leading dimension is always the event index, and trailing dimensions correspond to object multiplicities with zero-padding where no object is present.

Event-level fields:

- `event_weight` (per-event weight after EFT + $K(m_{t\bar t})$ reweighting),
- `event_xs_pb` (per-event cross section in pb),
- `met`, `met_phi` (missing transverse energy and its azimuthal angle).

Jet-level fields (up to 10 jets per event): `jet_pt`, `jet_eta`, `jet_phi`, `jet_mass`, `jet_btag`. Lepton-level fields (up to 4 electrons and 4 muons) are given by `ele_pt`, `ele_eta`, `ele_phi`, `ele_q` and `mu_pt`, `mu_eta`, `mu_phi`, `mu_q`. Units follow standard collider conventions: GeV for $p_T$, masses, and MET; radians for $\phi$; dimensionless for $\eta$ and weights.

## Generation and reproducibility

SM LO and NLO $pp \to t\bar t$ samples are used to build a one-dimensional $m_{t\bar t}$-dependent $K$-factor,

$$K(m_{t\bar t}) = \frac{\mathrm{d}\sigma_\text{NLO}/\mathrm{d}m_{t\bar t}}{\mathrm{d}\sigma_\text{LO}/\mathrm{d}m_{t\bar t}}$$

from binned event counts in $m_{t\bar t}$. A LO EFT UFO sample is then reweighted event-by-event via

$$w_\text{new}(m_{t\bar t}) = w_\text{orig}\,K(m_{t\bar t}),$$

and the reweighted LHE is passed through Pythia8 and Delphes. The Delphes ROOT file is converted to the NPZ file by `scripts/delphes_to_npz.py`. The companion `documentation.md` describes the full MG5\_aMC, LHAPDF 6.5.5, Pythia8, Delphes, and Python (NumPy/Awkward/Uproot) setup and provides explicit shell commands for environment installation and reduced-statistics regeneration.

All run cards use `iseed = 0`, letting MG5\_aMC choose random seeds automatically; reruns of the full pipeline will be statistically consistent but not bitwise-identical.

## Intended use and limitations

The dataset is intended for method development and exploratory studies, including EFT-sensitive analyses using jets, leptons, and MET, machine-learning applications (classification or regression on Delphes-level kinematics), and investigations of how a non-zero $c_{tG}$ modifies $t\bar t$ distributions.

Limitations include: only one non-zero dim-6 operator ($c_{tG}$); no separate SM-only or background NPZ samples; NLO QCD effects approximated by a one-dimensional SM-based $K(m_{t\bar t})$ rather than a full NLO+PS EFT calculation; and Delphes fast simulation without pileup or full detector effects. Systematic variations are not propagated into the NPZ, and exact bitwise reproducibility is not guaranteed. For full details, equations, and field-by-field definitions, see `documentation.md`.
