---
name: deep-literature-review
description: Turn a shallow, metadata-only literature pull into a DEEP review — multi-hop discovery via the existing literature-workflows recipes, per-paper deep-read notes that fill the research-team KB note template from the actual source (with verbatim quotes + locators), cross-paper synthesis (consensus / tensions / gaps), correct Markdown math rendering, and a checkable literature_survey_v1 artifact. Run when a survey feels thin, before promoting an idea, or before writing a related-work / introduction section.
---

# Deep Literature Review

This skill exists because literature pulls in this project tend to stop at
**metadata-only** notes: `literature_fetch.py` writes a KB note whose header says
`Verification status: metadata-only (auto-generated; full text not yet deep-read)`
and leaves the reading-evidence fields blank. The recipes, the provider tools, the
note template, and the `ReadingHandoffContract` all already exist — what is missing
is the **discipline that actually deep-reads each source and synthesizes across the
set**. That is this skill.

It does **not** start a parallel literature system. It builds on:

- `literature-workflows` recipes (`literature_landscape`, `literature_gap_analysis`) for the multi-hop search/traversal plan — resolve them via `autoresearch workflow-plan`; do not hand-roll traversal.
- the research-team KB note template (`knowledge_base/literature/<ref>.md`) — you FILL it, you do not replace it.
- the provider tools (`inspire_*`, `openalex_*`, `arxiv_*`, `pdf_*`) for fetch + analysis.
- `markdown-hygiene` for math rendering, and `claim-grounding` for verifying the claims you extract.

## When to use

- At the start of a project, or when an existing survey "feels shallow / notes too brief".
- Before promoting an idea (the idea's claims need a real evidence base).
- Before writing a related-work / introduction section.

## Output

1. Deep-read KB notes (the existing `.md` template, fully filled — see below).
2. A `literature_survey_v1` artifact (the synthesis/coverage layer; contract SSOT:
   `packages/shared/src/literature-survey.ts`).

## Procedure

### 1. Discover (breadth) — reuse the recipes
Resolve `literature_landscape` (or `literature_gap_analysis`) and follow it: seed search →
references → citations, across INSPIRE / arXiv / OpenAlex. Track a candidate pool. Mark
each kept paper's `role`: `core` (must deep-read), `supporting`, or `background`.

**Paginate to coverage — `size` is a page size, not a result cap.** Every search returns
a `total` hit count; the default page (`inspire_search` `size` defaults to 25, max 1000)
is one page, NOT the complete set. If `total` exceeds what you have fetched, you have not
seen the literature — continue with `inspire_search_next` (follow the returned `next_url`)
or pass `max_results` to auto-paginate, until the candidate pool is covered (then set
`coverage.saturation` accordingly; record `coverage_incomplete` as explicit debt, never as
silent completion). Treating the first page as the answer is the
`page_size_not_completion_threshold` failure the `SearchDepthContract` exists to prevent.

A deep survey is **not** 50 papers. The page size (25/50) is fetch granularity, never a
coverage target: a real topic's `total` is routinely in the hundreds to thousands, the
candidate pool you screen runs well past one page, and the core set you deep-read is bounded
by saturation — references and citations of the core set stop yielding new core papers — not
by any fixed count. A survey that fetched one or two pages and stopped is shallow by
construction, regardless of how good the notes on those few papers are.

**Sort caution.** `sort: mostrecent` with a small `size` returns only the newest N and
silently drops older work — use it for "what's new," never for an exhaustive author or
topic corpus. For corpus completeness, paginate against `total` (and prefer relevance /
citation-count sorts so foundational papers are not lost below the page boundary).

### 2. Deep-read each core paper (depth) — fill the note from the SOURCE
Fetch the **source, not the abstract** (source-first per `ReadingHandoffContract`:
`arxiv_latex_source` > `full_text_pdf` > `available_full_text`): `inspire_paper_source` /
`arxiv_paper_source` / `openalex_content`, plus `inspire_parse_latex` / `pdf_parse` for
equations. Then fill **every** field the KB note template leaves blank, each backed by a
verbatim quote + a locator (section / equation / table / figure / page):

- `Source form actually read` (must be a real full-text form, not `abstract_only`)
- `Sections/pages/equations/figures actually read`
- `Central equations/assumptions extracted`
- `What was not read and why`
- `Project relevance`
- `Limitations / caveats for using this note`
- `## Summary`, `## Key equations / definitions (copy from source)`, `## Notes / Issues`

Then take the note off the auto-generated placeholders: set `Evidence readiness:
evidence-ready`, and set `Verification status` to an evidence-ready value from the
controlled vocabulary `unverified | spot-checked | replicated | contradicted` —
`spot-checked` once you have checked the extracted equations/claims against the source
(`replicated` / `contradicted` if you actually reproduced or refuted a result). Leaving
the `metadata-only` / `reading-required` placeholders, or writing a value outside that
vocabulary, makes the note fail the research-team `knowledge_layers` gate.

**The anti-thin-note rule:** a paper is not deeply read until those fields are filled
*from the source* with locators. If you only saw the abstract, the note stays
metadata-only and the paper's survey `read_status` is `metadata_only` — do not pretend otherwise.

### 3. Synthesize across the read set
Produce the `literature_survey_v1`:
- `papers[]`: one entry per paper — `ref_key`, `note_path`, `domain`, `read_status`, `role`, a synthesized `one_line`.
- `synthesis.consensus[]`: statements the read papers agree on, each citing the `ref_key`s that support it.
- `synthesis.tensions[]`: disagreements/conflicts, each citing the `ref_key`s involved (HEP: seed these with `inspire_detect_measurement_conflicts` / `inspire_theoretical_conflicts`; general: reason over the read notes).
- `synthesis.gaps[]`: open questions / what the literature does NOT cover.

**Referential integrity (enforced by the contract):** every `ref_key` you cite in
`consensus`/`tensions` MUST be a paper in `papers[]`. You cannot synthesize over papers
you did not include — `assembleLiteratureSurvey` / the parser reject dangling refs.

**Coverage is computed, not claimed:** `coverage` (`total_papers`, `deep_read`,
`core_total`, `core_deep_read`) is derived from `papers[]` by the contract, so you cannot
report more depth than you did. Set `saturation` honestly (`saturated` only when
references + citations of the core set stop yielding new core papers; otherwise
`coverage_incomplete` as declared debt, or `unknown`).

### 4. Render the math
Run `markdown-hygiene` on the notes so display math renders:
`python3 <markdown-hygiene>/scripts/bin/markdown_hygiene.py fix --root knowledge_base/literature/`.
(Inside display math, no line may start with `+`/`-`/`=`; copy equations as whole fenced
display blocks — the note template already warns about this.)

### 5. Ground the claims
Hand the claims you extracted (with their `evidence_uris`) to the `claim-grounding` skill:
it fetches each cited source and records a span-backed verdict, so "this paper says X" is
verified against the source, not just asserted.

## What this skill is NOT

- Not a new literature subsystem — it orchestrates existing recipes + provider tools and
  fills the existing KB note template; it adds no `*-mcp` tool.
- Not a substitute for reading. It is the discipline that makes the deep-read happen and
  makes its depth checkable (filled fields + computed coverage + referential-integrity).
- Not the citation verifier — that is `claim-grounding`. This skill produces the notes and
  the survey; claim-grounding verifies the claims in them.
