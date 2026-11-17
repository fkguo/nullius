# Session Protocol v1 — Research Session Entry Convention

> UX-06: Optional HEP session guidance. The host primary agent chooses the work from the scientific question and available evidence. A fixed-paper question or a simple search can use provider tools directly; it does not require a recipe or a full literature survey.

> When the project explicitly adopts one of the fixed `@nullius/literature-workflows` recipes, `nullius workflow-plan` resolves and persists its steps. Resolution does not author research content or feed search results into later record-ID inputs. Provider mappings differ by action; no provider parity is implied.

> The old provider-local literature-gap shell is deleted. `nullius workflow-plan` is the public entry for these optional recipes, with execution through a separately configured `nullius run` tool caller. Recipe definitions live under `packages/literature-workflows/recipes/`; the host owns scientific planning and synthesis.

## Stage Enumeration

A research session may draw on these stages as the task requires:

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

**Optional recipes when explicitly adopted**:
- `literature_landscape` — fixed search, topic, network and reference steps
- `literature_gap_analysis` — fixed search and analysis steps; the host must establish any claimed gap
- `research-team` — formal independent-member workflow when the project adopts it

**Recommended atomic tools**:
- `inspire_search` — broad keyword survey
- `inspire_search_next` — pagination for broad discovery
- `inspire_literature(mode=get_references|get_citations)` — citation traversal
- `inspire_topic_analysis` — trend analysis
- `inspire_network_analysis` — citation graph mapping
- `inspire_find_connections` — paper-set relationship mining
- `inspire_trace_original_source` — provenance tracing
- `hep_import_from_zotero` — import from user's local seed corpus

**Typical flow**:
1. Recover the question, current knowledge and scope; choose the necessary work, adopting a fixed recipe only when its steps fit
2. Run broad search and citation traversal to gauge activity level, recency, and landmarks
3. Use topic/network/provenance operators to find candidate relationships, then read original sources before claiming gaps or tensions
4. Propose 2-3 specific research questions with justification and seed papers

**Exit criterion**: A concrete research question or hypothesis is formulated.

### Stage 2: Literature Survey

**Preconditions**: A research topic/question from Stage 1.

**Optional recipes when explicitly adopted**:
- `literature_landscape` — bounded discovery and citation metadata for the host's reading-list work
- `literature_gap_analysis` — bounded analysis material for the host's source-based investigation

**Recommended atomic tools**:
- `inspire_search` / `inspire_search_next` — targeted queries
- `inspire_literature(mode=get_references)` — reference chains
- `inspire_literature(mode=get_citations)` — forward citations
- `inspire_network_analysis` — citation networks
- `inspire_find_connections` — paper-set relationship mining
- `inspire_trace_original_source` — provenance tracing
- `hep_import_from_zotero` — import from user's Zotero library

**Typical flow**:
1. Seed search from Stage 1 findings or a local Zotero corpus
2. Explore reference/citation chains for key papers
3. Run topic/network/provenance operators over the emerging paper set
4. Use bounded analysis outputs as leads, inspect original sources and record the actual evidence and remaining uncertainty
5. Build a curated paper set and, when needed, materialize evidence-ready exports

**Exit criterion**: A curated paper set with evidence assessment.

### Stage 3: Derivation & Computation

**Preconditions**: A defined calculation or derivation and the source material it actually depends on.

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
- `research-writer` skill — paper scaffold, section drafting, and LaTeX hygiene/compile checks
- `arxiv_paper_source` / `inspire_paper_source` — LaTeX source or PDF of a cited paper, to read claims against
- `claim-grounding` skill — check that each cited source actually supports the claim it is cited for
- `inspire_resolve_citekey` — INSPIRE citekeys and BibTeX for cited recids

**Typical flow**:
1. Read the sources of the curated paper set and record the passages (section, equation, page) each claim rests on
2. Generate outline candidates → judge → select
3. Write sections with explicit evidence grounding
4. Integrate sections → compile LaTeX

**Exit criterion**: A compilable LaTeX draft.

### Stage 5: Review & Revision

**Preconditions**: A draft from Stage 4.

**Recommended tools**:
- `referee-review` skill — independent scientific review against the manuscript and original sources
- `paper-reviser` skill — content-first revision

**Typical flow**:
1. Obtain an independent review with manuscript/source locations, or import an actual referee report
2. Create revision plan addressing each issue
3. Execute revisions with evidence grounding
4. Re-compile and verify
5. Iterate until satisfactory

**Exit criterion**: A submission-ready paper.

## Intent Recognition

When a user's first message matches these patterns, the agent should identify the stage and provide appropriate guidance:

| User Intent Pattern | Detected Stage | Agent Response |
|-------------------|---------------|----------------|
| "I want to study/research/investigate X" | Stage 1 (Idea) | Recover the question and choose useful investigation; adopt a recipe only when it fits |
| "Find/search papers on X" | Stage 2 (Literature) | Use the necessary provider search/retrieval; adopt a broader recipe only when requested or appropriate to the scope |
| "Compute/derive/calculate X" | Stage 3 (Derivation) | Identify relevant papers first |
| "Write a paper about X" | Stage 4 (Writing) | Check prerequisites, start writing/evidence workflow |
| "Review/revise the draft" | Stage 5 (Review) | Locate existing draft artifacts |

## Cross-Stage Transitions

The agent should suggest stage transitions when:
- Stage 1 → 2: A research question is clear → "Shall I search for relevant papers?"
- Stage 2 → 3: Key papers identified → "Ready to analyze equations and reproduce?"
- Stage 3 → 4: Computations validated → "Shall I start the writing pipeline?"
- Stage 4 → 5: Draft compiled → "Ready for review?"
