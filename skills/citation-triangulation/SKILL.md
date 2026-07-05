---
name: citation-triangulation
description: Cross-index triangulation of citation metadata. For a citation entry under test, fetch canonical metadata for the same work from two or more independent bibliographic indexes, write one JSON block per provider, and run a deterministic offline comparator that emits a per-field agree/disagree/missing matrix with a fail-closed verdict (consistent / conflicted / insufficient_sources). Catches wrong-version, wrong-author, spliced, and fabricated citation entries whose metadata cannot agree across indexes. Run before freezing a bibliography, during referee spot-checks, or when admitting papers into a literature-review core set.
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

2. **Write one JSON block per provider** with the fetched values. Every field
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

3. **Run the comparator** (offline, deterministic, standard library only — it
   performs no network calls and sees only the JSON it is fed):

   ```bash
   python3 "$SKILL_DIR/scripts/bin/triangulate_citation.py" blocks.json \
     --out-json artifacts/citation_triangulation/smith2021.json \
     --out-md artifacts/citation_triangulation/smith2021.md
   ```

   Both reports are written atomically. Keep them with the run's artifacts so
   the verdict is auditable next to the inputs that produced it.

4. **Disposition by verdict** (the exit code is fail-closed so upstream
   automation can gate on it):

   | Verdict | Exit | Disposition |
   | --- | --- | --- |
   | `consistent` | 0 | Entry may be frozen / admitted. |
   | `conflicted` | 1 | Stop. Inspect the matrix, identify which provider record actually matches the work being cited, and fix the entry (or drop the citation). Do not average the records. |
   | `insufficient_sources` | 2 | Not a pass. Add another index, or record explicitly that the entry rests on a single source. |
   | invalid input | 3 | Fix the block schema; the comparator refuses to guess. |
   | report write failure | 4 | At least one report could not be persisted; fix the failing output path and re-run — the comparator is deterministic and overwrites cleanly. |

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
  DOI name.

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
  It does not certify that the paper supports any claim (that is
  `claim-grounding`), nor that the citation is the *right* work to cite.
- `conflicted` is a stop signal, not a coin flip. The matrix names the
  disagreeing provider pairs; resolve the conflict by looking at the actual
  work (which version, which author list), then correct the entry at its
  source (reference library, bibliography file) so the fix propagates.
- Indexes are not fully independent — several ingest from the same upstream
  metadata feeds. Agreement between two indexes that mirror each other is
  weaker evidence than agreement between an index and the publisher record;
  prefer provider sets with distinct provenance when available.

## What this skill is NOT

- Not a network client. The comparator never fetches anything; the agent
  fetches, transcribes, and stays accountable for the inputs. This keeps the
  check deterministic and testable.
- Not a re-implementation of any provider tool: the atoms listed above
  already fetch metadata; this skill defines the interchange block, the
  normalization rules, and the fail-closed verdict.
- Not a venue checker or a citation-style linter; formatting hygiene belongs
  to bibliography tooling.
- Not a shared contract. The block schema is v1, validated by the comparator
  itself; it graduates to a shared contract only when a second code consumer
  appears.
