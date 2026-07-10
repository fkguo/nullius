# research_notebook.md

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This file is the research memo: the one document a colleague in the field
could read, without opening anything else in the repository, and come away
with the project's complete current understanding — including every
derivation, computation, and piece of analysis that understanding rests on.
It reads like a paper (with appendix-level detail), not like a diary.

Three disciplines keep it that way:

1. **Organize by the structure of the problem, never by time.** Sections
   follow the research picture — setup, methods, derivations, results,
   analysis — not the order in which work happened. "What changed when" is
   not this file's job: dated logs live in [research_plan.md](research_plan.md)
   and `artifacts/runs/<run_id>/`; machine-checkable claims live in
   [research_contract.md](research_contract.md).
2. **Update by rewriting, not appending.** When a result lands, a derivation
   is corrected, or the direction changes, rewrite the affected sections so
   the whole document is self-consistent again — as if writing the section
   fresh with today's knowledge. Never leave stage markers ("in the previous
   version...", "as of this week...") or patch-on-patch fragments; the
   revision history is git's job.
3. **Complete but not cluttered.** Every load-bearing derivation appears in
   full (all steps a careful reader needs, with conventions stated), every
   trusted number appears with its uncertainty and provenance link — but
   process detail (tool logs, run transcripts, failed attempts) stays in
   `artifacts/runs/<run_id>/`, referenced by link where relevant. If a section can be deleted
   without losing understanding, delete it.

Suggested skeleton — rename, merge, and grow sections to fit the actual
problem; headings with real meaning beat generic labels:

## Scientific picture and motivation

The problem in plain scientific prose: what question is being answered, why
it matters, what the current best answer looks like and how confident it is.
A reader should understand the point of the project from this section alone.

## Setup, conventions, and definitions

The framework this work lives in: definitions, notation, units, assumptions,
and scope boundaries — everything a reader needs to check the mathematics
that follows. Write mathematics as LaTeX math ($...$ inline, $$...$$ for
display), not as inline-code text.

## Methods and derivations

The heart of the memo. Each method or derivation gets its own subsection
with a meaningful title, written as connected prose with complete
mathematics: starting relations, every non-obvious step, approximations with
their justification and expected validity range, and the final expressions
actually used. When a derivation has passed an independent check, say so and
link the verification artifact; when it has not, say that too.

## Results and analysis

Current results with uncertainties, presented and interpreted: what the
numbers/figures show, how they were validated (link the verification
artifacts next to each trusted value), how they compare with prior work, and
what scientific conclusions they do and do not support. Superseded results are
removed, not struck through — if the change of value itself carries a
lesson, one sentence with a link to the run record is enough.

## Open questions and risks

What is genuinely unresolved, what would falsify the current direction, and
which assumptions the conclusions are most sensitive to.

## References

Stable links and local note pointers, kept current with the text above. For
load-bearing sources, keep the reading honest: record the source form read
(`latex_source`, `full_text_pdf`, `available_full_text`, `abstract_only`, or
`unavailable`), the sections/pages/equations/figures actually read, the
central equations and assumptions taken from each,
what was not read and why, and each source's
project relevance, limitations, and remaining gaps.
Tool-use logs, metadata checks, download attempts, and API/MCP call details
belong in [research_plan.md](research_plan.md) or `artifacts/runs/<run_id>/`,
not here.
