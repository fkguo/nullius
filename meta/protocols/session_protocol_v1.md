# Session Protocol v1 — Research Session Entry Convention

> UX-06: Agent behavior protocol for guiding users through a research-session pipeline.
> This protocol is a checked-in workflow authority artifact for Stage 1-2 entry guidance and is executed through the checked-in `packages/literature-workflows` launcher plus checked-in consumers such as `research-team` and `hepar literature-gap`.

> High-level literature workflow authority for Stage 1-2 lives in checked-in workflow recipes (`meta/recipes/`) packaged as `literature-workflows`. Provider-specific MCP tools remain the bounded atomic building blocks underneath those recipes; they are not the canonical high-level workflow truth or the public front door.

## Stage Enumeration

A research session progresses through these stages:

| # | Stage | Key Intent | Entry Signal |
|---|-------|-----------|--------------|
| 1 | **Idea / Topic Selection** | Find a viable research question | "I want to study X", "what's interesting in Y" |
| 2 | **Literature Survey** | Map the relevant landscape | "find papers on X", "who works on Y" |
| 3 | **Derivation & Computation** | Reproduce / extend calculations | "derive X", "compute Y at one-loop" |
| 4 | **Writing** | Produce a paper draft | "write a paper", "draft the introduction" |
| 5 | **Review & Revision** | Referee-quality polish | "review the draft", "fix referee comments" |

## Stage Details

### Stage 1: Idea / Topic Selection

**Preconditions**: None (session entry point).

**Recommended workflow authority**:
- `literature_landscape` recipe — topic-to-reading-list / landscape mapping
- `literature_gap_analysis` recipe — gap/tension-oriented discovery framing
- `research-team` skill — consume the checked-in literature workflow recipes during prework / KB building

**Recommended atomic tools**:
- `inspire_search` — broad keyword survey
- `inspire_search_next` — pagination for broad discovery
- `inspire_literature(mode=get_references|get_citations)` — citation traversal
- `inspire_topic_analysis` — trend analysis
- `inspire_network_analysis` — citation graph mapping
- `inspire_find_connections` — paper-set relationship mining
- `inspire_trace_original_source` — provenance tracing
- `hep_import_from_zotero` — import from user's local seed corpus
- `inspire_critical_research(mode=analysis)` — bounded paper-set analysis step inside a recipe, not a high-level workflow surface

**Typical flow**:
1. User describes interest → agent selects the appropriate literature workflow recipe
2. Run broad search and citation traversal to gauge activity level, recency, and landmarks
3. Use topic/network/provenance operators to identify gaps, tensions, or emerging directions
4. Propose 2-3 specific research questions with justification and seed papers

**Exit criterion**: A concrete research question or hypothesis is formulated.

### Stage 2: Literature Survey

**Preconditions**: A research topic/question from Stage 1.

**Recommended workflow authority**:
- `literature_landscape` recipe — build a curated reading list and anchor-map
- `literature_gap_analysis` recipe — inspect tensions, omissions, and open seams
- `literature_to_evidence` recipe — turn a curated paper set into evidence-ready artifacts

**Recommended atomic tools**:
- `inspire_search` / `inspire_search_next` — targeted queries
- `inspire_literature(mode=get_references)` — reference chains
- `inspire_literature(mode=get_citations)` — forward citations
- `inspire_network_analysis` — citation networks
- `inspire_find_connections` — paper-set relationship mining
- `inspire_trace_original_source` — provenance tracing
- `inspire_critical_research(mode=analysis|evidence|conflicts|reviews|theoretical)` — bounded analysis operators underneath the recipe layer
- `hep_import_from_zotero` — import from user's Zotero library

**Typical flow**:
1. Seed search from Stage 1 findings or a local Zotero corpus
2. Explore reference/citation chains for key papers
3. Run topic/network/provenance operators over the emerging paper set
4. Apply bounded critical-analysis operators to assess evidence, conflicts, and review posture
5. Build a curated paper set and, when needed, materialize evidence-ready exports

**Exit criterion**: A curated paper set with evidence assessment.

### Stage 3: Derivation & Computation

**Preconditions**: Literature survey with identified computations to reproduce/extend.

**Recommended tools**:
- `inspire_paper_source(mode=content)` — download LaTeX sources
- `inspire_parse_latex` — extract equations and structure
- `hep-calc` skill — Mathematica/Julia calculations
- `research-team` skill — parallel computation workstreams

**Typical flow**:
1. Download and parse relevant papers' LaTeX sources
2. Extract key equations and identify calculation strategy
3. Reproduce reference calculations
4. Extend or modify for the new research question
5. Cross-validate results

**Exit criterion**: Validated computational results.

### Stage 4: Writing

**Preconditions**: Results from Stage 3 (or Stage 2 for review papers).

**Recommended tools**:
- `hep_run_create` → create a writing run
- `research-writer` skill — writing-oriented consumer of evidence artifacts
- `hep_project_query_evidence` / `hep_project_query_evidence_semantic` — section-level evidence retrieval
- `hep_render_latex` — LaTeX compilation
- `hep_export_project` — export for arXiv submission

**Typical flow**:
1. Create a project and run
2. Build or query evidence artifacts from the curated paper set / results
3. Generate outline candidates → judge → select
4. Write sections with explicit evidence grounding
5. Integrate sections → compile LaTeX
6. Export project

**Exit criterion**: A compilable LaTeX draft.

### Stage 5: Review & Revision

**Preconditions**: A draft from Stage 4.

**Recommended tools**:
- `hep_run_writing_submit_review` — submit referee report
- `hep_run_writing_create_revision_plan_packet_v1` — plan revisions
- `hep_run_writing_submit_revision_plan_v1` — execute revision plan
- `hep_run_writing_refinement_orchestrator_v1` — automated refinement
- `referee-review` skill — generate mock referee report
- `paper-reviser` skill — content-first revision

**Typical flow**:
1. Generate or submit a referee report
2. Create revision plan addressing each issue
3. Execute revisions with evidence grounding
4. Re-compile and verify
5. Iterate until satisfactory

**Exit criterion**: A submission-ready paper.

## Intent Recognition

When a user's first message matches these patterns, the agent should identify the stage and provide appropriate guidance:

| User Intent Pattern | Detected Stage | Agent Response |
|-------------------|---------------|----------------|
| "I want to study/research/investigate X" | Stage 1 (Idea) | Start `literature_landscape` or `literature_gap_analysis` |
| "Find/search papers on X" | Stage 2 (Literature) | Start a literature recipe, then descend into atomic search/provenance tools |
| "Compute/derive/calculate X" | Stage 3 (Derivation) | Identify relevant papers first |
| "Write a paper about X" | Stage 4 (Writing) | Check prerequisites, start writing/evidence workflow |
| "Review/revise the draft" | Stage 5 (Review) | Locate existing draft artifacts |

## Cross-Stage Transitions

The agent should suggest stage transitions when:
- Stage 1 → 2: A research question is clear → "Shall I search for relevant papers?"
- Stage 2 → 3: Key papers identified → "Ready to analyze equations and reproduce?"
- Stage 3 → 4: Computations validated → "Shall I start the writing pipeline?"
- Stage 4 → 5: Draft compiled → "Ready for review?"
