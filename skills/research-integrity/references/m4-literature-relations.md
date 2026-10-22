Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M4: shortcut_reliance

**Definition.** A relationship claim about papers — "X cites Y", "Y is
a review of Z", "this is the seminal paper on Q", "field W mostly
disagrees with claim V" — made without consulting the citation or
reference graph.

**Signs.**
- "Most papers in this area cite X." with no citation-graph call.
- "Y is the standard reference." with no review-classification call.
- "Z built directly on W's work." with no chronological +
  citation-edge check.
- "These two communities cite each other heavily." with no
  network-analysis call.

**Minimum disconfirming check.** For each relationship claim, trace
the edge in the citation graph. Web-search snippets are candidates,
not authorities; they may be derivative summaries of derivative
summaries. The graph itself is the authority. Route graph queries by
the **discipline of the papers in the relationship**, not by tool
name. As in M2, prefer the broadest provider first and fall back to
a discipline-specific graph only when it adds something the broad
provider cannot:

- **Cross-domain default graph** → OpenAlex. Use
  `openalex_citations` / `openalex_references` for direct edges and
  `openalex_search` + `openalex_filter` for typed queries. This is
  the right starting point for non-HEP literature (ML, biomed,
  cond-mat, math, social science, etc.) and is also a usable
  fallback for HEP papers indexed in OpenAlex.

- **HEP-specialised graph** → INSPIRE. When both endpoints of the
  relationship are HEP papers (e.g. `hep-ph`, `hep-th`, `hep-ex`,
  `hep-lat`, lattice QCD, HEP collaborations, phenomenology), the
  INSPIRE citation graph is denser and carries HEP-specific
  metadata that OpenAlex lacks. Use
  `inspire_literature(mode=get_citations)` /
  `(mode=get_references)`, `inspire_find_connections`,
  `inspire_network_analysis`, `inspire_classify_reviews`,
  `inspire_analyze_citation_stance`. `inspire_classify_reviews`
  operates on INSPIRE-resident papers; treat its judgments as
  authoritative only for relationships fully inside HEP.

- **Cross-discipline relationship** (HEP paper cited by an ML
  paper, biomed paper using statistical methods from physics, etc.)
  → query both graphs and reconcile. `inspire_find_crossover_topics`
  is useful when the *HEP side* of the crossover is the focus; for
  the reverse direction (non-HEP discipline finding HEP-adjacent
  work) OpenAlex network queries are typically more complete.

**Required evidence calls.** At least one citation-graph call per
relationship claim, routed to the appropriate graph by the
discipline rule above. A graph call to the wrong provider (e.g.
asking INSPIRE about a NeurIPS ML paper that is not in INSPIRE) is
not a check — it is a guaranteed miss.
