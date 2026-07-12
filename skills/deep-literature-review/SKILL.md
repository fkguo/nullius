---
name: deep-literature-review
description: Turn a shallow, metadata-only literature pull into a DEEP review — multi-hop discovery via the existing literature-workflows recipes, per-paper deep-read notes that fill the research-team KB note template from the actual source (with verbatim quotes + locators), an optional double-reader mode for load-bearing papers (two independent readers from different model families plus a moderator that keeps disagreements visible), cross-paper synthesis (consensus / tensions / gaps), correct Markdown math rendering, and a checkable literature_survey_v1 artifact. Run when a survey feels thin, before promoting an idea, or before writing a related-work / introduction section.
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

- `literature-workflows` recipes (`literature_landscape`, `literature_gap_analysis`) for the multi-hop search/traversal plan — resolve them via `nullius workflow-plan`; do not hand-roll traversal.
- the research-team KB note template (`knowledge_base/literature/<ref>.md`) — you FILL it, you do not replace it.
- the provider tools (`inspire_*`, `openalex_*`, `arxiv_*`, `pdf_*`) for fetch + analysis.
  For arXiv papers, prefer the hep-mcp / arXiv source path (`arxiv_paper_source`
  or `inspire_paper_source` with LaTeX/source extraction) before PDF; a PDF read
  is the fallback when source is unavailable or unusable, not the first move.
- `markdown-hygiene` for math rendering, and `claim-grounding` for verifying the claims you extract.
- `citation-triangulation` for cross-index identity checks before a paper enters
  the core set; provider metadata from a subagent is not identity authority.
- `review-swarm` as the gate harness for the deep-read note's source-fidelity, and `research-integrity` (*Extraction / transcription fidelity*) for the failure class that gate falsifies.
- `literature-graph-builder` for the downstream graph artifact contract, validation, portable links, figure embedding, math rendering checks, and browser QA.

## When to use

- At the start of a project, or when an existing survey "feels shallow / notes too brief".
- Before promoting an idea (the idea's claims need a real evidence base).
- Before writing a related-work / introduction section.

## Output

1. Deep-read KB notes (the existing `.md` template, fully filled — see below).
2. A `literature_survey_v1` artifact (the synthesis/coverage layer; contract SSOT:
   `packages/shared/src/literature-survey.ts`).

All Markdown outputs from this workflow must keep references reachable: paper
records (arXiv, DOI, INSPIRE/OpenAlex where available), source files, KB notes,
and project artifacts are Markdown links, not bare or backticked identifiers.
Repo-local links must resolve from the Markdown file's own directory. Do not
write a link as if the reader's Markdown sidebar resolves from the project root;
run `markdown-hygiene` link checks, and for idea-posterior reports run
`skills/idea-posterior/scripts/normalize_report_links.py --check`.

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

**Measure saturation as you expand — two integers per round.** Core-set expansion runs in
rounds: screen the references and citations (the frontier) of the current core set, admit
what qualifies, repeat on the newly admitted papers' frontier. At the end of every round
record, in the survey's `coverage.saturation_evidence`, how many expansion candidates you
actually examined and dispositioned this round (`expansion_candidates_screened` — kept in
any role, rejected as off-topic, or discarded as already-known duplicates all count: it
measures screening work) and how many papers the round added to the survey's final core
set (`new_core_papers` — a paper later demoted out of `core` does not count, and each core
paper is credited to at most one round). These two numbers per round are the measurement
that backs — or falsifies — the saturation status you set in step 3.

**Sort caution.** `sort: mostrecent` with a small `size` returns only the newest N and
silently drops older work — use it for "what's new," never for an exhaustive author or
topic corpus. For corpus completeness, paginate against `total` (and prefer relevance /
citation-count sorts so foundational papers are not lost below the page boundary).

**Search the critique, not only the topic.** A breadth-by-topic sweep finds the
apparatus and the papers that *use* it; it will systematically miss the work
that *contests* the central claim. Run a dedicated discovery pass aimed at the
strongest existing statement of, and the strongest existing challenge to, the
survey's central claim or tension. Two things decide whether it works:

- *Vocabulary — use the field's own critique terms, not generic ones.* Generic
  critique tokens alone ("limitations of", "model dependence", "revisited",
  "reanalysis") routinely return nothing: a real critique is phrased in the
  field's specific language — the particular property being contested, the
  eponymous method or quantity it attacks, the specific kind of ambiguity,
  degeneracy, or non-uniqueness it raises. Derive those terms from the claim
  itself and query on them; treat the generic tokens only as a starting seed.
- *Mechanics — search content, and keep the conjunction short.* Search full
  text, not title: a critique paper's title often omits the topic word (it
  names the flaw, not the field), so a title filter silently drops it. Keep the
  required-term conjunction short — each extra required phrase can eject a
  genuine hit whose wording differs slightly — and pin one domain term against
  the critique term rather than stacking many. On a preprint server, prefer
  fielded, date-bounded queries over natural-language relevance, which drifts
  across unrelated fields.
- *Reach — follow citations, and read conclusions.* The strongest critique you
  find is a hub: traverse its references and its citing papers. The ancestor
  critiques (which predate the claim's current framing) and the follow-up
  refinements are routinely invisible to any topic query and surface only
  through this citation snowball. And a critique can sit in the *conclusions* of
  a paper whose title and abstract are about something else — a review, a
  measurement, an application — reachable by full text but never by metadata; do
  not let an off-topic abstract rule a paper out, read the conclusions of the
  highest-relevance adjacent papers rather than trusting their abstracts to
  advertise the caveat.

Seed conflict-detection over the hits with whatever provider-specific tools
expose it, otherwise reason over the read notes. A candidate pool that contains
only papers assuming or applying the claim, and none that question it, is not
saturated — it is one-sided; record that as coverage debt, never as a clean
sweep.

### 2. Deep-read each core paper (depth) — fill the note from the SOURCE
Fetch the **source, not the abstract** — source-first per the ReadingHandoffContract
preference order: arXiv LaTeX source, then full-text PDF, then other available full text.
Use `inspire_paper_source` / `arxiv_paper_source` / `openalex_content`, plus
`inspire_parse_latex` / `pdf_parse` for equations.

For arXiv works, ask for the LaTeX/source form first (for example hep-mcp
`arxiv_paper_source` with source/LaTeX extraction). Reading the PDF first is a
process error unless the source is unavailable, fails extraction, or the relevant
content only exists in a non-LaTeX full-text form; record that reason in the note.
Do not let an abstract-driven fetch decide that a paper is irrelevant before the
conclusion/outlook and method/results sections have been checked.

Before a paper is admitted to `role: core`, run `citation-triangulation` and
record a machine-readable `identity_triangulation` object with at least two
independent provider records and verdict `consistent`. Check the title, year,
authors, DOI/arXiv/INSPIRE/OpenAlex identifiers, and same-work aliases. A
conflict such as an INSPIRE recid paired with the wrong arXiv id blocks core
admission until resolved; subagent-provided metadata is only a lead.

Identity agreement does not establish a **relationship between distinct works**.
Any claim that a paper is “Part II,” a predecessor/successor, erratum, companion,
or continuation must also be grounded in the primary paper's own preamble,
reference list, or explicit cross-reference and checked against catalog identities
for every work involved. Similar authors, year, title words, or numbering are not
enough; record the relationship locator in the extraction ledger.

**Check the correction chain before extracting load-bearing content.** For every
core paper, search the bibliographic record and the paper's citation/relationship
metadata for an erratum, corrigendum, expression of concern, retraction, revised
version, or explicit author correction in a later work. Record the result even when
no correction is found. If a correction exists, persist and read it alongside the
main paper, record its identifier and exact affected items, and use the corrected
form in downstream derivations. The originally printed form may be retained only
when it is labeled as pre-correction. A full read of the main paper does not by
itself establish that the publication's final formula or claim was read.
Keep the correction-search record evidential: queries, indexes, identifiers,
returned relations, and exact correction locators. Do not preload it with the
scientific verdict about which correction is complete or which formula is right;
that conclusion belongs to the candidate-withheld extraction.

**Persist the source you read.** When a fetch/source tool returns the primary source to an
ephemeral or temporary path, persist that exact source to a stable, auditable location (e.g.
alongside the note) so the fidelity gate (step 5) — and any later reviewer — reads exactly the
bytes you transcribed, not a re-fetch that may have changed. This is a workflow discipline
(where *you* save the source), not a change to any fetch tool's behavior.

For every load-bearing equation, value, definition, or attribution, create an
**extraction ledger** before writing synthesis prose. Use
`templates/extraction-ledger.md` or an equivalent structured artifact and keep these
fields distinct: persisted source path/hash, exact locator, literal source text,
normalized transcription, symbol dictionary, derived project mapping/inference, and
fidelity status. Also record the correction-chain search, every correction source and
hash, and whether the item is unchanged or superseded. Never put a normalized formula
in the literal field, never present a derived mapping as source wording, and never
silently substitute a corrected expression for the printed source form. A prime,
dummy-variable rename, or notation cleanup is a normalization and must appear in the
change log even when it leaves the mathematics unchanged.

Then fill **every** field the KB note template leaves blank, each backed by a
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
*from the source* with locators. A core paper's `read_status` must be one of:

- `full_text_read`: introduction, formalism/method, results/discussion, and
  conclusion/outlook were checked from full text.
- `section_read`: only named sections were read; this can support synthesis but
  is not enough for saturated close-prior core status unless the unread sections
  are nonessential and the gate accepts the limitation.
- `metadata_only`: only title/abstract/metadata or provider summaries were seen.
- `unavailable`: full text could not be obtained.

`metadata_only` and `unavailable` papers never anchor Gaia likelihoods. For
`full_text_read`, the minimum checked sections are introduction,
formalism/method, results/discussion, and conclusion/outlook: important caveats
often live at the end of a paper.

Each close-prior entry must also carry `source_links`, `read_locators`, and
`read_sections`. If you only saw the abstract, the note stays metadata-only and
the paper's survey `read_status` is `metadata_only` — do not pretend otherwise.

For a load-bearing paper — one whose extracted propositions will anchor a
likelihood, decide a close-prior verdict, or support a central claim — the note
can be produced by two independent readers plus a moderator instead of a single
reader; see *Optional: double-reader mode for load-bearing papers* below.

### 3. Synthesize across the read set
Produce the `literature_survey_v1`:
- `papers[]`: one entry per paper — `ref_key`, `note_path`, `domain`,
  `read_status`, `role`, a synthesized `one_line`, `source_links`,
  `read_locators`, `read_sections`, `identity_triangulation`, and
  `source_fidelity_audit` for each core paper.
- `synthesis.consensus[]`: statements the read papers agree on, each citing the `ref_key`s that support it.
- `synthesis.tensions[]`: disagreements/conflicts, each citing the `ref_key`s involved (HEP: seed these with `inspire_detect_measurement_conflicts` / `inspire_theoretical_conflicts`; general: reason over the read notes).
- `synthesis.gaps[]`: open questions / what the literature does NOT cover.

**Referential integrity (enforced by the contract):** every `ref_key` you cite in
`consensus`/`tensions` MUST be a paper in `papers[]`. You cannot synthesize over papers
you did not include — `assembleLiteratureSurvey` / the parser reject dangling refs.

**Coverage is computed, not claimed:** `coverage` (`total_papers`, `deep_read`,
`core_total`, `core_deep_read`) is derived from `papers[]` by the contract, so you cannot
report more depth than you did.

**Saturation is machine-gated, not asserted:** `saturated` is legal only when
`coverage.saturation_evidence` carries the expansion rounds recorded in step 1 and the
last round did real screening work (`expansion_candidates_screened` > 0) yet admitted
zero `new_core_papers`. A `saturated` without that support — no recorded rounds, a last
round that still yielded new core papers, or a zero-work last round — is mechanically
downgraded to `coverage_incomplete` by `assembleLiteratureSurvey` (with the reason
appended to `coverage.notes`) and rejected by the parser; the downgrade is always
visible, never a silent value change. Do not react to the gate by inventing numbers:
fabricating or retro-fitting round counts that were never measured is an integrity
violation of the same class as `research-integrity`'s *hallucinated measurement / result*
and *methodology fabrication*. The honest moves are to run and record a real further
expansion round, or to ship `coverage_incomplete` as declared debt (or `unknown` when
saturation was not measured).

### 4. Prepare an optional graph-ready export
When the user asks for a literature graph, interactive notes, or graph-backed slides, export a
graph-ready layer after the survey synthesis. Read `literature-graph-builder`'s
`references/graph-ready-contract.md` for the exact shape.

The deep-review side owns the content provenance:

- stable paper, method, topic, result, and synthesis node ids;
- one note path per node whenever the node carries content;
- source locators for equations, numeric values, tables, figures, and important assertions;
- relation labels for reference chains, method lineage, applications, contrasts, same-work aliases, and synthesis links;
- figure-candidate metadata with a real source locator, a content reason, and a path to the extracted or converted asset when available.

Do not stop at keyword search or the seed paper's bibliography. For graph completeness, track both backward references and forward citations from each core paper until no new core nodes appear, or record the remaining gap as coverage debt. Do not include off-topic citation drift merely because it is adjacent in a citation graph.

The graph export is not the renderer. Hand the JSON, notes, and figure assets to
`literature-graph-builder` for path validation, note embedding, MathJax/KaTeX checks,
image checks, layout/interaction QA, and browser verification.

### 5. Render the math
Run `markdown-hygiene` on the notes so display math renders:
`python3 <markdown-hygiene>/scripts/bin/markdown_hygiene.py fix --root knowledge_base/literature/`.
(Inside display math, no line may start with `+`/`-`/`=`; copy equations as whole fenced
display blocks — the note template already warns about this.)

### 6. Gate the note against the primary source (fidelity falsification)
A filled deep-read note is a **gateable artifact, not a gate-exempt "reading task"** — its
primary observable is **fidelity to the source**. Before the note is relied on for a central
claim or folded into a durable artifact, gate it with a **line-by-line comparison against the
primary source with "do not trust the note"** — a falsification pass, not a confirmation read.

Self-check every transcribed item before handoff: (a) equation misquote, (b) wrong numeric
value, (c) wrong / stale locator, (d) stale / wrong mapping to the consuming artifact,
(e) false "verbatim", (f) inference-as-source, (g) silent factor drop,
(h) correlated-input agreement, (i) bibliographic-relation conflation,
(j) stale pre-correction source, (k) context-stripped extraction,
(l) source-layer contamination (full definitions: `research-integrity` →
*Extraction / transcription fidelity*).

For a note that will anchor a central claim, enter a close-prior matrix, or be folded into a durable artifact, the gate is
**independent** (a fresh reader / subagent, not the note's author) and at least one reviewer
**must** be **cross-model-family** doing a literal comparison — loose semantic agreement is
insufficient for transcription fidelity. Before that candidate-visible comparison, obtain
at least one **candidate-withheld extraction**: give a fresh reader the persisted source and
a neutral locator/question list, but not the candidate note, prior verdict, expected
classification, or proposed corrected expression. This separates model-family independence
from input/framing independence. Use `review_one.py --role source-extraction` with
`--extraction-request`; that entry rejects candidate artifacts, diffs, and additional
context by construction. The reviewer must still reject an answer-anchored request because
request neutrality cannot be established from file shape alone.

Before that pass, classify the source bytes with `--source-text-origin`. Use
`direct-original-text` only for publisher/repository text that was not manually rewritten.
For a PDF/scan transcription, use `visually-verified-transcription` and supply a separate
`--source-provenance-evidence` record with document/page/crop hashes, locators, the visual
comparison, and whether the visual verifier was distinct from the transcriber. Do not place
normalization, symbol mapping, inferred limits, or scientific adjudication inside the source
payload. A hash fixes the bytes under review but cannot establish that those bytes match the page.

Run the comparison through `review-swarm` (the source-fidelity reviewer role), supplying
the note via `--artifact`, each exact main source via `--source`, an explicit
`--source-text-origin`, an explicit `--correction-status`, the correction-chain query record via
`--correction-search-evidence`, and every applicable correction via
`--correction-source`. The launcher must reject a source-fidelity run that has no
separate primary-source payload, no source-origin declaration/provenance evidence when
required, no correction-chain declaration/evidence, or a declaration that corrections
exist without their exact text. Re-review after **every**
fix and call convergence only when the source-localized checks agree — never self-declare it
after applying a fix or resolve a conflict by majority vote. (`derivation-verify`
is a *separate* axis: it re-derives whether a re-derivable result is mathematically correct,
which does not check whether the note faithfully copied the source — use it in addition to,
never instead of, the source comparison.)

If the primary source is a PDF or scan, include a direct PDF/image-capable comparison
against the rendered page or a lossless crop. Record the original file/page hash, crop
hash, and locator in the extraction ledger. OCR or `pdftotext` can locate a passage but
cannot serve as formula-fidelity evidence; a text-only note-to-excerpt pass is only the
second half of the check.

The persisted excerpt must be **dependency-closed for the requested check**. Alongside
each displayed formula, include the neighboring source text that fixes its domain,
boundary value, branch/sheet, conventions, and definitions. Before a reviewer derives
anything, it lists those required premises and marks the step uncheckable if one is
absent. A formula-only excerpt can be literally accurate and still force every reader
to analyze the wrong object.

Record the result in the survey as `source_fidelity_audit`: reviewer/auditor id,
source path/hash, checked locators, candidate visibility, whether a candidate-withheld
extraction was completed, correction-search evidence path/hash, status
`pass | partial | fail`, and notes. The summary itself
is audited: every important paraphrase must be traceable to a quoted span or
locator, and any unsupported summary sentence is removed or downgraded to
inference. A core paper requires `source_fidelity_audit.status: pass`; `partial`
or `fail` keeps the survey at `coverage_incomplete` for posterior admission.

Subagent literature audits are discovery/synthesis inputs only. The main
coordinator must verify links, source form, identity triangulation, quoted spans,
locators, and the distinction between source text and synthesis before any
proposition can become a Gaia anchor.

### 7. Ground the claims
Hand the claims you extracted (with their `evidence_uris`) to the `claim-grounding` skill:
it fetches each cited source and records a span-backed verdict, so "this paper says X" is
verified against the source, not just asserted.

Gaia input is proposition-level, never paper-level: deep-read paper -> extracted
proposition -> claim-grounding quote and locator -> mapped sub-criterion anchor.
A paper, literature count, or subagent summary is not itself evidence in Gaia.

## Optional: double-reader mode for load-bearing papers

The default flow produces each deep-read note with a single reader (step 2) and
falsifies it against the source (step 6). For a **load-bearing** paper — one whose
extracted propositions will anchor a likelihood, decide a close-prior verdict, or
support a central claim of the survey — one reading, however carefully gated, still
carries one reader's blind spots. For those papers the note can instead be produced
in double-reader mode:

1. **Two independent readers.** Each reader runs the full step-2 deep-read on the
   same persisted source bytes and writes a complete note draft. Independence means
   readers from **different model families where available**, and at minimum
   separately-run readers that never see each other's drafts (no shared conversation,
   no shared draft) — two readers sharing one context are one reader with extra words.
2. **A moderator pass.** A third, separately-run participant compares the two drafts
   against the persisted source and produces the single KB note:
   - it merges **agreed content** — statements both readers extracted with compatible
     quotes and locators — into the note body;
   - it records **every disagreement explicitly**, each with a verbatim quote + locator
     from the source (the disputed passage itself, not either reader's paraphrase);
     where the source settles the point at that locator, the moderator resolves it
     from the source and says so;
   - it **never resolves a disagreement by majority or by smoothing the language**.
     Recruiting extra readers to outvote a reading settles nothing — only the source
     settles a reading — and a blended sentence both readers "could accept" hides the
     conflict instead of recording it. Whatever the source does not settle stays
     visible as an **open item for the human**, listed under `## Notes / Issues` with
     both readings side by side.

**Marking the note.** A double-read note carries a `Readers:` line among the head
metadata lines, in the same `Field: value` style as `Verification status:` (the
auto-generated template does not emit it; the moderator adds it):
`Readers: <reader-1 id / model family>, <reader-2 id / model family>; moderator: <id / model family>`.
Keep both reader drafts alongside the persisted source so the merge and every
recorded disagreement stay auditable. Single-reader notes omit the field.

**Consequences for use.** Merged agreed content is used like any other deep-read
content and still goes through the step-6 source-fidelity gate (with a fresh
reviewer — neither of the two readers nor the moderator) before anchoring anything:
double-reading is a production discipline, not a replacement for that falsification
pass, though it sharpens it — divergences arrive already localized. A proposition
that is still an open disagreement is not evidence-ready: it must not anchor a
likelihood, decide a close-prior verdict, or be cited as consensus until a human
resolves the item.

**When it is worth the cost.** Double-reading doubles the reading work and adds a
moderation pass; spend it only where a wrong extraction changes a decision — papers
that anchor likelihoods, decide close-prior verdicts, or carry a central claim.
Routine breadth reading — `supporting` / `background` roles, and core papers whose
role is context rather than decision — stays single-reader by default.

## What this skill is NOT

- Not a new literature subsystem — it orchestrates existing recipes + provider tools and
  fills the existing KB note template; it adds no `*-mcp` tool.
- Not a substitute for reading. It is the discipline that makes the deep-read happen and
  makes its depth checkable (filled fields + computed coverage + referential-integrity).
- Not the citation verifier — that is `claim-grounding`. This skill produces the notes and
  the survey; claim-grounding verifies the claims in them.
