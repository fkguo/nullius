# PREWORK.md

Purpose: capture prework tasks and evidence before any team cycle.

## Checklist (required)

- [ ] Literature notes added under [knowledge_base/literature/](knowledge_base/literature/)
- [ ] Each literature note includes a `RefKey:` line and external link (if available)
- [ ] For INSPIRE items: record `INSPIRE recid:` and `Citekey:` in the KB note (near the top)
- [ ] Literature coverage matrix updated (dimensions, status, gaps, and plan)
- [ ] Skepticism check: at least one critical external claim/formula has been independently checked (derivation/limit/reproduction), or explicitly marked unverified with a plan + kill criterion in a methodology trace
- [ ] Methodology traces added under [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/)
- [ ] Priors updated under [knowledge_base/priors/](knowledge_base/priors/)
- [ ] Capsule I) in [Draft_Derivation.md](Draft_Derivation.md) updated with paths
- [ ] Method selection checkpoint: list candidate methods and record the chosen approach (with rationale)
- [ ] For complex numerics, cite a stable-method reference in [knowledge_base/](knowledge_base/)
- [ ] If instability is suspected, add a methodology trace documenting the algorithm search and decision
- [ ] Numerics language choice recorded (not enforced): prefer Julia when available; if choosing Python, justify and avoid pure-Python slow loops
- [ ] For any core integral/ODE/optimizer affecting headline numbers: method choice + error control recorded (convergence study or cross-check vs higher-order method; avoid “trapz by default”)
- [ ] Allowed network scope (project leader only): prefer stable anchors (INSPIRE/arXiv/DOI/GitHub) + official docs/archives/registries (SciPy/Julia/NumPy/PyPI/Zenodo/etc.). General scholarly search may be used for discovery, but MUST be logged and final citations must be stabilized to stable anchors.

## Problem Framing Snapshot (required for theory_numerics / mixed / methodology_dev)

Goal: make prework decomposition executable (Problem Interpretation + P/D separation + sequential review), so it cannot be silently skipped.

### Problem Interpretation (P)

- Problem sentence:
- Inputs:
- Outputs:
- Scope:
- Anti-scope:
- Falsification / kill criteria:

### Principle / Derivation Separation (P/D)

- Principles (P): (>=1; each must have a source pointer)
  - P1:  | Source:  | Confidence: high/med/low | Verification: unverified/spot-checked/replicated
- Derivation trace (D): (>=3 atomic steps; link to where each step lives)
  - D1:
  - D2:
  - D3:

### Sequential Review Checklist (do not skip)

- [ ] Problem interpretation complete and consistent
- [ ] P/D separation: principles have sources; derivation has >=3 atomic steps
- [ ] At least one external consistency check planned (limit / baseline / literature)
- [ ] Trust-but-verify: identify one place the literature could be wrong (sign/normalization/regime) and how you will detect it (a discriminant test + kill criterion)

## Literature coverage matrix

Status options: adequate / partial / deferred / not_applicable

| Dimension | Key references (links) | Status | Gaps or plan |
| --- | --- | --- | --- |
| Theoretical foundation |  |  |  |
| Methodology or algorithms |  |  |  |
| Numerics and stability |  |  |  |
| Baselines or SOTA |  |  |  |
| Data or inputs |  |  |  |
| Closest prior work |  |  |  |

Notes:
- Prefer coverage over raw counts, but if you are new to the topic, expect the initial core bibliography to be substantial (often >=8-10 solid sources across dimensions). If you intentionally keep it smaller, state why and what would trigger expansion.
- Update this matrix as the project evolves; add new sources when reviewers or numerics audits reveal gaps.

## Literature notes

- Path(s):
- Key points (3-5 bullets):

## Methodology traces

- Path(s):
- What was validated:

## Priors / conventions

- Path(s):
- Changes made:

## Method selection

- Candidate methods considered:
- Chosen approach and rationale:
