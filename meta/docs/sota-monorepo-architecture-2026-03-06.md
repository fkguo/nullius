# SOTA Monorepo Architecture — 2026-03-06

Status: revised with single-user loop clarification; external governance dual-review passed (`Opus`: `CONVERGED_WITH_AMENDMENTS`, `Kimi K2.5`: `CONVERGED_WITH_AMENDMENTS`; 0 blocking, clarifications integrated)  
Scope: whole `autoresearch-lab` monorepo  
Goal: update the current redesign direction so the ecosystem can credibly target end-to-end SOTA quality for automated scientific research, not only a strong local baseline.

---

## 1. Executive Summary

The monorepo already has several unusually strong foundations:

- evidence-first artifacts and auditability;
- strict schema discipline and fail-closed gates;
- pluggable scholarly providers (`INSPIRE`, `arXiv`, `OpenAlex`);
- MCP-sampling-based semantic adjudication instead of provider SDK sprawl;
- an explicit eval culture (`NEW-RT-05`, holdouts, baselines, review convergence).

However, the current redesign still falls short of an honest end-to-end SOTA claim.

The biggest missing clarification is product priority.
Near-to-mid-term, the primary product is **a single-user research system** that can collaborate with a researcher or continue autonomously after an initial instruction.
Its execution core must model a **nonlinear research loop** — search, read, generate/refine ideas, compute, challenge assumptions, search again, write, review, revise — rather than a one-pass stage pipeline.
`agent-arxiv` and `REP` remain important, but as **later outer layers** built on top of that single-user substrate.

The largest gap is therefore not only "LLM semantic understanding" alone. The new bottlenecks are the execution spine plus the full retrieval-and-discovery stack:

1. the near-term execution kernel is still easy to read as stage-linear rather than loop-native;
2. scholarly discovery is still provider-local rather than federated;
3. evidence retrieval is stronger than old regex/substring baselines, but not yet dense / late-interaction / cross-encoder grade;
4. model/runtime routing remains too Anthropic-shaped at the orchestrator layer;
5. `agent-arxiv` is planned as a local search index rather than as the top layer of a shared retrieval/knowledge substrate;
6. `idea-core` librarian retrieval is still template-driven and should not become the long-term architecture.

The right move is not to discard the current redesign, but to extend it with four first-class tracks:

- a **Single-User Research Loop Runtime** for nonlinear, event-driven research execution;
- a **Federated Scholar Discovery** layer over `INSPIRE + OpenAlex + arXiv`;
- a **Retrieval Backbone Upgrade** that turns current `SEM-06` into a multi-stage retrieval program;
- a **Provider-Agnostic Model Routing** layer for both orchestrator and MCP-sampling consumers.

---

## 2. What “SOTA” Should Mean Here

For this project, "SOTA" should not mean "uses LLMs everywhere".
It should mean the near-term product — a single-user research system, whether interactive or autonomous after an initial user instruction — approaches current best practice across the whole research loop:

- literature discovery quality;
- evidence retrieval quality;
- claim/evidence/stance/conflict adjudication quality;
- long-document grounding quality;
- cross-source canonicalization quality;
- reproducibility, auditability, and regression control.

A system that has excellent semantic adjudication but weak candidate discovery or weak reranking should be described as a **strong semantic research platform**, not full end-to-end SOTA.

---

## 3. Current Monorepo Assessment

### 3.1 Already aligned with a SOTA trajectory

- `arxiv-mcp` and `openalex-mcp` are correctly designed as standalone provider packages and aggregated upward rather than embedded into a monolith.
- `hep-mcp` already centralizes evidence-oriented research tools and is the right place for the semantic evidence pipeline.
- `SEM-01/02/03/04/05` move semantic authority from regex/closed lists to explicit adjudication and calibrated abstention.
- MCP sampling (`ctx.createMessage`) is the correct server-side abstraction for LLM semantics.
- Evidence-first storage and append-only logs are major strategic advantages for scientific settings.

### 3.2 Main architectural weaknesses

- `SEM-06` currently improves the baseline, but not to a level that should be called SOTA retrieval.
- `NEW-RT-01` is still described as Anthropic-SDK-shaped rather than model-routing-shaped.
- `idea-core` librarian retrieval still emits template-derived search packets instead of running a real federated scholarly retrieval program.
- `agent-arxiv` is planned as its own search stack instead of reusing a shared retrieval/discovery substrate.
- provider packages do not yet have a shared evaluation layer for recall / precision / dedup / canonicalization / query difficulty.

---

## 4. Target Architecture

### 4.1 Primary Spine — Single-User Research Loop

The architecture should be recentered around a **single-user research workspace** rather than around future community publication.

Near-term primary abstraction:

- a `ResearchWorkspace` / project graph that stores questions, idea candidates, evidence sets, compute attempts, findings, draft sections, review issues, and decisions;
- a `ResearchLoopRuntime` that can schedule and revisit those nodes through events and task edges;
- one runtime that supports both **interactive mode** (the user steers) and **autonomous mode** (the runtime continues from policy / budget / approval rules);
- stage labels such as `idea`, `literature`, `derivation`, `writing`, `revision` treated as **UX orientation labels**, not as the execution kernel.

The execution kernel should therefore be **event-driven / task-graph-shaped**, not a strict `W1 → W2 → W3 → W_compute` chain.
Typical legal transitions should include:

- literature → idea refinement;
- compute failure → literature refresh or hypothesis revision;
- review issue → targeted evidence search;
- new finding → draft update;
- contradiction → branch, downgrade, or archive an idea.

This is the substrate that should serve the near-term product.
`agent-arxiv` and `REP` should consume this substrate later; they should not define the v1 control flow.

### 4.2 Layer A — Provider Layer (keep pluggable)

Keep the current provider packages as the base integration units:

- `@autoresearch/arxiv-mcp`
- `@autoresearch/openalex-mcp`
- `hep-mcp` INSPIRE tools
- optional future providers (`CrossRef`, `Semantic Scholar`, domain packs)

Design rule:
provider packages should expose **provider-native capabilities**, not try to become the global discovery brain.

Provider responsibilities:

- validated request/response schemas;
- rate limiting and budget management;
- pagination and download handling;
- provider-native identifiers and provenance;
- lightweight provider-local tests.

### 4.3 Layer B — Federated Scholar Discovery (new first-class layer)

Add a new monorepo-level discovery layer above the providers.
Working name: `scholar-broker` or `federated-discovery`.

For v1, this should live in `packages/shared/src/discovery/` as a **shared TypeScript library consumed in-process**, not a new MCP server.
If the surface later outgrows `packages/shared`, promote it to `packages/scholar-broker/` without adding a new MCP boundary first.

Reason:

- it composes existing provider packages rather than replacing them;
- it avoids adding another MCP boundary before the broker semantics are stable;
- it prevents confusion about MCP sampling inside the broker.

If query planning or canonicalization later needs LLM assistance, that should happen in the **host/orchestrator layer** using the existing MCP-sampling or agent runtime paths, not inside the broker library itself.

For v1, `hep-mcp` continues to aggregate provider tools and expose `TOOL_SPECS`; the broker library is consumed by `hep-mcp`, `idea-engine`, `orchestrator`, and future `agent-arxiv` for query planning, fanout, dedup, and canonicalization.
That keeps provider adapters/tool exposure in the provider packages while avoiding duplicated “smart search” logic.

Responsibilities:

- query intent classification (`known-item`, `topic survey`, `citation expansion`, `author/institution disambiguation`, `dataset/method trace`);
- provider fanout policy (`INSPIRE` first for HEP, `OpenAlex` for cross-disciplinary breadth, `arXiv` for newest preprints/source availability);
- canonical paper identity resolution across provider IDs;
- cross-provider result deduplication;
- source confidence / provenance aggregation;
- query log emission and replayable artifacts.

This layer should become the default entry for future:

- librarian workflows;
- W1 ingestion / literature survey;
- idea-engine evidence discovery;
- `agent-arxiv` literature pool construction.

Canonical identity resolution must be explicit, not hand-waved.
First deliverable: migrate shared paper identifiers so canonical paper objects can carry `openalex_id?: string` (and optionally `semantic_scholar_id?: string`) in `PaperIdentifiersSchema` / `PaperSummarySchema`.
Without that schema step, the first two identity-ladder steps remain underspecified.
Suggested identity ladder for v1:

1. exact shared identifiers (`DOI`, `arXiv ID`, `INSPIRE recid`, `OpenAlex Work ID`);
2. provider-declared cross-links;
3. normalized title + author/year agreement as an `uncertain_match` path only;
4. OpenAlex dedup/cross-link data used as an assist signal, not a sole authority.

The broker sits **above** existing `hep-mcp` provider aggregation.
It does not replace provider MCP packages or `TOOL_SPECS` composition; it becomes the higher-level discovery planner used by workflows that need cross-provider search, dedup, and canonicalization.

### 4.4 Layer C — Retrieval Backbone (upgrade SEM-06 into a program)

`SEM-06` should be treated as an umbrella track, not a single batch-sized task.
The target retrieval backbone should be multi-stage.

#### Stage 0: Query Understanding

- normalize / canonicalize the query;
- classify query type and expected answer granularity;
- estimate difficulty / ambiguity / low-recall risk;
- optionally run lightweight query reformulation only when triggered.

#### Stage 1: Candidate Generation

Prerequisite: select and provision the embedding/index substrate.
At minimum this means deciding:

- hosted vs. local embedding generation;
- index format / vector store;
- dense-only vs. dense + late-interaction deployment path;
- artifact and cache format for replayable evals.

Current baseline to beat explicitly: `hashing_fnv1a32_dim*_v1` in `core/writing/evidence.ts`.
`SEM-06b` should be evaluated as a measured replacement for that baseline, not as a greenfield retrieval stack.

Use hybrid recall, not one path:

- lexical / BM25-style sparse;
- concept-aware sparse retrieval;
- dense single-vector retrieval where appropriate;
- late-interaction / multi-vector retrieval for higher-recall or OOD-sensitive cases.

#### Stage 2: Strong Reranking

Use a cascade:

- cheap deterministic rerank for broad pruning;
- strong reranker for top-k (`cross-encoder`, `minimal-interaction`, or late-interaction rerank);
- optional LLM/list-wise rerank only for hard cases or small top-k.

#### Stage 3: Structure-Aware Evidence Localization

Scientific evidence retrieval should not stop at document-level or naive chunk-level matches.
The system should support:

- paper;
- section;
- page;
- paragraph/chunk;
- table;
- figure/caption;
- equation block;
- citation context.

For long documents, "found the paper but missed the page/chunk" must be treated as a first-class retrieval failure mode.

#### Stage 4: Semantic Adjudication

Downstream `SEM-02/03/04` remains LLM-first, but consumes a much stronger candidate set:

- claim → evidence grading;
- stance;
- contradiction / not-comparable;
- semantic abstention with explicit reason codes.

Every `SEM-06` sub-stage must ship with its own evaluation gate:

- baseline inherited from the previous stage;
- locked holdout fixtures with human relevance judgments where needed;
- regression thresholds for recall / ranking metrics;
- fallback and latency telemetry.

### 4.5 Layer D — Model Routing (new first-class control plane)

Adopt a JSON-configured routing layer rather than a single global default model.

This routing layer should be split into **two distinct planes**.

#### Plane 1: Orchestrator / Agent Runtime Routing

- owned by `orchestrator` and other host runtimes;
- chooses concrete chat backends/models for agent loops;
- replaces the current Anthropic-shaped default path.

Concrete code anchor: `AgentRunner` currently hardcodes a lazy `@anthropic-ai/sdk` import.
The minimal safe refactor is to extract a `ChatBackend` interface + backend factory and let the current `model` field become a route key / backend selection handle, while preserving the existing `_messagesCreate` seam for tests.

#### Plane 2: MCP Sampling Host Routing

- owned by the MCP client / host that services `ctx.createMessage`;
- MCP servers do **not** choose models;
- MCP servers only emit stable metadata such as `module`, `tool`, `prompt_version`, `risk_level`, `cost_class`;
- the host maps those fields to concrete sampling models.

This distinction is important: the same JSON registry family can define both policies, but authority stays host-side in both cases.
Servers should not read routing config in order to self-select models.
If Plane 2 does not fit into `NEW-RT-06`, it should be scheduled explicitly as a separate host-side follow-up item rather than hidden inside server code.

Suggested routing granularity:

- `quantity_adjudication`
- `claim_evidence_grading`
- `stance_conflict`
- `query_reformulation`
- `listwise_rerank_hard`
- `review_judge`
- `planning_orchestration`

Minimum routing config requirements:

- default model;
- per-feature overrides;
- budget/latency classes;
- fallback chain;
- prompt/model version logging.

### 4.6 Layer E — Unified Evaluation Plane

SOTA claims should be gated by evaluation, not intuition.
Add a shared eval program across discovery + retrieval + semantics.
This should extend `NEW-RT-05`, not replace it: `NEW-RT-05` remains the shared eval substrate, the broker owns cross-provider slices, and `hep-mcp` owns retrieval/semantic slices.

Required benchmark slices:

- provider discovery recall / precision;
- known-item retrieval;
- topic discovery breadth;
- cross-provider canonicalization and dedup quality;
- evidence retrieval P@k / R@k / MRR / nDCG;
- long-document page/chunk recall;
- hard negatives: noisy contexts, semantically similar but logically irrelevant contexts, counterfactual contexts;
- fallback rate / abstention rate / invalid-response rate;
- latency and cost envelopes.

This is where the provider packages themselves should also improve:

- `arxiv-mcp` discovery failure cases;
- `openalex-mcp` search / semantic search quality;
- INSPIRE provider routing quality;
- broker-level dedup and canonicalization quality.

---

## 5. Package-Level Implications

### 5.1 `hep-mcp`

Should remain the main semantic evidence and scientific reasoning surface.
But it should stop being forced to compensate for upstream retrieval weaknesses.

Recommended direction:

- keep `SEM-01/02/03/04/05` here;
- evolve `SEM-06` into the main retrieval backbone program;
- consume federated scholar discovery artifacts when literature discovery is needed;
- standardize evidence candidate schema for downstream reuse.

### 5.2 `arxiv-mcp`, `openalex-mcp`, INSPIRE tools

These should remain provider adapters plus provider-native advanced capabilities.
They should not each implement their own disconnected "smart search strategy".

Recommended direction:

- keep them independently testable and reusable;
- add provider eval cases and failure taxonomy;
- expose capability metadata to the broker via a shared Zod schema in `packages/shared/` (`supports_semantic`, `supports_citation_graph`, `supports_fulltext`, `supports_source_download`, `supports_oa_content`).

### 5.3 `orchestrator`

This must become provider-agnostic at the model layer.
The current Anthropic-shaped framing is too narrow for the long-term architecture.

Recommended direction:

- preserve the thin AgentRunner philosophy;
- replace "Anthropic SDK is the runtime identity" with "provider-agnostic `ChatBackend` interface + backend factory + routing registry";
- keep routing config bootstrap independent from runtime capability resolution;
- preserve lane queue / approval gate / tracing / MCP tooling.

### 5.4 `idea-engine` / retiring `idea-core`

Do not heavily invest in the current Python template-based librarian retrieval.
Treat it as a migration placeholder.

Recommended direction:

- port the librarian role into `idea-engine` on top of federated scholar discovery;
- replace template-only evidence packets with real retrieval traces + canonical paper objects;
- keep operator outputs and evidence URIs, but upgrade how evidence is discovered.

### 5.5 `agent-arxiv`

`agent-arxiv` should not grow a standalone "BM25 + vectors + MMR" search system in isolation.
It should sit **on top of** the shared retrieval/discovery substrate.

This is a **future design constraint**, not an immediate implementation demand on the current scaffold.
The goal is to keep EVO-15/16 from forking a second retrieval architecture once the shared substrate exists.
Make this constraint active before any serious search-heavy `agent-arxiv` build-out: wait for federated discovery and at least `SEM-06e` before growing retrieval-dependent features there.

Recommended direction:

- reuse the federated scholar broker for external literature bootstrapping;
- reuse the shared retrieval backbone for local agent-paper search;
- add citation graph, novelty tracking, integrity gates, and evolution dashboards above that shared substrate.

### 5.6 `rep-sdk` / `REP`

`REP` should remain a **future evolution/publication layer**, not the near-term execution kernel.
Its strongest ideas for the current roadmap are:

- content-addressed research assets;
- integrity/reproducibility-gated publication or reuse;
- auditable event streams.

What should **not** back-drive the near-term product architecture:

- assuming publication/store semantics are the primary runtime abstraction;
- assuming local `agent-arxiv` citation statistics are meaningful for early single-user runs;
- constraining the core runtime to only locally computable ranking signals when higher-quality networked evidence is available.

Recommended direction:

- reuse REP-compatible asset/event concepts where they improve auditability;
- keep REP itself off the critical path for the single-user loop runtime;
- let `agent-arxiv` and REP become outer layers after the single-user substrate is strong.

---

## 6. Concrete Changes to the Current REDESIGN_PLAN

### 6.1 Add a new precursor item: `NEW-LOOP-01`

Add a Phase 3 precursor item for a **single-user nonlinear research loop runtime**.

Suggested scope for `NEW-LOOP-01`:

- define `ResearchWorkspace` / project graph types for question, idea, evidence set, compute attempt, finding, draft, review issue, and decision;
- add an event-driven / task-graph execution abstraction in `orchestrator`;
- explicitly treat `idea/literature/derivation/writing/revision` as UX stage labels, not exclusive machine states;
- support both interactive and autonomous continuation on the same runtime;
- make this the precursor substrate for `EVO-01/02/03`, rather than waiting until Phase 5 for the first real loop semantics.

Scope boundary:

- `NEW-LOOP-01` is **not** the full compute/idea/writing automation of `EVO-01/02/03`;
- it is the runtime substrate that lets those later items plug into a non-linear single-user workflow.

### 6.2 Add `NEW-RT-06` (do not rewrite completed `NEW-RT-01`)

`NEW-RT-01` is already complete and should remain recorded as such.
The required change is a **new runtime item** layered on top of it.

Suggested scope for `NEW-RT-06`:

- keep the thin AgentRunner and its current guarantees;
- replace the lazy Anthropic default with an injected `ChatBackend` interface + backend factory;
- make the current `model` input a route key / backend selection handle rather than a provider-specific assumption;
- add JSON-configured orchestrator-plane routing;
- preserve lane queue, approval gate, tracing, MCP dispatch.

Scope boundary:

- `NEW-RT-06` covers Plane 1 only (orchestrator / agent runtime);
- add a separate future item `NEW-RT-07` for Plane 2 host-side MCP sampling routing;
- MCP servers still do not self-select models.

### 6.3 Reframe `NEW-SEM-06`

Do not mark current Batch 10 implementation as the final architecture.

Recommended rewrite:

- `SEM-06a` — baseline semantic-first retrieval with explicit fallback (**already done**)
- `NEW-SEM-06-INFRA` — embedding/index substrate decision + baseline lock + eval protocol
- `SEM-06b+c` — hybrid candidate generation + strong reranker cascade (bundle as one delivery track)
- `SEM-06d` — triggered query reformulation + query performance prediction
- `SEM-06e` — structure-aware evidence localization
- optional `SEM-06f` — multimodal scientific retrieval for figures/pages/PDF-native evidence

Dependencies to state explicitly:

- `NEW-RT-05` eval framework and locked holdouts are hard prerequisites;
- `NEW-SEM-06-INFRA` is a hard prerequisite for `SEM-06b+c`;
- canonical paper identity from the federated discovery item is a hard prerequisite for `SEM-06b+c`, so retrieval does not hard-fork into provider-local document identities;
- each sub-stage requires its own convergence/eval budget, so the plan should reflect schedule impact rather than hiding it.

### 6.4 Add a new item: Federated Scholar Discovery

Add a Phase 3 or Phase 4 item (working ID: `NEW-DISC-01`) for a broker over `INSPIRE + OpenAlex + arXiv`.

This should be defined as a shared library and workflow substrate, not a new standalone MCP server in v1.
For v1, implement it in `packages/shared/src/discovery/`; only extract it to `packages/scholar-broker/` if the shared module surface later becomes too large.

Suggested outputs:

- shared paper identifier schema migration (`openalex_id` first);
- canonical paper schema;
- canonical identity / cross-link strategy;
- provider capability registry (typed Zod schema in `packages/shared/`);
- query-plan artifact;
- cross-provider dedup artifact;
- append-only search log integration.

### 6.5 Adjust `agent-arxiv`

Update the planned `search-index.ts` scope.

Instead of:

- standalone BM25 + embedding + MMR stack,

use:

- shared retrieval backbone primitives;
- shared canonical paper/evidence schemas;
- local citation graph and novelty/integrity layers as `agent-arxiv`-specific logic.

### 6.6 De-emphasize Python librarian retrieval

Explicitly mark current `idea-core` librarian retrieval as transitional.
Do not let it become the long-term search architecture.

### 6.7 Add provider-level eval obligations

For `arxiv-mcp` and `openalex-mcp`, add more than unit tests:

- query quality fixtures;
- identifier/canonicalization fixtures;
- discovery regression cases;
- broker-integrated eval slices.

---

## 7. Recommended Execution Order

### Near-term (before or alongside Batch 11–16)

1. formalize `NEW-LOOP-01` so the near-term execution kernel is explicitly a single-user nonlinear research loop rather than an implicit stage machine;
2. land the shared paper identifier schema migration (`openalex_id`) and provider capability schema;
3. scope `NEW-SEM-06-INFRA` as an explicit substrate decision item with eval gates;
4. define federated scholar discovery as a shared library, plus the canonical identity ladder and broker outputs;
5. scope `SEM-06b+c` as the next retrieval delivery track on top of canonicalized documents;
6. add `NEW-RT-06` for orchestrator-side provider-agnostic routing;
7. schedule `NEW-RT-07` for host-side MCP sampling routing once the shared routing schema is stable.

### Mid-term

8. implement `SEM-06d` triggered reformulation / QPP;
9. implement `SEM-06e` structure-aware retrieval;
10. migrate librarian retrieval into `idea-engine` on top of the new discovery layer;
11. add provider-level eval suites for federated discovery and canonicalization.

### Before serious `agent-arxiv` scale-out

12. make `agent-arxiv` reuse shared retrieval/discovery primitives;
13. add novelty / citation / integrity / evolution layers only after the retrieval substrate is strong enough.

### Suggested Batch 11+ map

Keep the existing semantic lane (`Batch 11`–`16`) unchanged to avoid churn in already-sequenced SEM work.
Run the 8 new SOTA / loop follow-up items in a **parallel infra/retrieval/loop lane**:

| Window | Suggested items | Why here | Must finish before |
|---|---|---|---|
| Batch 11 (parallel lane) | `NEW-DISC-01` kickoff + `NEW-RT-06` | both are architecture substrate work with low direct coupling to `SEM-02`; they unblock later retrieval and routing work without disturbing current SEM sequencing | `NEW-SEM-06b` |
| Batch 12 (parallel lane) | `NEW-SEM-06-INFRA` | retrieval substrate choice must be frozen before any real SOTA retrieval implementation | `NEW-SEM-06b` |
| Batch 13–14 (parallel lane) | `NEW-RT-07` + `NEW-DISC-01` closeout | host-side sampling routing should wait until the routing schema stabilizes; discovery closeout should finish canonical identity, provider capability schema, dedup, and eval slices. It should ideally precede or overlap `NEW-LOOP-01` so literature→idea transitions land on the shared discovery substrate, but it does not hard-block runtime scaffolding | `NEW-SEM-06b` |
| Batch 15–16 (parallel lane) | `NEW-LOOP-01` | codifies the near-term single-user nonlinear runtime once routing and workflow foundations exist, without forcing an immediate Phase 5 jump. It is scheduled after routing/workflow foundations so the loop runtime lands as more than a stub | `EVO-01`, `EVO-02`, `EVO-03` |
| Batch 17 | `NEW-SEM-06b` | only start once canonical identity + substrate decision are done and existing Batch 11–16 semantic work is no longer at risk of being destabilized | `NEW-SEM-06d`, `NEW-SEM-06e` |
| Batch 18 | `NEW-SEM-06d` | reformulation/QPP should optimize an already-strong retrieval stack, not compensate for missing backbone work | — |
| Batch 19 | `NEW-SEM-06e` | structure-aware localization should build on stable candidate generation/rerank behavior and becomes the gate for search-heavy `agent-arxiv` work | search-heavy `agent-arxiv` features |

Practical reading of this schedule:

- do **not** delay `NEW-DISC-01` until after Batch 16;
- do **not** treat `NEW-DISC-01` closeout as a formal blocker for loop-runtime scaffolding; it should ideally precede or overlap `NEW-LOOP-01` so literature→idea transitions land on the shared discovery substrate;
- do **not** let `NEW-SEM-06b` start before `NEW-DISC-01` and `NEW-SEM-06-INFRA` are both finished;
- do **not** leave the first real nonlinear research-loop runtime semantics stranded in Phase 5;
- do **not** make `NEW-RT-07` a critical-path blocker for Batch 11–16 unless routing instability actually shows up in eval/operations.

### Dependency Graph

```text
NEW-OPENALEX-01
      |
      v
 NEW-DISC-01 -----------+
                         |
NEW-RT-05 -> NEW-SEM-06-INFRA -> NEW-SEM-06b -> { NEW-SEM-06d, NEW-SEM-06e }
                         ^
                         |
                    SEM-06a baseline

NEW-WF-01 ----+
UX-06 --------+--> NEW-LOOP-01 -> { EVO-01, EVO-02, EVO-03 }
NEW-RT-06 ----+

NEW-RT-01 -> NEW-RT-06
NEW-MCP-SAMPLING -> NEW-RT-07
```

Interpretation:

- `NEW-DISC-01` and `NEW-SEM-06-INFRA` are the true critical path for SOTA retrieval.
- `NEW-LOOP-01` is the true critical path for making the near-term product a nonlinear single-user research system rather than a staged demo flow. `UX-06` is already complete and is consumed here only as a UX-hint taxonomy, not as a request to revive a linear stage engine.
- `NEW-RT-06` matters for provider-agnostic runtime health and is also part of the loop-runtime precursor, but it is not a retrieval blocker.
- `NEW-RT-07` matters for long-term routing hygiene and feature-level model policy, but should remain off the critical path unless host-side sampling policy becomes a real bottleneck.

---

## 8. Honest Claim Boundary

If the plan is modified as above and the eval program confirms gains, the monorepo can plausibly target a real SOTA-like position in:

- automated scientific discovery and evidence retrieval;
- evidence-grounded semantic adjudication;
- auditable multi-agent scientific workflows.

Without these modifications, the more honest description is:

- excellent governance and semantic reasoning trajectory;
- strong local baseline retrieval;
- not yet end-to-end SOTA retrieval/discovery.

---

## 9. External Signals Worth Tracking

- LLM reformulation + multi-stage rerank — *Single-Turn LLM Reformulation Powered Multi-Stage Hybrid Re-Ranking for Tip-of-the-Tongue Known-Item Retrieval* (Mukhopadhyay et al., arXiv:2602.10321)
- efficient minimal-interaction rerankers — *MICE: Minimal Interaction Cross-Encoders for efficient Re-ranking* (Vast et al., arXiv:2602.16299)
- late-interaction / multi-vector momentum — *ColBERT-Zero* (Chaffin et al., arXiv:2602.16609) and *Col-Bandit* (Pony et al., arXiv:2602.02827)
- scientific rerank robustness / SSLI — *SciRerankBench* (Chen et al., arXiv:2508.08742) and *DeepEra* (Chen et al., arXiv:2601.16478)
- concept-aware scientific sparse retrieval — *CASPER* (Do et al., arXiv:2508.13394)
- long-document page/chunk failure analysis — *Decomposing Retrieval Failures in RAG for Long-Document Financial Question Answering* (Kobeissi and Langlais, arXiv:2602.17981)
- multimodal scientific retrieval — *IRPAPERS* (Shorten et al., arXiv:2602.17687)

---

## 10. Bottom Line

The monorepo should keep its current strengths and avoid a destructive reset.
The right change is to elevate **single-user research-loop execution**, retrieval, discovery, and routing into first-class architectural concerns.

That means:

- make the near-term execution kernel a nonlinear single-user research loop;
- keep provider packages pluggable;
- add a federated discovery layer;
- upgrade `SEM-06` from a one-off batch item into a retrieval backbone roadmap;
- move model choice into JSON-configured routing;
- make `agent-arxiv` and `REP` consume the shared substrate rather than define it.

That path is compatible with the current redesign, preserves quality-first governance, keeps the long-term Agent-arXiv/REP vision intact, and gives the project a realistic chance of reaching an honest SOTA tier.
