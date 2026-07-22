---
name: citation-triangulation
description: Cross-index triangulation of citation metadata. For a citation entry under test, fetch canonical metadata for the same work from two or more independent bibliographic indexes, write one JSON block per provider, and run a deterministic offline comparator that emits a per-field agree/disagree/missing matrix with a fail-closed verdict (consistent / conflicted / insufficient_sources). Catches wrong-version, wrong-author, spliced, and hallucinated citation entries whose metadata cannot agree across indexes. Run before freezing a bibliography, during referee spot-checks, or when admitting papers into a literature-review core set.
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

- Before freezing a bibliography for a manuscript or report.
- During a referee-style spot-check of someone else's reference list.
- When `deep-literature-review` admits a paper into the core set: triangulate
  the entry once at intake, before it becomes load-bearing.
- Whenever a citation was produced by an LLM or copied from an unverified
  source and is about to enter a durable artifact.

## Procedure

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
   truncates the author list (an "et al." tail), set `authors` to `null`
   rather than feeding a truncated list.

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

6. **Bind the human-facing entry separately.** A `consistent` matrix says that
   the provider records agree with one another; it does not by itself prove
   that the title, authors, identifier, and URL displayed to the reader match
   those records. Before citation grounding can pass, feed the displayed fields
   and the hash-bound canonical metadata into the `claim-grounding` citation
   identity check. A mismatch is a hard failure even if the linked paper's full
   text supports the prose claim. Reusing one canonical identifier under two
   different displayed titles is a conflict, not two acceptable aliases.

## Comparison semantics

Key fields — `title`, `authors`, `year`, `doi` — drive the verdict; each is
compared after deterministic normalization:

- **title** — case folding plus common LaTeX and Unicode symbol folding
  (accent macros and combining accents, greek letters, superscripts and
  subscripts, dashes, math-mode wrappers). The comparison is
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

- Not a network client. The comparator never fetches anything; the agent
  fetches, transcribes, and stays accountable for the inputs. This keeps the
  check deterministic and testable.
- Not a re-implementation of any provider tool: the atoms listed above
  already fetch metadata; this skill defines the interchange block, the
  normalization rules, and the fail-closed verdict.
- Not a venue-agreement gate: venue never enters the verdict, and
  citation-style/formatting hygiene belongs to bibliography tooling. The
  publication-status check above reads venue evidence, but only as an
  advisory flag.
- Not a shared contract. The block schema is v1, validated by the comparator
  itself; it graduates to a shared contract only when a second code consumer
  appears.
