# knowledge_base

This folder stores evidence and priors used by the project. It is required before any team cycle.

Skepticism policy (real research):
- Papers/books/docs can be wrong. Treat any imported statement as a *hypothesis*, not authority.
- For any statement used in a core derivation or headline number, do at least one of:
  - re-derive it in the notebook body,
  - reproduce a key numeric/limit check from artifacts,
  - or mark it explicitly as unverified (with a concrete plan + kill criterion in a methodology trace).
- If sources disagree, record both and add a discriminating test instead of picking by authority.

## literature/

- Notes and excerpts from primary sources
- One file per topic or paper cluster
- Include a `RefKey: <Key>` line near the top of each note (used in [research_contract.md](../research_contract.md) references).
- Keep the first H1 title meaningful (used for human-readable links in Capsule I).
- For INSPIRE-based notes, also include:
  - `INSPIRE recid: <integer>`
  - `Citekey: <texkey>`
  - `Authors: <FirstAuthor et al.>`
  - `Publication: <journal / arXiv / status>`
- Include an external link if available (prefer INSPIRE/arXiv/DOI; GitHub is allowed for code).
- In [research_contract.md](../research_contract.md) Capsule I, prefer linking like:
  ```md
  - [RefKey — Authors — Title](knowledge_base/literature/<RefKey>.md)
  ```
- Recommended fields for scientific skepticism (optional but encouraged):
  - `Verification status: unverified | spot-checked | replicated | contradicted`
  - `What was checked:` (equation IDs / limits / reproduction target)
  - `Known issues / errata / disagreements:` (with links)
- Markdown math hygiene (rendering safety):
  - Use `$...$` / `$$...$$` (do not use `\(` `\)` `\[` `\]`).
  - In Markdown tables, avoid literal `|` inside `$...$`; prefer `\lvert...\rvert` (or `\lVert...\rVert`; for conditional bars use `\mid`) to avoid breaking table parsing.
  - Avoid `\slashed{...}` in Markdown math when possible; prefer a portable fallback like `\not\!` (warn-only by default).
  - In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (prefix with `\quad`).
  - Do not split one multi-line equation into back-to-back `$$` blocks; keep one `$$...$$` block.
  - Deterministic autofix helper: `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/fix_markdown_math_hygiene.py" --root knowledge_base --in-place`
  - Avoid accidental doubled backslashes in math (common LLM/TOC escape artifact), e.g. `\\Delta`, `\\gamma\\_{\\rm lin}`:
    - Fix helper: `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/fix_markdown_double_backslash_math.py" --root knowledge_base --in-place`

## methodology_traces/

Validated procedures and reproducibility traces:
- short summaries of what was checked
- commands and outputs
- known limitations
- algorithm-search notes and stability decisions for numerics
- append-only query log (created by scaffold): [literature_queries.md](methodology_traces/literature_queries.md)

## priors/

Project conventions and fixed assumptions:
- notation
- normalization
- units
- known constraints
