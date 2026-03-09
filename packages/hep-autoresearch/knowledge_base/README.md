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
- Include a `RefKey: <Key>` line near the top of each note (used by the project-local `Draft_Derivation.md` notebook in a scaffolded research project root).
- Keep the first H1 title meaningful (used for human-readable links in Capsule I).
- For INSPIRE-based notes, also include:
  - `INSPIRE recid: <integer>`
  - `Citekey: <texkey>`
  - `Authors: <FirstAuthor et al.>`
  - `Publication: <journal / arXiv / status>`
- Include an external link if available (prefer INSPIRE/arXiv/DOI; GitHub is allowed for code).
- Do not check full paper-source trees or tarballs into this package repo; keep compact notes and stable metadata anchors here, and re-fetch raw source on demand in a project-local or scratch location when needed.
- In the project-local `Draft_Derivation.md` notebook (Capsule I), prefer linking like:
  ```md
  - [RefKey — Authors — Title](knowledge_base/literature/<RefKey>.md)
  ```
- Recommended fields for scientific skepticism (optional but encouraged):
  - `Verification status: metadata-only | skimmed | spot-checked | replicated | contradicted`
  - `What was checked:` (equation IDs / limits / reproduction target)
  - `Known issues / errata / disagreements:` (with links)

### Reading depth policy (do we need deep reads?)

Not every paper needs a deep read. We use a “progressively deepen” strategy: treat reading depth as an auditable state, not a binary switch.

Treat each note’s `Verification status` as the marker of reading depth / verification strength:
- `metadata-only`: title/authors/abstract/links only; body not systematically read.
- `skimmed`: read abstract/introduction/conclusion and quickly scan methods/key figures; no independent check.
- `spot-checked`: independently checked at least 1 critical point (equation IDs/limits/units/numeric point/code cross-check).
- `replicated`: reproduced at least 1 key result (figure/table/numbers) with artifact pointers.
- `contradicted`: found a clear contradiction with this project/other sources, with discriminating tests or evidence recorded.

When should you upgrade from `metadata-only/skimmed` to “deep read / verification”?
- Any reference used in **core derivations / headline numbers / default algorithm choices / main conclusions / novelty claims (A5)**: at least `spot-checked`. For the closest prior work, aim for `replicated` when possible.
- Any case where you “implement an algorithm from the paper”: at least `skimmed` plus one reproducible check (otherwise you are trusting a black box).
- The ingest workflow may contain lots of `metadata-only` notes for coverage/screening; but later workflows (reproduce / derivation_check / revision) must upgrade the few key dependencies you actually rely on.

### Markdown math hygiene (rendering safety)

- Use `$...$` / `$$...$$` (do not use `\(` `\)` `\[` `\]`).
- In Markdown tables, avoid literal `|` inside `$...$`; prefer `\lvert...\rvert` (or `\lVert...\rVert`) to avoid breaking table parsing.
- Avoid `\slashed{...}` in Markdown math when possible; prefer a portable fallback like `\not\!` (warn-only by default).
- In `$$...$$` blocks, no line may start with `+`, `-`, or `=` (prefix with `\quad`).
- Do not split one multi-line equation into back-to-back `$$` blocks; keep one `$$...$$` block.
- Deterministic autofix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_math_hygiene.py --root knowledge_base --in-place`
- Avoid accidental doubled backslashes in math (common LLM/TOC escape artifact), e.g. `\\Delta`, `\\gamma\\_{\\rm lin}`:
  - Fix helper: `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py --root knowledge_base --in-place`

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
