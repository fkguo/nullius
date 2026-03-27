# research_contract.md (Template)

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This notebook is the single source of truth for:
- assumptions and conventions,
- complete derivations (no skipped steps),
- mapping from theory quantities → code symbols → saved artifacts,
- conclusions and falsifiable predictions.

Skepticism rule (real research):
- Papers/books/docs can be wrong. Treat any cited result as a hypothesis to be tested.
- For any statement used in a core derivation or headline number: either re-derive it here, reproduce a discriminant check from artifacts, or explicitly mark it as unverified (with a concrete plan + kill criterion recorded in [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/)).

Resume / restart rule:
- Before starting a new milestone (or after an interruption), run `run_team_cycle.sh --preflight-only` once to catch missing gates early.

> Rule: In Markdown math, use single backslashes (e.g. $\Delta\kappa$). Avoid doubled backslashes (a common TOC-escape artifact).
> If doubled backslashes appear inside math (e.g. `\\Delta`, `\\gamma\\_{\\rm lin}`), fix deterministically (math regions only): `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/fix_markdown_double_backslash_math.py" --notes research_contract.md --in-place`
> Math delimiter rule: use `$...$` / `$$...$$` (do NOT use `\(\)` / `\[\]`).
> Rendering rule: inside `$$...$$`, do not start a new line with `+`, `-`, or `=` (move operators to the previous line).
> Table rule (important): in Markdown tables, do NOT use literal `|` inside `$...$` (it can break table parsing). Prefer `\lvert ... \rvert` (or `\lVert ... \rVert`; for conditional bars use `\mid`).
> Macro portability: avoid `\slashed{...}` in Markdown math when possible; prefer a portable fallback like `\not\!` (warn-only by default).

---

<!-- REPRO_CAPSULE_START -->
## Reproducibility Capsule (MANDATORY, per milestone/tag)

Fill this block for every milestone/tag you claim is complete. It must contain enough information for a third party to reproduce the key results without guessing.

Capsule boundary policy (important):
- Treat the capsule as a *reproducibility contract* (what/where/how), not a derivation notebook.
- You MAY include a few final-formula definitions for contract clarity, but DO NOT include step-by-step derivations here.
- Any nontrivial derivation must live in the stable body sections, with the capsule pointing to the exact section/Result ID(s).

Language rule (important):
- The narrative text in this capsule should match the primary language of the project/notebook (unless you explicitly require a different language in the team packet).
- The gate checks only rely on structural markers/keywords, not on English prose.

- Milestone/tag: <e.g. M2-r1>
- Milestone kind: <computational | dataset | theory>  # optional; default is computational (strict)
- Date: <YYYY-MM-DD>

### A) Model, normalization, units, and truncation

- Starting equations / model variant:
- Rule: if this becomes longer than a quick summary + a few final formulas, move the material to the body and leave a pointer.
- Normalization / units (explicit):
- Retained terms (LO/NLO etc.; write what is kept):
- Dropped terms / truncation (write what is discarded and why):

### B) Exact inputs (numbers + scheme/scale)

| Name | Value | Units/Normalization | Notes (scheme/scale) |
|---|---:|---|---|
|  |  |  |  |

### G) Sweep semantics / parameter dependence (MANDATORY)

If you scan any parameter(s), you MUST declare the scan semantics here so the team can cross-check correctness.
Use these exact keywords (scripts rely on them):

- Scanned variables: <var1 in [min,max] step ...; var2 ...>
- Dependent recomputations: <quantities/functions that MUST be updated when scanned variables change; include formula/code pointer>
- Held-fixed constants: <inputs that MUST remain fixed; include scheme/scale>
  - Rules file (optional): scan_dependency_rules.json
  - AUDIT_OVERRIDE (optional): warn-only | disable-scan-dep  (must include a short rationale)

### H) Branch Semantics / Multi-root Contract (MANDATORY)

If any reported quantity is obtained by solving an equation that may have multiple solutions (multiple roots/poles/turning points), you MUST fill this section.
Otherwise, keep the section but declare it as not applicable.

Use these exact keywords (scripts rely on them):

- Multi-root quantities: none
- Bands shown: no  # if yes, you MUST provide per-branch quantiles and per-branch n_ok counts

#### 1) Branch inventory

- Branches: none  # or <comma-separated branch names>
- Branch <name>:
  - Sheet (if applicable): <I | II | ... | N/A>
  - Domain of existence: <range/condition>
  - Physical interpretation: <short>

#### 2) Operational selection rule

- Assignment rule: <exact operational rule used to assign numerical roots to branches at each scan point; include continuation/ordering rules>
- Bootstrap assignment: <per-sample continuation | per-point ordering | both | N/A>

#### 3) Output mapping (reproducibility-critical)

For each branch, list the exact output files and columns (must exist on disk).
Plots in the notebook MUST cite which columns they are built from (outside the capsule).

- Branch <name>:
  - Output file: <path/to/main_scan.csv>
  - Columns: <comma-separated columns for this branch, e.g. connected_E_re_q05, connected_E_re_q50, connected_E_re_q95, connected_n_ok>

#### 4) Branch non-mixing invariant

Provide at least one quantitative invariant that should hold if branches are not mixed.

- Ordering invariant: <col_left> >= <col_right>  # evaluated on rows where both are non-NaN
- Continuity invariant (optional): abs_delta(<col>) <= <max_abs_delta>  # checked between adjacent scan points (in file order unless Scan coordinate is given)
- Label stability (optional): <switch_rate_col> <= <max_fraction>  # e.g. fraction of bootstrap samples whose label switches; must be per-branch or per-point
- Scan coordinate (optional): <x_col>  # e.g. m_pi_gev; if provided, continuity checks sort by this column

#### 5) Minimal diagnostic check

Provide at least one diagnostic artifact (table/plot) demonstrating branch assignment at >=1 representative point:

- Diagnostic artifact: <path/to/diagnostic.csv or .png or .json>

### C) One-command reproduction (exact CLI)

Provide at least one full command line that reproduces the headline outputs from a clean environment.

```bash
<FULL COMMAND LINE>
```

### D) Expected outputs (paths) + provenance

List the exact files that must be produced (paths are part of the contract):

- <path/to/manifest.json>
- <path/to/summary.json>
- <path/to/analysis.json>
- <path/to/figure.png>

### E) Headline numbers (default 3; copied from artifacts, not “see file”)

- Min headline numbers: 3  # optional override per milestone; use 0 only if no numeric headline is meaningful
- Min nontrivial headlines: 1  # require at least one diagnostic/cross-validation headline (Tier T2/T3); set 0 only if truly N/A and compensated by audit slices

- H1: [T1] <quantity> = <value> <units> (from <artifact path + field>)
- H2: [T2] <diagnostic> = <value> <units> (from <artifact path + field>)
- H3: [T1] <quantity> = <value> <units> (from <artifact path + field>)

Nontrivial requirement:
- Every headline must include an explicit tier tag: `[T1]`, `[T2]`, or `[T3]` (gate-enforced).
- Tier meanings (domain-neutral):
  - `T1` direct outputs (lowest audit value; can collapse to trivial substitution)
  - `T2` diagnostics (residual/error/convergence/invariant drift; exercises algorithmic path)
  - `T3` cross-validation metrics (two-method disagreement, round-trip error; strongest audit)
- At least one headline should be `T2` or `T3` so cross-checks cannot degrade to trivial arithmetic.
- If full reproduction is impractical, use proxy headline numbers (audit quantities) that still validate key algorithm steps.
- Proxies must be numeric (so they can be parsed and checked); avoid boolean/text-only outputs.
- Trivial examples to avoid: pure constants (e.g., 1, 2, pi), direct input echoes, simple sums/means.

Optional (recommended for floating-point numerics):
- Add tolerances like `(tol=1e-3)` (absolute), `(rtol=1e-3)` (relative), or `(exact)`.

### F) Environment versions + key source pointers (paths; include hash/commit if possible)

- Environment:
  - julia: <version> (preferred for numerics)
  - Project.toml: <path or sha256> (recommended)
  - Manifest.toml: <path or sha256> (recommended; required if you list Julia)
  - python: <version> (optional)
  - numpy: <version> (optional; required if python is used)
  - scipy: <version> (optional)
- Source pointers (include hash/commit if possible):
  - <path/to/key_file.py> (git=<commit> or sha256=<hash>)
  - <path/to/key_file.jl> (git=<commit> or sha256=<hash>)

### I) Knowledge base references (MANDATORY when enabled)

This section is checked by the knowledge layers gate when `knowledge_layers_gate=true` (via `research_team_config.json`).
Keep it domain-neutral: cite literature evidence, methodology traces, and priors you relied on or updated for this milestone.

Literature:
Note: use clickable Markdown links; do not wrap in inline code.
Prefer human-readable link text for scanability, e.g. `RefKey — Authors — Title` (pull from the KB note header).
- [recid-1234567 — FirstAuthor et al., Paper Title](knowledge_base/literature/recid-1234567.md)

Methodology traces:
- [literature queries (M1)](knowledge_base/methodology_traces/M1/literature_queries.md)

Priors:
- [notation and normalization](knowledge_base/priors/notation_and_normalization.md)

<!-- REPRO_CAPSULE_END -->

## 0. Conventions & Assumptions (must be explicit)

- Variables and units:
- Fourier convention:
- Sign conventions (e.g. $e^{i(kx-\omega t)}$ vs $e^{i(kx+\omega t)}$):
- What is treated as input (matching) vs predicted:
- Regime of validity:

## 1. Model / Starting Equations

Write the exact equations you start from, with definitions of every symbol.

## 2. Preliminary Analysis (if applicable)

- Linearization / leading-order analysis steps (if relevant)
- Eigenvalue problem / dispersion relation / linear response (field-dependent; include whatever is appropriate)
- Symmetries / conservation laws / scaling checks (if relevant)
- Definition-hardened baseline quantities (e.g. thresholds, slopes, characteristic scales) with code pointers

## 3. Formalism / Framework (if applicable)

- Derivation (or explicit citation) of the formal framework you use (e.g. variational/action principle, Hamiltonian structure, generating functional/path integral; response-field formalisms for stochastic dynamics when relevant)
- State variables/fields/operators, measures/constraints, and any auxiliary variables (if used)
- If doing perturbation theory: explicit propagators/kernels and interaction terms/vertices (as applicable)
- If doing effective theory/coarse-graining: explicit mode/sector decomposition, operator basis, and what is treated as matching input vs prediction

## 4. Approximation Scheme / Expansion (if applicable)

- Small parameter(s) and ordering assignments
- Expansion / power counting (LO/NLO, $1/N$, etc.; use LP/NLP language only if you explicitly define the power counting)
- Mode decomposition / sector definitions (if applicable)
- Regime of validity and expected error sources

## 5. Core Derivation (no skipped steps)

This is the heart of the paper. For each claim:
1) state the goal,
2) list assumptions,
3) show intermediate algebra,
4) show the final result,
5) list consistency checks and limiting cases.

### 5.1 Claim / Result R1

**Goal**:

**Assumptions**:

**Definitions / notation mapping (no new symbols in Result)**:
- If you introduce any effective operator/quantity in a limit (NR/LO/etc.), define it here and show the mapping used (even if it is “standard”).

**Derivation**:

**Result**:

**Checks**:
- dimensional analysis:
- limiting cases:
- sign checks:

## 6. Mapping to Computation (theory ↔ code ↔ artifacts)

For every headline quantity:
- exact operational definition,
- code location,
- artifact location(s),
- uncertainty estimate method.

| Quantity | Definition | Code pointer | Artifact pointer | Uncertainty |
|---|---|---|---|---|
| Q1 |  |  |  |  |

Code pointer conventions (avoid inline backtick examples here; pointer-lint scans inline code):
- Python projects (pointer_lint.strategy=python_import): use dotted import pointers in backticks.
- Cross-language (pointer_lint.strategy=file_symbol_grep): use path:Symbol or path#Symbol pointers (in backticks in your real notes).

Examples (in fenced code block so templates don’t fail pointer-lint):
```text
pkg.module.symbol
src/foo.jl:myfunc
include/bar.cpp#MyClass
```

## 7. Results (plots/tables, evidence-first)

- Figure list (paths) + 1–2 sentence explanation each
- IMPORTANT: embed the main numerical plots directly here using Markdown images, e.g. `![](figures/M2-r1_main.png)`
- Table list (paths) + how computed

## 8. Milestone Log (append-only; per tag)

Append new milestone summaries here (do NOT create multiple top-level "Conclusions" sections).

### <TAG> (e.g., M2-r1)

- Depends: <ROOT | prior tags | Result IDs>
- Forks (optional): <Parent tag -> what differs>
- Affects: <body section(s)/Result ID(s) + key code pointer(s)>
- What changed:
- Key outputs (paths):
- Headline numbers:
- Risks / next checks:

## 9. Conclusions (falsifiable)

- What was confirmed?
- What failed and why?
- What is the next minimal experiment/derivation to decide between hypotheses?

## 10. Innovation Delta (optional, but recommended)

- What is the new falsifiable insight/diagnostic added since the last milestone?
- What baseline does it discriminate against?
- What would falsify it?
- Record/links: [idea_log.md](idea_log.md) (idea portfolio) + relevant figures/tables.

## 11. Audit slices (for complex computations)

<!-- AUDIT_SLICES_START -->
- Key algorithm steps to cross-check:
- Proxy headline numbers (audit quantities; fast to verify by hand/estimate):
- Boundary or consistency checks (limits/symmetry/conservation):
- Trivial operations not rechecked (standard library, IO, plotting):
- Audit slice artifacts (logs/tables):
<!-- AUDIT_SLICES_END -->

## 12. References (required)

Keep this list up to date. Include a link if one exists (prefer DOI or arXiv).

- Cite in text as [@Key](#ref-Key) (do not wrap in backticks).
- Each reference entry must include a link to the local knowledge-base note.
- Each entry should display author attribution (at least first author + `et al.` when applicable) and publication info (journal/year or arXiv+year).
- For INSPIRE items, record `INSPIRE recid` + `Citekey` in the KB note header.

- <a id="ref-Bezanson2017"></a>**[@Bezanson2017]** J. Bezanson, A. Edelman, S. Karpinski, V. Shah, "Julia: A Fresh Approach to Numerical Computing", SIAM Rev. 59 (2017) 65. [DOI](https://doi.org/10.1137/141000671) | [KB note](knowledge_base/literature/bezanson2017_julia.md)
- If no external link exists, add `Link: none`.

---

<!-- REVIEW_EXCERPT_START -->
Paste the minimal excerpt you want reviewers to focus on (keep it short).
<!-- REVIEW_EXCERPT_END -->
