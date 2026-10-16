---
name: citation-triangulation
description: Cross-index triangulation of citation metadata. For a citation entry under test, fetch canonical metadata for the same work from two or more independent bibliographic indexes, write one JSON block per provider, and run a deterministic offline comparator that emits a per-field agree/disagree/missing matrix with a fail-closed verdict (consistent / conflicted / insufficient_sources). Catches wrong-version, wrong-author, spliced, and hallucinated citation entries whose metadata cannot agree across indexes. Run at write time whenever a citation enters any durable text (manuscripts, notes, lecture material, reading lists, notebooks, overviews), before freezing a bibliography, during referee spot-checks, or when admitting papers into a literature-review core set. One command (fetch_citation_records.py) runs steps 1–5 of the check; a book path covers ISBNs and publisher-registered book records.
---

# Citation Triangulation (cross-index metadata agreement)

A citation entry that really denotes one published work has canonical metadata
that independent bibliographic indexes agree on. When the same identifier
resolves to different titles, author lists, years, or DOIs across indexes, the
entry is suspect: a wrong version, a wrong author list, a splice of two real
papers, or a hallucinated reference. This skill turns that observation into a
machine check: fetch the same work's metadata from several indexes, then run a
deterministic comparator over the per-provider records.

Division of labor with `claim-grounding`: claim-grounding verifies that a cited
source's **content** substantiates a specific statement; this skill verifies
that the citation **entry itself** denotes one consistently indexed work. A
citation can pass triangulation while failing grounding (real paper, wrong
claim) and vice versa (right idea, mangled reference). Existence-level
resolution (does the identifier resolve at all — for example
`inspire_validate_bibliography`) is a prerequisite third check, not a
replacement for either.

## When to run

- At write time, whenever a citation enters any durable text — a manuscript,
  a research note, lecture material, a reading list, a notebook entry, an
  overview. The document type does not matter; a reader follows those
  references too. Research-project lifecycle events (plan, contract,
  approvals, final conclusions) are additional checkpoints, not the only
  triggers.
- Before freezing a bibliography for a manuscript or report.
- During a referee-style spot-check of someone else's reference list.
- When `deep-literature-review` admits a paper into the core set: triangulate
  the entry once at intake, before it becomes load-bearing.
- Whenever a citation was produced by an LLM or copied from an unverified
  source and is about to enter a durable artifact.

## Procedure

The default way to run steps 1–5 is the one-command script described below
(`fetch_citation_records.py`): it fetches, transcribes, and compares without a
hand in the loop. Fall back to, or supplement with, the manual steps whenever
the script cannot address an entry (one that carries no DOI, arXiv identifier,
record number, journal reference, or ISBN) or cannot reach the evidence a rule
requires (for example the second catalogue an ISBN-only book needs), and say
so in the run notes.

1. **Pick at least two independent providers** that index the work. Any source
   that returns canonical bibliographic metadata qualifies; the comparator is
   provider-agnostic. Ready-made atoms in this ecosystem:

   | Provider | Fetch canonical metadata with |
   | --- | --- |
   | arXiv | `arxiv_get_metadata` (title, authors, abstract, categories) |
   | OpenAlex | `openalex_get` (accepts DOI, OpenAlex ID, and other IDs) |
   | INSPIRE (one domain example) | `inspire_literature` (mode `lookup_by_id` takes a DOI, arXiv ID, or record ID) |
   | Local reference library | `zotero_find_items` (the as-recorded entry under test) |

   Public indexes without a ready-made atom here (for example Crossref or
   Semantic Scholar) work exactly the same way: obtain the record by whatever
   means the host provides and write it as one more provider block. Two
   providers are the floor; three or more strengthen the verdict.

2. **Admit a fetched record as denoting the same work — before transcribing
   it.** An identifier lookup that resolves is authoritative. A title search
   is not: its top hit is a candidate, and an over-admitted wrong-paper
   record poisons every downstream comparison — the comparator then
   faithfully reports disagreements about a work that was never the one
   being cited. Admit a search candidate only when at least one of these
   holds against the entry under test:

   - its DOI equals the entry's DOI (under the normalization below), or
   - its title matches the entry's title strongly after normalization, or
   - its title matches weakly and at least one author family name is shared.

   The working rule: **retrieval admission must be at least as strict as the
   comparison it feeds.** A bare title-similarity gate with no identifier or
   author corroboration sits below the comparator's strictness and admits
   near-title neighbors (a survey of the cited work, a follow-up paper, an
   unrelated paper with a generic title). In a public benchmark evaluation
   of this skill as a citation-hallucination detector, wrong-paper records
   admitted through such a gate caused roughly three-fifths of all false
   flags; the rule above removed that class. (That evaluation's adapter read
   a normalized title similarity of at least 0.85 as strong and at least
   0.60 as weak; the exact scale matters less than the shape — identifier
   equality, or overwhelming title agreement, or title plus author
   corroboration.)

   A provider whose search returns no admissible candidate contributes no
   block — never the least-bad hit. Note the outcome next to the run
   ("queried, no admissible match"): consistent absence across independent
   indexes is itself evidence about the entry, while a wrong record admitted
   to fill the slot is only noise.

3. **Write one JSON block per provider** with the fetched values. Every field
   key must be present; anything the provider does not supply is an explicit
   `null` — never an absent key, and never a guessed value. If a provider
   truncates the author list (an "et al." tail, a "+N more" marker, a tool's
   compact projection that keeps only the first few names), set `authors` to
   `null` rather than feeding a truncated list. The same no-completion rule
   holds for every field: a value the fetched record did not supply — an
   author, a volume, a page range, an edition, a series number, a chapter —
   is `null`, never filled from memory or from a different record.
   Completing such a field is a hallucination even when the completion
   happens to be right (`research-integrity` M2).

   ```json
   {
     "citation_key": "smith2021",
     "providers": [
       {
         "provider": "arxiv",
         "title": "Study of the $\\alpha$ decay",
         "authors": ["J. Smith", "A. de Groot"],
         "year": 2021,
         "doi": "10.1103/PhysRevD.104.114034",
         "venue": null,
         "identifier": "2109.01038"
       },
       {
         "provider": "openalex",
         "title": "Study of the α decay",
         "authors": ["John Smith", "Anna De Groot"],
         "year": 2021,
         "doi": "https://doi.org/10.1103/physrevd.104.114034",
         "venue": "Physical Review D",
         "identifier": "W1234567890"
       }
     ]
   }
   ```

   Blocks may live in one file (as above) or one file per provider; the
   comparator concatenates all blocks it is given. Transcribe faithfully —
   copying values by hand and "fixing" them in passing defeats the check.

4. **Run the comparator** (offline, deterministic, standard library only — it
   performs no network calls and sees only the JSON it is fed):

   ```bash
   SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/citation-triangulation" ] && echo "$r/skills/citation-triangulation" && break; done || true)}"
   python3 "$SKILL_DIR/scripts/bin/triangulate_citation.py" blocks.json \
     --out-json artifacts/citation_triangulation/smith2021.json \
     --out-md artifacts/citation_triangulation/smith2021.md
   ```

   Both reports are written atomically. Keep them with the run's artifacts so
   the verdict is auditable next to the inputs that produced it.

5. **Disposition by verdict** (the exit code is fail-closed so upstream
   automation can gate on it):

   | Verdict | Exit | Disposition |
   | --- | --- | --- |
   | `consistent` | 0 | Entry may be frozen / admitted. |
   | `conflicted` | 1 | Stop. Inspect the matrix, identify which provider record actually matches the work being cited, and fix the entry (or drop the citation). Do not average the records. |
   | `insufficient_sources` | 2 | Not a pass. Add another index, or record explicitly that the entry rests on a single source. |
   | invalid input | 3 | Fix the block schema; the comparator refuses to guess. |
   | report write failure | 4 | At least one report could not be persisted; fix the failing output path and re-run — the comparator is deterministic and overwrites cleanly. |
   | internal failure (either script crashed) | 5 | Not a verdict. Fix the tool or the environment and rerun; never read the crash as a result. |

6. **Bind the human-facing entry separately.** A `consistent` matrix says that
   the provider records agree with one another; it does not by itself prove
   that the title, authors, identifier, and URL displayed to the reader match
   those records. Before citation grounding can pass, feed the displayed fields
   and the hash-bound canonical metadata into the `claim-grounding` citation
   identity check. A mismatch is a hard failure even if the linked paper's full
   text supports the prose claim. Reusing one canonical identifier under two
   different displayed titles is a conflict, not two acceptable aliases.

7. **Bind verification claims to the reports.** In internal records or the
   final conversation, name the `report.md` / `summary.md` written here, or
   the `claim_grounding_report_v1`, when reporting that a check was performed.
   A bare "all references verified" with no report behind it is itself an
   unverified claim and an M2 failure (`research-integrity`). Keep internal
   paths and verification-process claims out of ordinary deliverables. If the
   recipient explicitly requests verification material, cite only report
   filenames or links they can access in that material.

## Running the check as one command

Steps 1–5 are executable without transcribing anything by hand.
`fetch_citation_records.py` (standard library only, like the comparator)
takes the citation's identifiers, queries the public APIs directly, saves the
final response of every lookup byte-exact with its SHA-256 (retry attempts are
logged with status, size and hash), writes the provider blocks, cross-checks
every supplied identifier against every admitted record, and runs the
comparator:

```bash
python3 "$SKILL_DIR/scripts/bin/fetch_citation_records.py" \
  --id doi:10.1000/example.123 --id arxiv:2109.01038 \
  --citation-key smith2021 --out-dir artifacts/citation_triangulation/smith2021
```

Identifier forms: `doi:` (bare `10.…` and `https://doi.org/…` also work),
`arxiv:`, `inspire:<record number>`, `jref:<journal>,<volume>,<page or
article id>` (a journal reference, resolved through the domain index's
journal search and admitted only when exactly one record matches; the
journal part must use that index's own abbreviated title — another spelling
is reported as partial evidence, never silently matched — and a numeric page
range denotes its start page), and `isbn:` for books. An arXiv version suffix (`v2`) is normalized away at fetch
time and the fetched version is kept only as a report-only detail; binding the
cited version is step 6's job. For a whole reference list, `--manifest refs.jsonl` (one
`{"citation_key": …, "identifiers": […]}` object per line) writes one
sub-directory per citation plus `summary.json` / `summary.md`.

What it writes, per citation: `raw/<provider>.*` with a `.meta.json` (the URL
asked for and the URL that finally served the bytes, HTTP status, hash), `blocks.json` (validated by the comparator's own
loader), `fetch_log.json` (what was asked, what each provider returned,
which derived identifiers were followed, and report-only details such as
journal volume and pages, the deposit's author order, and a book's edition,
series, publisher, and ISBN), `report.json` / `report.md` (the overall
verdict: cross-index matrix plus the supplied-identifier check), and
`report.cross_index.*` (the comparator's output alone). The exit code is the
comparator's (0–4), or 5 when either script failed internally (a crash) —
never a verdict; stdout prints (unless `--quiet`) the offline re-run command, which rebuilds
the matrix and verdict of `report.cross_index.*` from `blocks.json` without
the network (only the timestamp differs) and never touches the overall report. These files
are what a "references verified" sentence points to (step 7).

Expect `conflicted` on `year` (and sometimes `title`) when a DOI and a
preprint identifier are run together for a work that was later published:
the preprint record's `published` date supplies the first version's year,
and the title it returns is the latest preprint version's, which may differ
from the publication title; `year` stays a content field on purpose (see
Comparison semantics). That outcome is the normal adjudication case for the
publication-status check below, not a sign that the citation is wrong.

Resolution is fail-closed, as in step 2: an identifier lookup that returns
one record is admitted; a search that returns zero or several hits, or whose
reported total disagrees with its hits, contributes no block; a record whose
author list the provider truncated (author count larger than the names
returned, or an explicit "et al." marker in the list) gets `authors: null`.
A record that contradicts an identifier the caller supplied, or the
identifier it was itself fetched by (a record number whose publication DOI is
not the supplied DOI, an edition whose ISBNs do not include the supplied one,
a chained lookup that resolved to a different identifier), is withdrawn and the
verdict is forced to `conflicted` — the cross-index comparison alone cannot
see that. Two further identity rules close the remaining gaps: a record must
positively show the identifier it was fetched by, or it is withdrawn; and
every supplied identifier must be positively matched by at least one admitted
record, or the run cannot pass as `consistent` (volume-and-page agreement
without the journal name counts as partial evidence, not a match). An output directory that
already holds a run's artifacts is refused unless `--overwrite` is given, so
two generations never mix. After
the direct lookups, if the fetched records yield exactly one distinct DOI (or
one arXiv identifier) that the caller did not supply, it is followed for one
further hop to providers not yet queried, and the chain is recorded in
`fetch_log.json`. A wrong record admitted at the first hop would then yield
consistent records for the wrong work — only step 6, binding to the
displayed entry, catches that.

The public endpoints (Crossref, OpenAlex, INSPIRE, the arXiv query API,
Open Library) are reachable directly; the script configures no proxy. The
standard library honours the usual proxy environment variables if an
operator's network needs them, and `--mailto` (or `CITATION_FETCH_MAILTO`)
identifies the caller to the polite pools of Crossref and OpenAlex.

## Comparison semantics

Key fields — `title`, `authors`, `year`, `doi` — drive the verdict; each is
compared after deterministic normalization:

- **title** — case folding plus common LaTeX and Unicode symbol folding
  (accent macros and combining accents, greek letters, superscripts and
  subscripts, dashes, math-mode wrappers); relation symbols (=, <, >, ≤, ≥,
  ≈, ≃, ≡, ∝, ≪, ≫, ∼, ∈ and their LaTeX spellings) fold to distinct tokens rather than
  vanishing, and a negation — a precomposed ≠-type symbol, a combining
  overlay, or LaTeX `\not` — folds to the same "not" form in every spelling,
  so "A = B" and "A ≠ B" stay different titles (the tokens are ordinary
  words, so the word "in" or the abbreviation "Eq." folds like ∈ or =). Mathematics beyond these
  relations is still folded lossily; when a title is itself a formula, read
  the full raw values in `report.json` (the Markdown table truncates cells
  to 80 characters). The comparison is
  whitespace-insensitive because LaTeX markup and Unicode spellings tokenize
  differently around superscripts and hyphenation. The folding is
  deliberately lossy: letter case of symbols is not diagnostic (an uppercase
  and a lowercase greek letter fold to the same token), a symbol and its
  spelled-out homograph fold together, and folding covers Latin and Greek
  script only — a mixed-script title is not reliably compared, so eyeball
  the raw title row when scripts beyond those appear.
- **authors** — author count plus the ordered family-name sequence, with
  name particles (van, de, della, ...) folded into the family name and
  generational suffixes (Jr., III, ...) folded out in both comma and
  natural-order forms. A bare lowercase-particle family ("de Groot") is
  kept whole, while a capitalized head token on a bare name is read as a
  given name ("Van Morrison" yields Morrison). Initials versus full given
  names are tolerated by design, so "J. Smith" matches "John Smith".
  Consequence: two different people sharing a family name and position
  would not be flagged — eyeball the raw author rows in the report when
  the stakes are high.
- **year** — integer equality; an off-by-one year is a real disagreement
  (preprint year versus journal year is a version discrepancy worth seeing).
- **doi** — case-insensitive equality after stripping URL and `doi:`
  prefixes; URL forms also lose their query/fragment tail and
  percent-encoding, which are transport artifacts rather than part of the
  DOI name. A preprint-registry DOI (the DataCite-registered
  `10.48550/arxiv.` prefix) additionally drops a trailing version suffix
  (`v1`, `v2`, ...):
  that registry's identifier denotes the work, not a version of it, so the
  versioned and unversioned spellings must compare equal. The fold applies
  only under that prefix — elsewhere a trailing `v` plus digits can be a
  legitimate part of the registered name.

`venue` and `identifier` are **report-only** and never enter the verdict:
indexes abbreviate and rename venues inconsistently (the same journal appears
as its full name, its standard abbreviation, or a house variant), and
provider-native identifiers are not comparable across providers. They are
shown in the matrix so a human can spot, for example, a preprint record being
compared against a journal record.

Per-field status is `agree` (two or more providers supplied comparable values
and all pairwise comparisons match), `disagree` (any pairwise mismatch), or
`missing` (fewer than two providers supplied the field). The verdict is
`conflicted` if any key field disagrees; `insufficient_sources` if fewer than
two provider records were given or no key field has two comparable values;
`consistent` otherwise.

## What a verdict means — and does not mean

- `consistent` certifies **metadata agreement across the indexes consulted**.
  It does not certify that the displayed entry matches those records, that the
  paper supports any claim (those are separate `claim-grounding` gates), or
  that the citation is the *right* work to cite.
- `conflicted` is a stop signal, not a coin flip. The matrix names the
  disagreeing provider pairs; resolve the conflict by looking at the actual
  work (which version, which author list), then correct the entry at its
  source (reference library, bibliography file) so the fix propagates.
- Indexes are not fully independent — several ingest from the same upstream
  metadata feeds. Agreement between two indexes that mirror each other is
  weaker evidence than agreement between an index and the publisher record;
  prefer provider sets with distinct provenance when available.

## Field authority for identity (which record wins on author order and title)

Indexes disagree on author order and titles more often than on DOIs, and a
`conflicted` matrix has to be settled against something. Authority runs in
this order; the comparator's report-only columns exist so a human can apply
it:

1. **The work itself** — its title page or full text — for author order,
   title, and edition statement. Open it; nothing below outranks it.
2. **The publisher's deposited record** (Crossref for articles and for
   publisher-registered books and chapters; the publisher's own table of
   contents for a book).
3. **Landing pages and secondary indexes** (abstract pages, aggregator
   records, library catalogues) last.

A deposit or a landing page may list a presenting or corresponding author
first while the paper's own title page gives a different order; a search
result's summary line is a display, not a source. Correct the entry at its
source after deciding, and note which authority decided it.

## Books (edition, series, volume, chapter, translation)

Books are where fields completed from memory cluster: edition, series
volume, reprint year, translation, chapter pointer. The path above applies
unchanged, with these sources:

| What is cited | Fetch the record with |
| --- | --- |
| A book or chapter with a publisher DOI | Crossref (types `book`, `monograph`, `book-chapter`) and OpenAlex by that DOI |
| An ISBN | Open Library's edition record (`isbn:` in `fetch_citation_records.py`); the record is edition-level, so a different edition is a different record |
| Edition / series / chapter detail | The publisher's table of contents or the book's own front matter; the catalogue records above expose `edition_name`, `series`, `publishers`, `publish_date` as report-only details in `fetch_log.json` |

Rule: an edition number, series volume, chapter title or number, reprint
year, or translation detail enters the entry only when two independent
sources agree on it; otherwise it is omitted, not guessed. The comparator
does not adjudicate these fields — compare them by eye from the saved raw
records — and an ISBN alone yields one catalogue record, so a book entry
needs a publisher DOI or a second catalogue to reach two sources.

## Follow-up checks the matrix supports

Two verified read-outs of the report go beyond the verdict — one guards
against over-rejection, the other against under-rejection.

**Identifier-only disagreement is not yet a conviction.** A work that moved
from a preprint server to a journal legitimately carries two identifiers —
the preprint registry's DataCite DOI (`10.48550/...`) and the publisher's
DOI — and indexes differ in which one they surface. When `doi` is the only
disagreeing key field while every content field (title, authors, year)
agrees, that alone is not sufficient evidence of a metadata conflict: check
whether the two values are the preprint/publisher pair for one work before
rejecting the entry. Version spellings are part of the same trap; the
comparator folds them under that registry's `10.48550/arxiv.` DOI prefix
(one unfolded version suffix once manufactured ten spurious conflicts in a
single public-benchmark run). What remains serious is two *publisher* DOIs
disagreeing on otherwise-agreeing content — an identifier pointing at some
other work than the one the text describes. And `year` stays a content field
on purpose: preprint year versus journal year is a real discrepancy worth
seeing, and fabricated dates live in that field.

**Preprint presented as published.** When the entry under test claims a
journal or proceedings venue but every index venue actually on record is a
preprint marker, treat that as a strong signal that a preprint is being
dressed up as a published paper. Records whose venue is empty contribute no
evidence to this check: an index that is silent about venue has not said
"preprint" — when no record carries a venue at all, the status simply
cannot be checked and no flag is raised.
The check is advisory and stays outside the verdict — venue naming varies
too much across indexes to carry one — and it has a known false-alarm mode:
a genuinely published work whose published record simply did not surface
among an index's top search hits. So flag the entry for confirmation against
the publisher's record; do not auto-reject. When the entry and at least one
index both name a non-preprint venue, compare venues conservatively before
flagging a mismatch: tokenize, drop filler words (proceedings,
international, conference, ...), let an abbreviated token match as a prefix
of the full word, compare initialisms built from the remaining tokens, and
as a last resort accept a lenient fuzzy match between the concatenated
names and initialisms — err toward matching. Flag only when nothing
matches. In the same public-benchmark evaluation this
conservative venue comparison raised 46 flags with zero false alarms; the
value is in the conservatism, because indexes rename and abbreviate venues
freely.

## What this skill is NOT

- Not a network client in its verdict step. The comparator never fetches
  anything; `fetch_citation_records.py` is the one network step, and it
  saves the final response of every lookup so the cross-index verdict is
  reproducible offline from the saved blocks into `report.cross_index.*`
  (the supplied-identifier check lives in the overall `report.*` and
  `fetch_log.json`, which the comparator alone does not reproduce). The
  agent stays accountable for the inputs either way.
- Not a replacement for the provider atoms in interactive use: they remain
  the way to explore a record; `fetch_citation_records.py` exists so that the
  check leaves artifacts without hand transcription. This skill defines the
  interchange block, the normalization rules, and the fail-closed verdict.
- Not a venue-agreement gate: venue never enters the verdict, and
  citation-style/formatting hygiene belongs to bibliography tooling. The
  publication-status check above reads venue evidence, but only as an
  advisory flag.
- Not a shared contract. The block schema is v1, validated by the comparator
  itself; it graduates to a shared contract only when a second code consumer
  appears.
