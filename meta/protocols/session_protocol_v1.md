# Session Protocol v1 — Research Session Entry Convention

> UX-06: Agent behavior protocol for guiding users through the HEP research pipeline.
> This is a **documentation-only** artifact — it defines recommended workflows, not runtime code.

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

**Recommended tools**:
- `inspire_search` — broad keyword survey
- `inspire_research_navigator(mode=discover)` — topic discovery
- `inspire_research_navigator(mode=field_survey)` — landscape mapping
- `inspire_research_navigator(mode=topic_analysis)` — trend analysis

**Typical flow**:
1. User describes interest → Agent identifies relevant keywords
2. Run broad search to gauge activity level and recency
3. Identify gaps, tensions, or emerging directions
4. Propose 2-3 specific research questions with justification

**Exit criterion**: A concrete research question or hypothesis is formulated.

### Stage 2: Literature Survey

**Preconditions**: A research topic/question from Stage 1.

**Recommended tools**:
- `inspire_search` / `inspire_search_next` — targeted queries
- `inspire_literature(mode=get_references)` — reference chains
- `inspire_literature(mode=get_citations)` — forward citations
- `inspire_research_navigator(mode=network)` — citation networks
- `inspire_research_navigator(mode=experts)` — key researchers
- `inspire_deep_research(mode=analyze)` — deep paper analysis
- `inspire_critical_research(mode=evidence)` — evidence grading
- `inspire_critical_research(mode=conflicts)` — measurement conflicts
- `hep_import_from_zotero` — import from user's Zotero library

**Typical flow**:
1. Seed search from Stage 1 findings
2. Explore reference/citation chains for key papers
3. Analyze top papers for methodology and results
4. Grade evidence quality; detect conflicts or tensions
5. Build a curated paper set

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
- `inspire_deep_research(mode=write)` — end-to-end writing pipeline
- `hep_run_writing_*` tools — fine-grained writing control
- `hep_render_latex` — LaTeX compilation
- `hep_export_project` — export for arXiv submission

**Typical flow**:
1. Create a project and run
2. Build evidence artifacts (paperset, claims, critical summary)
3. Generate outline candidates → judge → select
4. Write sections with evidence grounding
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
| "I want to study/research/investigate X" | Stage 1 (Idea) | Start discovery workflow |
| "Find/search papers on X" | Stage 2 (Literature) | Start targeted search |
| "Compute/derive/calculate X" | Stage 3 (Derivation) | Identify relevant papers first |
| "Write a paper about X" | Stage 4 (Writing) | Check prerequisites, start pipeline |
| "Review/revise the draft" | Stage 5 (Review) | Locate existing draft artifacts |

## Cross-Stage Transitions

The agent should suggest stage transitions when:
- Stage 1 → 2: A research question is clear → "Shall I search for relevant papers?"
- Stage 2 → 3: Key papers identified → "Ready to analyze equations and reproduce?"
- Stage 3 → 4: Computations validated → "Shall I start the writing pipeline?"
- Stage 4 → 5: Draft compiled → "Ready for review?"
