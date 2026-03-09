# hep-mcp Deep Audit Report

> **Date**: 2026-02-28
> **Scope**: Full architectural audit of `packages/hep-mcp/` before Phase 3
> **Baseline**: 98K LOC, 102 tools (full) / 79 tools (standard), 1156 tests
> **Method**: Source code analysis + web-verified LLM capability assessment + dependency graph mapping

## 1. LLM Capability Verification (Web-Sourced Evidence)

All pre-audit claims about "2026 SOTA LLM can do X" were verified against recent academic publications. Below are the findings with citations.

### 1.1 Best-of-N Sampling — Still Useful But Misplaced

**Pre-audit claim**: "N-best candidate + judge has diminishing returns for Opus 4.6 level models."

**Verification**: **PARTIALLY CORRECT**. BoN remains an active and productive research area:
- [Inference Scaling Laws (ICLR 2025)](https://proceedings.iclr.cc/paper_files/paper/2025/file/8c3caae2f725c8e2a55ecd600563d172-Paper-Conference.pdf): Accuracy saturates to a fixed limit; diminishing returns with N.
- [Evaluation of BoN Strategies (Feb 2025)](https://arxiv.org/abs/2502.12668): Systematic evaluation confirms BoN still provides meaningful improvements.
- [SitePoint Benchmark (2026)](https://www.sitepoint.com/claude-sonnet-4-6-vs-gpt-5-the-2026-developer-benchmark/): GPT-5's consistency is "a bit of a gamble" for complex tasks — output variance makes multi-sample strategies directly valuable.

**Nuance**: BoN is still useful, but it is an **orchestration pattern** (generate multiple → select best). Per MCP best practices (see §1.5), this orchestration does NOT belong in an MCP server. It belongs in the agent/skill layer.

**Verdict**: **Delete from MCP server**. The value is real but the architectural placement is wrong.

### 1.2 LLM-as-a-Judge Biases — Still Significant

**Pre-audit claim**: "Judge has position bias (~40%) + verbosity bias (~15%)."

**Verification**: **CONFIRMED** by ICLR/IJCNLP 2025 papers:
- [Wataoka et al. (ICLR 2025)](https://arxiv.org/abs/2410.21819): GPT-4 exhibits significant self-preference bias. Root cause: LLMs favor texts with lower perplexity (more familiar). Structural property, doesn't scale away.
- [IJCNLP 2025 study](https://aclanthology.org/2025.ijcnlp-long.18.pdf): Simply swapping presentation order shifts accuracy by >10% in pairwise judging.
- [CALM framework (ICLR 2025)](https://arxiv.org/html/2410.02736v1): 12 key biases identified; "significant biases persist in certain specific tasks" even with advanced models.

**Verdict**: Biases are structural to autoregressive models. MCP-server-side judge evaluation is unreliable AND architecturally misplaced.

### 1.3 Long-Context Paper Generation — Section-by-Section Still Wins (Updated 2026-03-01)

**Pre-audit claim**: "200K context sufficient for whole-paper generation."

**Verification**: **INCORRECT** — section-by-section with planning still superior:
- [LongGenBench (ICLR 2025)](https://arxiv.org/abs/2409.02076): All 10 SOTA LLMs show "clear decline in instruction adherence and coherence beyond the 4,000-token threshold."
- Stanford/MIT 2025: Over 60% of 3,000-word single-pass outputs contain contradictions between early and late sections.
- [WritingPath (NAACL 2025)](https://aclanthology.org/2025.naacl-industry.20/): Outline-guided generation significantly enhances quality.
- [CogWriter (Feb 2025)](https://arxiv.org/html/2502.12568v2): Autoregressive generation struggles with multi-threaded narratives without independent planning.

**2026-03 Update — 4K token cliff largely resolved in top models**:
- [EQ-Bench Longform Creative Writing](https://eqbench.com/creative_writing_longform.html) (2026-03 leaderboard, 8-chapter continuous writing with per-chapter scoring):
  - Claude Sonnet 4.6: **degradation 0.000**, score 79.9, 6,893 tokens
  - Claude Opus 4.6: **degradation 0.000**, score 77.7, 6,189 tokens
  - GPT-5 high-reasoning: **degradation 0.000**, score 73.1, 10,225 tokens
  - GPT-5: degradation 0.036, score 72.8, 13,497 tokens
- Top-tier models now maintain coherence through 8 chapters with zero measurable degradation
- However, single-shot generation still maxes out at ~13K tokens — insufficient for a full review paper (50K-100K tokens)

**Updated nuance**: The degradation problem is mostly solved for SOTA models, but section-by-section remains necessary for document-length outputs (>13K tokens). The architecture choice is even more validated: with near-zero per-section degradation, the main challenge shifts to cross-section coherence — which is purely an orchestration/planning concern best handled in the skill layer.

**Verdict**: Structured writing with planning remains important for full-length papers. Planning/orchestration moves to skill layer (research-writer); MCP provides evidence retrieval and deterministic rendering.

### 1.4 Token Budget Planning — External Constraints Still Needed

**Pre-audit claim**: "2026 LLM natively understands length allocation."

**Verification**: **INCORRECT**:
- [TALE (ACL 2025)](https://aclanthology.org/2025.findings-acl.1274/): "Simple insertion of budget constraints into prompts often fails to reliably control output length."
- [BudgetThinker (2025)](https://openreview.net/forum?id=ahatk5qrmB): "Merely stating a budget constraint in the initial prompt is insufficient." Solution: periodic control token insertion during inference.

**Nuance**: Token budget control IS needed, but it should come from the orchestrator/skill layer (which can measure output and adjust prompts), not from the MCP server providing a static budget plan.

**Verdict**: Delete from MCP server. Skill layer handles budget enforcement through iterative prompting.

### 1.5 MCP Server Architecture — Servers Should NOT Embed LLM Clients

**Pre-audit claim**: "Delete internal + passthrough modes, keep client mode only."

**Verification**: **STRONGLY CONFIRMED** — this is now explicit industry consensus:
- [O'Reilly/Goose](https://www.oreilly.com/radar/mcp-sampling-when-your-tools-need-to-think/): Embedding your own LLM is explicitly labeled an "anti-pattern."
- [Block/Goose blog (Dec 2025)](https://block.github.io/goose/blog/2025/12/04/mcp-sampling/): "The MCP server itself has zero LLM dependencies. Sampling enables intelligent behavior without managing LLM infrastructure."
- [Philipp Schmid (Jan 2026)](https://www.philschmid.de/mcp-best-practices): "Do the orchestration in your code, not in the LLM's context window."
- [MCP Sampling spec](https://modelcontextprotocol.io/docs/concepts/sampling): Server requests LLM completions via `sampling/createMessage`; client controls model selection, cost, security.

**Verdict**: Delete ALL embedded LLM clients. For features needing LLM (reranking), migrate to MCP sampling protocol.

### 1.6 RAG vs Long Context — RAG Still Valuable

**Pre-audit claim**: "BM25 + LLM rerank is valuable RAG."

**Verification**: **CONFIRMED**:
- [Li et al.](https://arxiv.org/abs/2407.16833): Long-context outperforms RAG in average performance but at 1,250x higher cost. Hybrid "Self-Route" matches LC while cutting cost.
- Stanford "Lost in the Middle": LLMs fail to utilize information in middle of long contexts; 30%+ performance degradation.
- [RAGFlow 2025 review](https://ragflow.io/blog/rag-review-2025-from-rag-to-context): "Naive RAG is dead, sophisticated RAG is thriving." 60% of production LLM apps use RAG.

**Nuance**: RAG is valuable but the current implementation is deeply coupled to the writing pipeline (section-level packets, outline-specific queries). Need to separate generic evidence retrieval from writing-specific selection.

**Verdict**: Keep project-level evidence catalog + BM25 retrieval. Delete writing-specific evidence selection. Migrate LLM reranking to MCP sampling.

---

## 2. Deletion Candidate Verification

### 2.1 Modules Confirmed Safe to Delete

| Module | Files | Est. LOC | Reason |
|--------|-------|----------|--------|
| Section candidates + judge | `sectionCandidates.ts`, `sectionJudge.ts` | ~950 | Agent-layer orchestration pattern |
| Outline candidates + judge | `outlineCandidates.ts`, `outlineJudge.ts` | ~600 | Agent-layer orchestration pattern |
| N-best judge schemas | `nbestJudgeSchemas.ts` | ~100 | Only used by above |
| Section write packet | `sectionWritePacket.ts` | ~760 | Prompt assembly belongs in skill layer |
| Submit section | `submitSection.ts` | ~500 | Verification pipeline moves to skill |
| Refinement orchestrator | `refinementOrchestrator.ts` | ~815 | State machine belongs in skill layer; no reverse deps |
| Submit review | `submitReview.ts` | ~427 | Replaced by referee-review + paper-reviser skills |
| Submit revision plan | `submitRevisionPlan.ts` | ~200 | Replaced by paper-reviser skill |
| Revision plan packet | `revisionPlanPacket.ts` | ~200 | No reverse deps |
| Submit outline plan | `submitOutlinePlan.ts` | ~200 | No reverse deps |
| Outline plan packet | `outlinePlanPacket.ts` | ~200 | No reverse deps |
| Paperset curation packet | `papersetCurationPacket.ts` | ~200 | No reverse deps |
| Submit paperset curation | `submitPapersetCuration.ts` | ~200 | No reverse deps |
| Deep writer (entire dir) | `tools/writing/deepWriter/*` | ~500 | Already dead code (not registered) |
| Deep writer agent | `tools/writing/llm/deepWriterAgent.ts` | ~389 | Already dead code |
| Section quality evaluator | `sectionQualityEvaluator.ts` | ~300 | LLM-based evaluation → agent layer |
| Staging | `staging.ts` | ~183 | All 9 consumers are also deletion targets |
| Style corpus tools | `styleCorpusTools.ts` | ~800 | Replaced by research-writer skill |
| Style corpus infra | `corpora/` (16 files) | ~6,000 | No retained module depends on it |
| Writing evidence (run-level) | `core/writing/evidence.ts` | ~500 | Writing-specific; project-level evidence.ts remains |
| Evidence selection | `core/writing/evidenceSelection.ts` | ~800 | Writing-specific BM25+rerank |
| Evidence index | `core/writing/evidenceIndex.ts` | ~600 | Writing-specific index builder |
| Critical writing | `core/writing/critical.ts` | ~300 | Duplicates `inspire_critical_research` |
| Integrate sections | `core/writing/integrate.ts` | ~494 | Writing-specific section integration |
| RAG subsystem | `tools/writing/rag/` (12 files) | ~6,188 | Entirely writing-pipeline-specific |
| Section verifiers | `tools/writing/verifier/` (9 files) | ~1,192 | All operate on writing pipeline artifacts |
| Writing prompts | `tools/writing/prompts/` | ~200 | Writing-specific prompt assembly |
| Deep writer module | `tools/writing/deepWriter/` | ~500 | Dead code |
| Originality | `tools/writing/originality/` | ~300 | Writing pipeline overlap detection |
| Claims table | `tools/writing/claimsTable/` | ~500 | Writing-specific claim extraction |
| Content index | `tools/writing/contentIndex/` | ~300 | Writing-specific fingerprinting |
| Outline module | `tools/writing/outline/` | ~500 | Writing-specific outline logic |
| Reference manager | `tools/writing/reference/` | ~300 | Writing-specific reference handling |
| Writing rubric | `tools/writing/rubric/` | ~100 | Writing-specific scoring criteria |
| Writing templates | `tools/writing/templates/` | ~100 | Writing-specific LaTeX templates |
| Writing utils | `tools/writing/utils/` | ~200 | Writing-specific utilities |

**Total safe-to-delete**: ~24,000 LOC

### 2.2 Modules with Hard Dependency Blockers

These modules are in the "delete" list but have KEEP modules depending on them. They require refactoring before deletion.

| Module | Blocker | Resolution |
|--------|---------|------------|
| `tokenBudgetPlan.ts` + `tokenGate.ts` | `evidenceSelection.ts` imports both | **Moot**: evidenceSelection.ts is itself a deletion target |
| `qualityPolicy.ts` | `integrate.ts` + `deepResearch.ts` import it | **Moot for integrate.ts** (also deletion target); extract schema to `core/contracts/` for deepResearch.ts |
| `outlinePlanner.ts` schemas | `outlineContractGate.ts` + `deepResearch.ts` | Extract `OutlinePlanV2Schema`, `validateOutlinePlanV2OrThrow` to `core/contracts/` |
| `papersetPlanner.ts` schemas | `candidatePool.ts` + `deepResearch.ts` | Extract `CandidatePaperSchema`, `PaperId` to `core/contracts/` |
| LLM client infra (`llm/clients/`, `config.ts`, `types.ts`) | `llmReranker.ts` + `theoreticalConflicts.ts` | Migrate to MCP sampling; interim: keep minimal client with deprecation plan |

**Resolution chain**:
1. Extract schemas from `outlinePlanner.ts` and `papersetPlanner.ts` to `core/contracts/`
2. Extract `qualityPolicy` schema to `core/contracts/`
3. Update `deepResearch.ts`, `outlineContractGate.ts`, `candidatePool.ts` to import from `core/contracts/`
4. Then safely delete the original files

**After dependency resolution, additional deletable**: ~3,000 LOC

### 2.3 Module Mislabeled in Pre-Audit

**`candidatePool.ts`** was listed under "N-best + Judge pipeline" but is actually a **paper discovery module** (INSPIRE citation network expansion) used by `deepResearch.ts` mode='analyze'. It is NOT part of the N-best/judge pattern. **KEEP**.

### 2.4 Additional Deletable Code Not in Pre-Audit

The retained module audit found additional writing-specific code that was not in the pre-audit's deletion list:

| Module | LOC | Reason |
|--------|-----|--------|
| `core/writing/evidence.ts` | ~500 | Run-level writing evidence with FNV1a hashing |
| `core/writing/evidenceIndex.ts` | ~600 | BM25 chunk indexing for writing |
| `core/writing/evidenceSelection.ts` | ~800 | BM25 + LLM rerank for sections |
| `core/writing/critical.ts` | ~300 | Duplicates `inspire_critical_research` |
| `core/writing/integrate.ts` | ~494 | Section integration + compile gate |
| `tools/writing/verifier/` (9 files) | ~1,192 | Writing pipeline artifact validators |
| `tools/writing/rag/` (12 files) | ~6,188 | Entire RAG subsystem |
| `tools/writing/prompts/` | ~200 | Writing prompt assembly |
| `tools/writing/originality/` | ~300 | Overlap detection |
| `tools/writing/claimsTable/` | ~500 | Claim extraction |
| `tools/writing/contentIndex/` | ~300 | Fingerprinting |
| `tools/writing/outline/` | ~500 | Outline logic |
| `tools/writing/reference/` | ~300 | Reference management |
| `tools/writing/rubric/` | ~100 | Scoring criteria |
| `tools/writing/templates/` | ~100 | LaTeX templates |
| `tools/writing/utils/` | ~200 | Utilities |

**Additional deletable**: ~12,574 LOC

### 2.5 Code to Extract Before Deletion

| Item | Source | Destination | Reason |
|------|--------|-------------|--------|
| `stripLatexPreserveHEP()` | `rag/hepTokenizer.ts` | `utils/latex.ts` | Used by LaTeX extractors (7 import sites) |
| `estimateTokens()` | `rag/hepTokenizer.ts` | `utils/latex.ts` | Used by non-writing modules |
| `OutlinePlanV2Schema` | `outlinePlanner.ts` | `core/contracts/outlinePlan.ts` | Used by `outlineContractGate.ts` |
| `CandidatePaperSchema` | `papersetPlanner.ts` | `core/contracts/candidatePaper.ts` | Used by `candidatePool.ts` |
| `WritingQualityPolicyV1` schema | `qualityPolicy.ts` | `core/contracts/qualityPolicy.ts` | Used by `deepResearch.ts` |
| `hep://corpora/` handling | `resources.ts` | (delete) | Clean up resource namespace |

---

## 3. Retained Module Verification

### 3.1 Confirmed Irreplaceable (LLM Cannot Do)

| Module | Why Irreplaceable |
|--------|-------------------|
| **Project-level evidence catalog** (`core/evidence.ts`) | Deterministic LaTeX → structured JSONL extraction with byte-offset locators, SHA-256 stable IDs, multi-file \input resolution. Mechanical pipeline; LLMs hallucinate structure. |
| **Measurements extraction** (`measurements.ts`) | 7 regex patterns for HEP uncertainties (stat+syst, asymmetric, parenthetical notation, scientific notation). LLMs hallucinate numbers and miss asymmetric errors. |
| **Measurements comparison** (`compareMeasurements.ts`) | Pairwise z-score tension analysis with unit normalization. Statistical computation. |
| **LaTeX parsing** (`tools/research/latex/`, 18 files) | AST-based LaTeX parser with section/equation/figure/table/citation/bibliography extraction, source-map coordinates, macro expansion. |
| **INSPIRE API access** (`api/client.ts`, `api/rateLimiter.ts`) | Rate-limited, retry-enabled HTTP client for INSPIRE. Only interface to the database. |
| **Citation mapping** (`citekeyMapper.ts`, INSPIRE resolution) | Deterministic citekey → INSPIRE recid resolution via API. |
| **Bibliography validation** (`validateBibliography.ts`) | INSPIRE-backed cross-validation of .bib entries. |
| **Project/Run state management** | Atomic manifest writes, file locking, artifact storage, `hep://` resource URIs. |
| **PDF evidence extraction** | Docling-based PDF → structured content extraction. |
| **Export/Import** (`export_project`, `export_paper_scaffold`, `import_paper_bundle`) | Deterministic packaging + LaTeX compilation. |
| **Aggregated MCP tools** (PDG, arXiv, Zotero, HEPData) | External data access with hep-mcp-specific enrichment (Zotero→INSPIRE mapping, arXiv source extraction). |

### 3.2 Research Tools — Keep with Simplification

| Tool | Keep/Modify |
|------|-------------|
| `inspire_research_navigator` | KEEP as-is (8 modes, pure research orchestration) |
| `inspire_critical_research` | KEEP as-is (5 modes, evidence/conflicts/analysis/reviews/theoretical) |
| `inspire_deep_research` | **SPLIT**: Keep mode='analyze' + mode='synthesize'; delete mode='write' (~60% of file) |
| `inspire_paper_source` | KEEP as-is (arXiv source download) |
| `inspire_find_crossover_topics` | KEEP as-is (interdisciplinary analysis) |
| `inspire_analyze_citation_stance` | KEEP as-is (stance detection pipeline) |

### 3.3 deepResearch.ts Split Plan

Current `deepResearch.ts` has 3 modes:
- **mode='analyze'**: Delegates to `deepAnalyze()` — pure research tool. **KEEP**.
- **mode='synthesize'**: Delegates to `synthesizeReview()` — pure research tool. **KEEP**.
- **mode='write'**: Full Client Path writing pipeline. Imports 20+ writing modules. **DELETE**.

After deletion, the file imports drop from ~60 to ~15, and the file shrinks by approximately 60%.

### 3.4 LLM Client Infrastructure — Anti-Pattern, Needs Migration Plan

Two KEEP modules currently depend on embedded LLM clients:
1. `llmReranker.ts` — uses `createLLMClient()` for evidence reranking
2. `theoreticalConflicts.ts` — uses `createLLMClient()` for conflict analysis

Per §1.5, this is an anti-pattern. Migration path:
- **Phase 3A (immediate)**: Keep minimal LLM client (`llm/clients/`, `config.ts`, `types.ts`) with `@deprecated` annotation and migration plan documented
- **Phase 3B (when MCP sampling stabilizes)**: Migrate to `sampling/createMessage`. Reranker sends ranking request to client; client calls LLM and returns result.
- **Alternative**: Move reranker to a standalone MCP server that uses sampling natively

---

## 4. Skill Coverage Analysis

External skills are NOT 1:1 replacements — they serve different architectural layers:

| Skill | What It Does | Replaces in hep-mcp |
|-------|-------------|---------------------|
| **research-writer** | RevTeX scaffold + section drafting from `research-team` output | Outline planning, section generation |
| **paper-reviser** | Content revision + tracked changes + Codex verification | Refinement orchestrator, review/revision cycle |
| **referee-review** | Offline clean-room peer review | Submit review |
| **research-team** | Dual-agent convergence research with claims DAG | N-best + judge pattern (multi-perspective quality) |

**Key insight**: Skills are standalone, file-system-based workflows. hep-mcp writing tools are MCP-integrated, stateful, artifact-tracked workflows. They are architecturally different but the **capabilities overlap**. The correct conclusion is:

> The MCP server should provide **data access and deterministic validation**. The skills provide **orchestration and generation**. There is no need for both layers to implement writing orchestration.

---

## 5. Summary Metrics

| Metric | Before Audit | After Audit |
|--------|-------------|-------------|
| LOC (src/) | ~98K | ~58-62K (estimated) |
| Tools (full) | 102 | ~70-75 |
| Tools (standard) | 79 | ~55-60 |
| Deletion LOC | — | ~36-40K |
| Files to delete | — | ~100+ |
| Files to modify | — | ~15-20 |
| Schemas to extract | — | 5 |
| Anti-patterns to resolve | — | 1 (LLM client) |

---

## 6. Pre-Audit Conclusions: Final Verdict

| Pre-Audit Claim | Verdict | Nuance |
|----------------|---------|--------|
| Delete N-best + judge | **CONFIRMED** | Orchestration pattern → agent layer |
| Delete section write packets | **CONFIRMED** | Prompt assembly → skill layer |
| Delete token budget + gate | **CONFIRMED** | Budget enforcement → skill layer |
| Delete refinement orchestrator | **CONFIRMED** | State machine → skill layer |
| Delete review + revision plan | **CONFIRMED** | Replaced by paper-reviser + referee-review |
| Delete outline/paperset planning | **CONFIRMED** with caveats | Schemas must be extracted first |
| Delete deep writer | **CONFIRMED** | Already dead code |
| Delete LLM client infra | **PARTIALLY CONFIRMED** | Keep minimal client for reranker; migrate to MCP sampling |
| Delete style corpus (8 tools) | **CONFIRMED** | No retained module depends on it |
| Delete quality evaluator | **CONFIRMED** | qualityPolicy.ts schema survives (extracted) |
| Keep INSPIRE tools | **CONFIRMED** | Irreplaceable data access |
| Keep evidence layer | **REFINED** | Keep project-level; delete writing-specific evidence |
| Keep citation verification | ~~**REFINED**~~ → **DELETE** (R4) | Citation verification design flaw: allowlist requires pre-existing .bib, fails for new papers. Removed from renderLatex.ts entirely |
| Keep measurements | **CONFIRMED** | Deterministic numerical extraction |
| Keep LaTeX tools | **CONFIRMED** | Irreplaceable AST-based parsing |
| Simplify `integrate_sections` | **OVERRIDDEN** → delete | Writing-specific; `hep_render_latex` covers LaTeX compile needs |
| Simplify RAG | **OVERRIDDEN** → delete writing RAG, keep project evidence | Writing RAG is too coupled; project evidence catalog is the core value |
| 98K → ~60K LOC | **CONFIRMED** | ~58-62K estimated |
| 102 → ~65 tools | **REFINED** | ~70-75 tools (more conservative; some aggregated tools remain) |

---

## 7. Post-Audit Design Corrections (2026-03-01)

Author review after dual-model convergence identified additional over-engineering and design flaws in the KEEP list. These were NOT caught by automated review (Gemini/Codex) because they involve questioning fundamental design assumptions rather than dependency analysis.

### 7.1 Citation Verification Removal (R4)

**Finding**: `renderLatex.ts` citation verification pipeline (~600+ LOC total across verifier + allowlist) is based on a broken design:
1. **Revising existing papers**: User already verified their citations — MCP server re-verification is redundant
2. **Writing new papers**: Allowlist requires `extractBibliography({ identifier })` from pre-existing paper source — fails by design
3. **Non-INSPIRE papers**: `citekeyMapper` returns `not_found` → excluded from allowlist → false `unauthorized_citation` errors
4. **Architectural misplacement**: Hallucination prevention (if needed) belongs in skill layer via evidence catalog constraints

**Action**: Remove `verifyCitations` + `allowed_citations` from `renderLatex.ts`. Cancel citationVerifier extraction (Batch A step 4). Files go to DELETE with `tools/writing/verifier/`.

### 7.2 Orphaned Artifacts After R4

| Item | Status | Action |
|------|--------|--------|
| `candidatePool.ts` | Only caller is `deepResearch.ts` mode='write' (being deleted in Batch D). **Zero callers** post-restructuring. | Move from KEEP → DELETE |
| `allowed_citations_v1.json` | Only consumer was `renderLatex.ts` (R4 removed). `hep_run_build_citation_mapping` still generates it but **nobody reads it**. | Remove allowlist artifact generation from tool handler; keep citekey→INSPIRE mapping (used by `inspire_validate_bibliography`) |
| `hep_run_stage_content` | All internal callers (submitOutlinePlan, submitPapersetCuration, submitReview, submitRevisionPlan) in DELETE list. External caller: `orchestrator_cli.py` (Python, being retired). skills/ has zero references. | Move from KEEP → DELETE |

### 7.3 SOTA Update: 4K Token Cliff Resolved in Top Models

[EQ-Bench Longform Creative Writing Leaderboard](https://eqbench.com/creative_writing_longform.html) (2026-03, 8-chapter continuous writing):
- Claude Sonnet 4.6: **degradation 0.000**, 79.9 score
- Claude Opus 4.6: **degradation 0.000**, 77.7 score
- GPT-5: degradation 0.036, 72.8 score, 13,497 tokens

The LongGenBench (ICLR 2025) finding of "coherence cliff past 4K tokens" is **no longer universally true** for SOTA models. However, single-shot generation still maxes at ~13K tokens — section-by-section remains necessary for full-length review papers (50K-100K tokens).

**Implication**: The deleted writing pipeline's section-by-section strategy was correct. The over-engineering was in the N-best sampling, token budgets, style corpus, and allowlist — not in the fundamental approach. This strategy now belongs in research-writer skill (see §7.4).

### 7.4 NEW-SKILL-WRITING → Enhance research-writer

Original proposal (NEW-SKILL-WRITING) called for creating a new `skills/writing-pipeline/` skill. This is unnecessary — `research-writer` already implements outline + section generation + LaTeX compilation.

**Revised plan**: Enhance `research-writer` skill with:
1. hep-mcp evidence tool integration (`hep_project_query_evidence`, `hep_project_query_evidence_semantic`)
2. Evidence-grounded citation strategy (cite from evidence catalog, not allowlist)
3. Section-by-section generation with cross-section coherence tracking
4. `hep_render_latex` + `hep_export_project` for compilation and packaging

No new skill directory needed. research-writer + paper-reviser + referee-review cover the full writing lifecycle.

### 7.5 Root Cause

These over-engineering patterns share a common origin: hep-mcp was designed before the skill layer existed. Writing orchestration had no other place to live, so it accumulated inside the MCP server. The skill architecture (research-writer, paper-reviser, referee-review, research-team) now provides the correct layer, making the MCP-embedded implementation both redundant and architecturally wrong.
