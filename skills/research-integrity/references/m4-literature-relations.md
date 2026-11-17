Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M4: shortcut_reliance

**Definition.** A relationship claim about papers — "X cites Y", "Y is
a review of Z", "this is the seminal paper on Q", "field W mostly
disagrees with claim V" — made without examining evidence appropriate
to that claim. A recorded citation edge and a scientific relationship
require different evidence.

**Signs.**
- "Most papers in this area cite X." with no citation-graph call.
- "Y is the standard reference." without examining its content and
  the stated scope of that judgment.
- "Z built directly on W's work." with no chronological +
  citation-edge check.
- "These two communities cite each other heavily." with no
  network-analysis call.

**Minimum disconfirming check.** For a citation claim, verify the
paper identities and the recorded edge in the reference list or
provider graph. An edge shows a citation was recorded; it does not
establish support, contradiction, scientific priority or consensus.
For those claims, read the relevant original passages, compare the
assumptions and scope, and retain the passages and locators supporting
the judgment. A claim about a field also needs a stated literature
scope and attention to counterexamples. Web snippets and metadata
help find material but do not substitute for that reading.

Choose a provider that indexes the papers and the relation needed:

- **Broad literature graph** → OpenAlex. Use
  `openalex_citations` / `openalex_references` for direct edges and
  `openalex_search` + `openalex_filter` for typed queries. This is
  useful for papers indexed there, including cross-discipline queries.

- **HEP-specialised graph** → INSPIRE. When both endpoints of the
  relationship are HEP papers (e.g. `hep-ph`, `hep-th`, `hep-ex`,
  `hep-lat`, lattice QCD, HEP collaborations, phenomenology), the
  use the INSPIRE records and their HEP metadata. Use
  `inspire_literature(mode=get_citations)` /
  `(mode=get_references)`, `inspire_find_connections`,
  `inspire_network_analysis`. Use `inspire_paper_source` and
  `inspire_parse_latex` to retrieve original material and citation
  contexts; the host assesses what those passages mean.

- **Cross-discipline relationship** (HEP paper cited by an ML
  paper, biomed paper using statistical methods from physics, etc.)
  → use the indexed sources needed for both sides and reconcile paper
  identities and missing edges. Category overlap or citation counts
  alone do not establish a scientific connection.

**Required evidence.** Retain the record or source passage that
supports each relationship claim, with its identity and locator.
Report indexing or source gaps explicitly. A successful tool call,
an absent graph edge or a classification label is not a scientific
assessment of the relationship.
