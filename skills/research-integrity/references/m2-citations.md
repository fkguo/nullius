Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M2: hallucinated_citation

**Definition.** A citation made without verifying that the paper
exists with the cited identifier, by the cited authors, in the cited
venue, in the cited year, with the cited claim — including a citation
field completed from memory, and a statement that references were
verified with no report behind it.

**Trigger.** M2 applies at write time to any durable text that carries a
citation or an attribution sentence — a manuscript, a research plan, a
note, lecture material, a reading list, a notebook entry, an overview —
not only at the lifecycle boundaries listed under "When to use". "It is
only teaching material / only a reading list" is not an exemption: a
reader follows those references too.

**Signs.**
- Citation key looks like a templated `{Authors}{Year}{Topic}` slug
  but no resolver call appears in the transcript.
- "I'm pretty sure paper X says Y" with no provider lookup backing it.
- Citation count, h-index, review status, or seminal-paper claim with
  no provider tool call.
- Bibliography assembled from web-search snippets alone, never
  cross-checked against a bibliography auditor.
- A BibTeX entry like `Vaswani2017Attention` or `Smith:2023abc` is
  accepted as proof the paper exists, with no DOI, arXiv ID, or
  provider-graph resolution actually performed.
- A reference field completed from memory: an author list finished
  behind an "et al." or a tool's truncated display, or a volume, page,
  edition, series number, chapter pointer, or translation detail that
  the fetched record did not supply. The field must be dropped or
  fetched in full; completing it is a hallucination even when the
  completion happens to be right.
- A verification claim without its artifact: prose asserting that
  references were "checked", "verified", or "confirmed" with no pointer
  to the report it rests on (a `citation-triangulation` report or
  summary, a `claim_grounding_report_v1`). The statement about
  verification is itself a claim; unbacked, it is an M2 failure of its
  own, separate from whatever the references turn out to be.
- A verification skill loaded but not executed: the triangulation or
  grounding procedure was read, yet no provider blocks, comparator run,
  or displayed-entry identity binding exists; search-result summaries
  were read instead, and "a hit with a similar title exists" was taken
  as verified.
- An attribution verb stronger than the source: "X proposed / first
  introduced Y" where the cited paper proved, applied, or reviewed Y, or
  where an earlier source exists (see `claim-grounding`, attribution and
  priority claims).

**Minimum disconfirming check.** Route by the **discipline of the
cited work**, not by tool name:

1. **Find the paper.** Use the resolver whose underlying data covers
   the cited work's discipline. If you do not know the discipline,
   prefer the broadest provider first.
   - Any DOI →  `openalex_get(id="<doi>")` (cross-domain;
     OpenAlex indexes ~240M works including HEP, ML, condensed
     matter, biomedicine, etc.).
   - Any arXiv ID → `arxiv_get_metadata` or `arxiv_search` (every
     arXiv category; not HEP-only).
   - HEP paper without DOI/arXiv → `inspire_search`
     (INSPIRE-HEP database; HEP-bound by data).
   - Other discipline (ML / cond-mat / biomed / etc.) without
     DOI/arXiv → `openalex_search` by title+author.
   - Anything still missing → `crossref` skill as cross-domain
     fallback (non-arXiv non-OpenAlex).

**Identity gate before content verification.** Bind the displayed citation to
the resolved work: record the title, authors when they are displayed,
canonical identifier, and URL that the reader will see. Compare them
deterministically with the provider metadata returned in step 1 or with a
hash-bound archived metadata record. A `citation-triangulation` report may
supply canonical metadata, but its provider-to-provider agreement does not
replace this displayed-entry comparison. Treat any
title/author/identifier/URL mismatch as a hard M2 failure. In particular, one
canonical identifier cannot pass under two different displayed titles. If
neither archived canonical metadata nor an authoritative retrieval is
available, a load-bearing citation remains unverified; network availability is
not required when the archived record is present. When sources disagree on
author order or title, authority runs: the work's own title page or full
text, then the publisher's deposited record, then landing pages and secondary
indexes; a deposit or landing page may list a presenting author first.
Index-to-index agreement cannot see this — open the work.

2. **Verify the cited claim against the paper itself**, not its
   abstract or third-party summary.
   - Any arXiv preprint (any field) → `arxiv_paper_source`.
   - HEP paper that you want INSPIRE/DOI URL enrichment for →
     `inspire_paper_source` (handler internally resolves to arXiv,
     so it also works for any arXiv-resolvable identifier; the
     extra value over `arxiv_paper_source` is INSPIRE-side
     metadata enrichment).
   - Anything else (non-arXiv) → `openalex_get` content payload,
     or `pdf-mcp` parser on the downloaded PDF.

   A successful full-text check does not repair a failure in the identity gate:
   content support and citation identity are independent, load-bearing checks.

3. **HEP-only optional finishing step.** Once the paper is confirmed
   in INSPIRE and you have an INSPIRE `recid`, you may call
   `inspire_resolve_citekey({recid})` to get the canonical INSPIRE
   Texkey and BibTeX. **This tool takes a `recid`, not a citekey
   string**; it does not verify that an existing bibtex key is real.
   It is irrelevant for non-HEP citations because non-HEP papers are
   not in INSPIRE. There is no inverse `citekey → recid` lookup tool
   either; if you only hold a BibTeX key, extract a DOI / arXiv ID
   from the citation context and resolve via step 1, or use
   `inspire_search` with `texkeys:<key>`.

4. **Bulk bibliography hygiene.** Use
   `inspire_validate_bibliography` — despite the name, its default
   mode (`scope='manual_only'`, `validate_against_inspire=false`)
   audits *non-INSPIRE* entries for **locatability** only: each
   entry must carry a DOI, an arXiv ID, or a complete
   journal+volume+pages tuple, otherwise the tool emits a
   `missing_locator` warning. It does **not** check BibTeX syntax
   or author plausibility — pair it with a separate BibTeX
   linter if you need those. INSPIRE cross-validation is an
   optional opt-in mode (`validate_against_inspire=true`). Apply
   the default locatability audit to bibliographies of any
   discipline.

**Required evidence calls.** At least one resolver or hash-bound archived
canonical metadata record per cited paper, one deterministic displayed-entry
identity comparison per human-facing citation, and at least one content-verify
call per cited *claim* (not per paper — a single paper can support many claims,
but each claim's textual ground must be opened). A load-bearing citation passes
only when both identity and content support pass. Verification claims in
internal records or the final conversation name the report artifact(s). Keep
internal paths and verification-process claims out of ordinary deliverables.
If the recipient explicitly requests verification material, cite only report
filenames or links they can access. For a
deliverable whose substance is a reference list or a citation-driven
narrative, the final evidence is an independent blind audit — a reviewer
given only the files, preferably from another model family (see
`claim-grounding`).

**INSPIRE Texkey is INSPIRE-specific.** An entry like `Smith:2023abc`
is the canonical citekey convention inside INSPIRE-HEP. BibTeX entries
for non-HEP papers do not use this convention and cannot be resolved
through INSPIRE; do not treat a missing INSPIRE record as evidence the
citation is fake when the cited work is outside HEP.
