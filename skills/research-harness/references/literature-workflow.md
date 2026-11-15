# Literature research

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Match the evidence to the question

For a fixed-source reading or comparison, identify the actual papers and versions,
read the original material needed for the answer, and record claim-supporting
sections, equations, tables or pages. Check definitions, assumptions, uncertainty
conventions and any calculation the answer depends on. A question about two
specified papers does not by itself require a field-wide survey or saturation
artifact. Do not turn their agreement into a claim about the whole literature.

For literature discovery, coverage, priority, influence, relationships or research
gaps, use the relevant domain workflow and its provider evidence. Web search can
discover papers, experimental pages, proceedings, code and non-indexed material.
Before making literature-map claims, normalize core papers to stable identifiers
and inspect the relevant citation/reference graph. Graphs provide relationship
evidence; read the sources needed to establish the scientific claim itself.

For a physics literature survey using `hep-mcp`:

- Treat `50` as a default page/initial-batch size, not a completion threshold. Record provider coverage, candidate-pool rationale and citation/reference graph checks in the existing saturation artifact before claiming the survey complete.
- For each seed or core paper, check both directions when relevant: papers it references and papers citing it.
- For claims about paper relationships, source priority, review status, influence or literature gaps, inspect provider records and the relevant graph; search snippets alone do not establish these claims.

Resolve reference identity and metadata for cited sources, including a fixed
reading set. For physics writing, use `hep-mcp` provider routes for citekeys and
BibTeX when available; preserve authoritative metadata and complete the applicable
claim-grounding and citation-triangulation checks. A project's adopted formal
team or literature workflow still owes its configured trace and saturation gates;
this routing guidance does not waive or rewrite those executable requirements.

Useful `hep-mcp` routes include:

- Resolve identifiers first through the available provider route: INSPIRE recid, arXiv id, DOI, or OpenAlex id.
- INSPIRE citation/reference graph when covered: `inspire_literature(mode=get_references, recid=...)` and `inspire_literature(mode=get_citations, recid=..., sort=...)`.
- Cross-paper graph inside the provider layer: `inspire_find_connections` or `inspire_network_analysis`.
- arXiv/source checks: use arXiv/provider routes for preprints, versions, and source text when the task depends on the actual paper source.
- OpenAlex/cross-domain checks: use OpenAlex/provider routes when the paper is outside clean INSPIRE coverage or when broader cross-field citations may matter.
- Citekeys and BibTeX for cited recids: `inspire_resolve_citekey`; batch identifier-to-recid mapping written into the project: `hep_inspire_resolve_identifiers` with `project_root` and an `output_dir` under the current run directory (e.g. `artifacts/runs/<run_id>/literature`).

Use available original-file access when provider transport is unavailable. State
missing coverage or metadata checks explicitly, and limit the claims accordingly;
do not present an unread source, unchecked identity or incomplete graph as verified.
