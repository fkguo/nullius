# hep-mcp Restructuring Proposal v2

> **Date**: 2026-03-01
> **Status**: Fresh design (replaces R4 incremental-patch proposal)
> **Method**: Full code survey (274 files) + SOTA verification (5 topics, 30+ sources) + skill ecosystem audit
> **Input**: `meta/docs/hep-mcp-audit-report.md`, full `packages/hep-mcp/src/` traversal, web-sourced 2025-2026 research

## Executive Summary

hep-mcp is a 98K LOC MCP server with 102 tools (full) / 79 tools (standard) and 727 tests (hep-mcp package only; 1103 monorepo total). It was designed before the skill layer existed, causing writing orchestration logic to accumulate inside the MCP server — an architectural mismatch now confirmed as an anti-pattern by multiple independent sources (Docker, O'Reilly/Goose, MCP spec, Phil Schmid, Klavis AI).

**This proposal deletes the entire writing generation/orchestration pipeline** (~40K LOC, ~30 tools), keeping only data access, deterministic operations, and research analysis tools. The writing capability migrates to the skill layer (research-writer enhancement), while the one remaining LLM client dependency (theoreticalConflicts.ts) migrates to MCP sampling.

**Target**: 98K → ~58K LOC, 102 → 72 tools (full), 79 → 56 tools (standard), 727 → ~470 tests (hep-mcp package)

---

## 1. Design Principles

1. **MCP server = deterministic data access + deterministic operations. No embedded LLM clients.**
   Industry consensus (2025-2026): servers that embed LLM clients are an anti-pattern. Sampling protocol (enhanced Nov 2025 with SEP-1577 tool support) is the correct migration path.

2. **Orchestration belongs in the skill/agent layer, not the server.**
   All major agentic writing systems (AI Scientist v2, Agent Laboratory, AgentWrite) implement outline→section→refine→compile in the orchestration layer. The research-writer skill already provides this.

3. **Every retained tool must have an irreplaceable, deterministic justification.**
   If an LLM can do it reliably without tool support, delete it.

4. **No backward compatibility burden.**
   Per CLAUDE.md §全局约束: breaking changes are fine, no deprecation shims, no migration scripts.

5. **Extraction before deletion.**
   Any function used by a KEEP module must be extracted to a stable location before its source file is deleted.

---

## 2. SOTA Verification Summary (2026-03-01)

All previous audit conclusions were re-verified against 30+ web sources. Key findings:

| Claim | Verdict | Key Source |
|-------|---------|------------|
| Section-by-section > single-shot for 50K+ token documents | **CONFIRMED** | EQ-Bench Longform: top models show near-zero degradation per section, but single-shot generation still caps well below 50K tokens |
| MCP servers should NOT embed LLM clients | **CONFIRMED, STRONGER** | Nov 2025 spec added Sampling with Tools (SEP-1577); multiple independent sources label it anti-pattern |
| BoN is valuable but belongs in agent layer | **CONFIRMED** | ICLR 2025 inference scaling laws; modern alternative: extended CoT + PRM |
| RAG still valuable with 200K+ context | **CONFIRMED, STRENGTHENED** | "Context Rot" research: LLM performance degrades as input length grows; hybrid keyword+semantic is 2026 default |
| LLM-as-Judge biases are structural | **CONFIRMED** | ICLR/IJCNLP 2025: position bias + self-preference bias; structural to autoregressive models |

**NEW findings not in previous audit:**
- **MCP Sampling with Tools (SEP-1577, Nov 2025)**: Servers can include tool definitions in sampling requests, enabling full agentic loops. Strengthens migration path for theoreticalConflicts.ts.
- **Context Rot (Chroma Research)**: LLM performance generally degrades as input length increases across multiple tasks/models. Reinforces RAG value.
- **AI Scientist v2**: Accepted to ICLR 2025 workshop (voluntarily withdrawn post-acceptance for transparency). Architecture: outline→section→compile — validates skill-layer approach.
- **"Less is More" MCP pattern (Klavis AI)**: Minimizing tool count and context usage while maximizing relevant information delivery.

---

## 3. Complete Tool Inventory

### 3.1 Tools to DELETE (30 tools: 23 standard + 7 full-only)

> **Note**: Table includes 2 rows (hep_run_build_writing_evidence, hep_run_stage_content) initially marked for deletion but subsequently moved to KEEP during review. These are shown with ~~strikethrough~~ → **KEEP** notation for traceability and are NOT counted in the 30 DELETE total.

Every deleted tool is either (a) writing orchestration that belongs in skill layer, (b) LLM-embedded anti-pattern, or (c) dead code with zero consumers post-restructuring.

| # | Tool Name | Reason |
|---|-----------|--------|
| 1 | `hep_run_writing_create_token_budget_plan_v1` | Writing orchestration → skill layer |
| 2 | `hep_run_writing_token_gate_v1` | Writing orchestration → skill layer |
| 3 | `hep_run_writing_create_section_write_packet_v1` | Writing orchestration → skill layer |
| 4 | `hep_run_writing_create_section_candidates_packet_v1` | N-best orchestration → skill layer |
| 5 | `hep_run_writing_submit_section_candidates_v1` | N-best orchestration → skill layer |
| 6 | `hep_run_writing_create_section_judge_packet_v1` | N-best judge → skill layer |
| 7 | `hep_run_writing_submit_section_judge_decision_v1` | N-best judge → skill layer |
| 8 | `hep_run_writing_create_outline_candidates_packet_v1` | N-best orchestration → skill layer |
| 9 | `hep_run_writing_submit_outline_candidates_v1` | N-best orchestration → skill layer |
| 10 | `hep_run_writing_create_outline_judge_packet_v1` | N-best judge → skill layer |
| 11 | `hep_run_writing_submit_outline_judge_decision_v1` | N-best judge → skill layer |
| 12 | `hep_run_writing_create_paperset_curation_packet` | Writing orchestration → skill layer |
| 13 | `hep_run_writing_submit_paperset_curation` | Writing orchestration → skill layer |
| 14 | `hep_run_writing_build_evidence_packet_section_v2` | Writing-specific RAG → skill layer |
| 15 | `hep_run_writing_submit_rerank_result_v1` | Writing-specific reranking → skill layer |
| 16 | `hep_run_writing_submit_review` | Replaced by referee-review skill |
| 17 | `hep_run_writing_create_revision_plan_packet_v1` | Replaced by paper-reviser skill |
| 18 | `hep_run_writing_submit_revision_plan_v1` | Replaced by paper-reviser skill |
| 19 | `hep_run_writing_refinement_orchestrator_v1` | Writing state machine → skill layer |
| 20 | `hep_run_writing_integrate_sections_v1` | Writing-specific integration → skill layer |
| 21 | `hep_run_build_writing_evidence` | ~~Writing-specific evidence~~ → **KEEP** (R4 Codex finding: `evidenceSemantic.ts` requires embeddings built by this tool; uses local FNV1a32 hashing, no LLM calls — actually a data preparation tool) |
| 22 | `hep_run_build_evidence_index_v1` | Writing-specific index; only consumers are DELETE targets |
| 23 | `hep_run_build_writing_critical` | Duplicates `inspire_critical_research` |
| 24 | `hep_run_stage_content` | ~~All callers deleted~~ → **KEEP** (R2 Codex finding: exportPaperScaffold.ts uses it for figure recovery) |
| 25 | `inspire_style_corpus_query` | Style corpus → research-writer skill |
| 26 | `inspire_style_corpus_init_profile` | Style corpus |
| 27 | `inspire_style_corpus_build_manifest` | Style corpus |
| 28 | `inspire_style_corpus_download` | Style corpus |
| 29 | `inspire_style_corpus_build_evidence` | Style corpus |
| 30 | `inspire_style_corpus_build_index` | Style corpus |
| 31 | `inspire_style_corpus_export_pack` | Style corpus |
| 32 | `inspire_style_corpus_import_pack` | Style corpus |

### 3.2 Tools to KEEP (72 full / 56 standard)

#### Data Access (irreplaceable — LLM cannot query APIs)

| Tool | Justification |
|------|---------------|
| `inspire_search` | Only INSPIRE database interface |
| `inspire_search_next` | Pagination |
| `inspire_literature` | Unified paper/reference/citation/bibtex/author access |
| `inspire_resolve_citekey` | Deterministic citekey → recid resolution |
| `inspire_paper_source` | arXiv source download + multi-file resolution |
| `inspire_research_navigator` | 8 research modes, pure data analysis |
| `inspire_critical_research` | Evidence grading, conflict detection, theoretical analysis |
| `inspire_deep_research` | mode='analyze' + mode='synthesize' (mode='write' deleted) |
| `inspire_find_crossover_topics` | Interdisciplinary arXiv category analysis |
| `inspire_analyze_citation_stance` | Stance detection pipeline |
| `inspire_validate_bibliography` | INSPIRE-backed bibliography cross-validation |
| `inspire_cleanup_downloads` | Housekeeping |
| `hep_inspire_search_export` | Export search results |
| `hep_inspire_resolve_identifiers` | Identifier resolution |
| PDG tools (9) | Aggregated from pdg-mcp |
| arXiv tools (3) | Aggregated from arxiv-mcp |
| Zotero tools (7) | Aggregated from zotero-mcp + INSPIRE enrichment |
| HEPData tools (~3) | Aggregated from hepdata-mcp |

#### Deterministic Operations (LLM cannot do reliably)

| Tool | Justification |
|------|---------------|
| `hep_project_build_evidence` | LaTeX → structured JSONL extraction with byte-offset locators |
| `hep_project_query_evidence` | BM25 lexical search over evidence catalog |
| `hep_project_query_evidence_semantic` | Semantic search with embeddings |
| `hep_run_build_writing_evidence` | Build evidence embeddings (FNV1a32 hashing, no LLM); required by semantic query tool |
| `hep_project_playback_evidence` | Locator → snippet resolution |
| `hep_project_compare_measurements` | Pairwise z-score tension analysis |
| `hep_run_build_pdf_evidence` | Docling-based PDF → structured content extraction |
| `hep_run_build_measurements` | 7 regex patterns for HEP uncertainties |
| `hep_run_build_citation_mapping` | Citekey → INSPIRE recid resolution |
| `hep_render_latex` | LaTeX rendering (citation verification removed — R4) |
| `hep_export_project` | Deterministic packaging |
| `hep_export_paper_scaffold` | LaTeX scaffold + manifest |
| `hep_import_paper_bundle` | Zip + manifest processing |
| `hep_import_from_zotero` | Bibliography + metadata import |
| `inspire_parse_latex` | AST-based LaTeX extraction |

#### State Management

| Tool | Justification |
|------|---------------|
| `hep_project_create` / `get` / `list` | Project CRUD |
| `hep_run_create` | Run lifecycle |
| `hep_run_read_artifact_chunk` | Debug byte-range access |
| `hep_run_stage_content` | General-purpose content staging (used by exportPaperScaffold.ts for figure recovery) |
| `hep_run_clear_manifest_lock` | Stale lock recovery |
| `hep_health` | Server + INSPIRE probe |

#### Cross-Component Integration

| Tool | Justification |
|------|---------------|
| `hep_run_ingest_skill_artifacts` | Computation evidence ingestion |
| `hep_run_create_from_idea` | Idea → Run bridge |
| Orchestrator tools (ORCH_TOOL_SPECS) | Phase 2 infrastructure |

---

## 4. Dependency Analysis — Extraction Before Deletion

Four extraction operations must complete before their source files can be deleted. Each has exactly one or two KEEP consumers.

| # | Function(s) | Source (DELETE) | Destination (NEW) | KEEP Consumer(s) |
|---|-------------|----------------|-------------------|-------------------|
| 1 | `stripLatexPreserveHEP` | `tools/writing/rag/hepTokenizer.ts` | `utils/latex.ts` | `tools/research/latex/figureExtractor.ts`, `tableExtractor.ts` |
| 2 | `extractKeyFromBibtex` | `tools/writing/reference/bibtexUtils.ts` | `utils/bibtex.ts` | `tools/registry.ts` |
| 3 | `SentenceAttribution`, `SentenceType` | `tools/writing/types.ts` | `core/writing/writingTypes.ts` | `core/writing/renderLatex.ts` |
| 4 | `verifyCitations` removal | `renderLatex.ts` imports | (remove import + call) | `renderLatex.ts` (self — remove broken verification) |

Note: `core/writing/evidence.ts` is KEPT (not deleted), so `parseEmbeddingsJsonl`/`queryEvidenceByEmbeddings` imports from `evidenceSemantic.ts` require no extraction.

**renderLatex.ts post-restructuring contract**: After citation verification removal, `hep_render_latex` accepts a draft JSON (ReportDraft schema) and produces LaTeX output. No citation validation, no allowlist loading. The tool is a pure deterministic renderer: draft JSON → LaTeX files + compilation. Citation correctness is the responsibility of the upstream skill (research-writer constrains citations to evidence catalog entries).

**R4 correction**: `llmReranker.ts` was listed as KEEP in R4 (needing MCP sampling migration). Fresh analysis shows ALL its consumers (`evidenceSelection.ts`, `rag/retriever.ts`, `rag/index.ts`) are in the DELETE list. Post-restructuring, `llmReranker.ts` has zero callers → DELETE. This simplifies NEW-MCP-SAMPLING from 2 consumers to 1 (`theoreticalConflicts.ts` only).

---

## 5. LLM Client Analysis

### Current LLM Client Consumers (7 files)

| File | LLM Usage | Post-Restructuring |
|------|-----------|-------------------|
| `core/writing/outlinePlanner.ts` | `createLLMClient` for outline generation | **DELETE** (writing pipeline) |
| `core/writing/papersetPlanner.ts` | `createLLMClient` for paperset curation | **DELETE** (writing pipeline) |
| `tools/writing/llm/deepWriterAgent.ts` | `createLLMClient` for agent loop | **DELETE** (re-exported from `llm/index.ts`; consumers: `deepResearch.ts` mode='write' + `deepWriter/writer.ts` — both removed in Batch 2; file deleted in Batch 2 step 2 after mode='write' removal, re-export removed from `llm/index.ts`) |
| `tools/writing/rag/llmReranker.ts` | `createLLMClient` for evidence reranking | **DELETE** (all consumers deleted) |
| `tools/research/deepResearch.ts` | `createLLMClient` for mode='write' | **DELETE** (mode='write' removed; analyze/synthesize don't use LLM client) |
| `tools/research/theoreticalConflicts.ts` | `createLLMClient` for conflict analysis | **KEEP → migrate to MCP sampling** |
| `tools/writing/llm/clients/` (4 files) | Client implementations | **DELETE** after theoreticalConflicts migration |

### Migration Plan

Only `theoreticalConflicts.ts` survives. Migration path:
1. **Immediate**: Extract `theoreticalConflicts.ts` LLM call to use MCP `sampling/createMessage`
2. **Delete**: `tools/writing/llm/` directory (clients/, config.ts, types.ts, index.ts) — Batch 3. `deepWriterAgent.ts` deleted in Batch 2 (after mode='write' removal + re-export removal).
3. **Result**: Zero embedded LLM clients in hep-mcp

---

## 6. Directory Structure After Restructuring

```
packages/hep-mcp/src/
├── api/                          (unchanged)
│   ├── client.ts
│   └── rateLimiter.ts
├── cache/                        (unchanged)
├── core/
│   ├── contracts/                (unchanged — promptPacket, reviewerReport, revisionPlan, clientContinuation)
│   ├── evidence.ts              (project-level — KEEP)
│   ├── evidenceSemantic.ts       (KEEP — imports from writing/evidence.ts which is KEPT)
│   ├── export/                   (unchanged)
│   ├── hep/                      (unchanged — measurements)
│   ├── pdf/                      (unchanged)
│   ├── resources.ts             (cleaned: remove hep://corpora/ handlers)
│   ├── runs.ts                   (unchanged)
│   ├── writing/                  (DRASTICALLY REDUCED — 6 files)
│   │   ├── renderLatex.ts       (KEEP — verifyCitations removed, pure rendering)
│   │   ├── latexCompileGate.ts  (KEEP — standalone compile gate)
│   │   ├── draftSchemas.ts      (KEEP — ReportDraft/SectionDraft/SentenceDraft Zod schemas)
│   │   ├── staging.ts           (KEEP — stageRunContent used by hep_run_stage_content tool)
│   │   ├── evidence.ts          (KEEP — buildRunWritingEvidence + embeddings query functions; used by hep_run_build_writing_evidence + evidenceSemantic.ts)
│   │   └── writingTypes.ts      (NEW — SentenceAttribution/SentenceType extracted from tools/writing/types.ts)
│   ├── zotero/                   (unchanged)
│   ├── projects.ts, paths.ts, runs.ts, citations.ts, ids.ts, papers.ts, etc.  (unchanged)
│   └── ...
├── data/                         (unchanged)
├── tools/
│   ├── registry.ts              (reduced — ~30 tool registrations removed)
│   ├── dispatcher.ts            (unchanged)
│   ├── mcpSchema.ts             (unchanged)
│   ├── orchestrator/            (unchanged)
│   ├── research/                (simplified)
│   │   ├── deepResearch.ts      (mode='write' removed, LLM imports removed)
│   │   ├── researchNavigator.ts (unchanged)
│   │   ├── criticalResearch.ts  (unchanged)
│   │   ├── theoreticalConflicts.ts (LLM client → MCP sampling)
│   │   ├── theoreticalConflict/  (unchanged — lexicon)
│   │   ├── latex/               (unchanged — 18 files; figureExtractor.ts + tableExtractor.ts updated hepTokenizer import → utils/latex)
│   │   ├── stance/              (unchanged — 13 files)
│   │   ├── synthesis/           (unchanged)
│   │   ├── preprocess/          (unchanged)
│   │   └── ... (other research modules — unchanged)
│   ├── create-from-idea.ts      (unchanged)
│   ├── ingest-skill-artifacts.ts (unchanged)
│   └── utils/                    (unchanged — discoveryHints, health, telemetry)
├── utils/
│   ├── bibtex.ts                (NEW — extracted extractKeyFromBibtex)
│   ├── latex.ts                 (NEW — extracted stripLatexPreserveHEP)
│   └── ... (existing utils unchanged)
└── index.ts
```

**Deleted directories** (entire trees, across Batches 1-3):
- `corpora/` (16 files — style corpus, Batch 1)
- `tools/writing/` (entire directory — Batch 2 deletes everything except `llm/` and `types.ts`; Batch 3 deletes `llm/` + `types.ts` after sampling migration)

**Deleted from core/writing/** (32 of 37 existing files — 5 existing kept: renderLatex.ts, latexCompileGate.ts, draftSchemas.ts, staging.ts, evidence.ts; plus 1 new: writingTypes.ts):
- `sectionCandidates.ts`, `sectionJudge.ts`, `outlineCandidates.ts`, `outlineJudge.ts`, `nbestJudgeSchemas.ts`
- `sectionWritePacket.ts`, `submitSection.ts`
- `refinementOrchestrator.ts`, `submitReview.ts`, `submitRevisionPlan.ts`, `revisionPlanPacket.ts`
- `submitOutlinePlan.ts`, `outlinePlanPacket.ts`, `papersetCurationPacket.ts`, `submitPapersetCuration.ts`
- `tokenBudgetPlan.ts`, `tokenGate.ts`, `sectionQualityEvaluator.ts`, `qualityPolicy.ts`
- `evidenceIndex.ts`, `evidenceSelection.ts`, `critical.ts`, `integrate.ts`
- `sectionOutputSchema.ts`, `sectionStructureVerifier.ts`, `globalChecks.ts`, `reproducibility.ts`
- `missingArtifactNextActions.ts`, `outlineContractGate.ts`, `outlinePlanner.ts`, `papersetPlanner.ts`
- `candidatePool.ts`

---

## 7. Execution Plan (4 Batches)

### Batch 1: Extractions + Dead Code (low risk)

**Goal**: Extract all functions needed by KEEP modules; remove obviously dead code.

1. Create `utils/latex.ts` — extract `stripLatexPreserveHEP` from `rag/hepTokenizer.ts`
2. Create `utils/bibtex.ts` — extract `extractKeyFromBibtex` from `reference/bibtexUtils.ts`
3. Create `core/writing/writingTypes.ts` — extract `SentenceAttribution`, `SentenceType` from `tools/writing/types.ts`
4. Update all KEEP importers to use new paths (`figureExtractor.ts`, `tableExtractor.ts`, `registry.ts`, `renderLatex.ts`). Note: `evidenceSemantic.ts` imports from `evidence.ts` which is KEPT — no change needed.
5. Strip `verifyCitations` import + call + `allowed_citations` + `verification_artifact_name` parameters from `renderLatex.ts` AND `HepRenderLatexToolSchema` in `registry.ts` (must be consistent — handler and schema updated in same batch)
5a. Update `exportProject.ts` to treat `rendered_latex_verification.json` as optional (currently required — will fail after verification removal). Make the zip packaging tolerate its absence.
6. Clean `resources.ts` — remove `hep://corpora/` handlers and `corpora/style/paths.js` import (MUST precede corpora/ deletion)
7. Remove `StyleIdSchema` import from `tools/writing/inputSchemas.ts` — replace with inline `z.string().default('rmp')` (MUST precede corpora/ deletion; `inputSchemas.ts` itself is deleted in Batch 2)
8. Delete `corpora/` directory (16 files) + `styleCorpusTools.ts` + 8 style corpus tool registrations from registry (including their corresponding 8 `StyleCorpus*ToolSchema` imports)
9. Run `pnpm -r build` — verify compilation succeeds (test cleanup deferred to Batch 4; some tests for deleted modules may fail at this point)

**Risk**: Low. Pure refactoring + dead code removal.

### Batch 2: Writing Pipeline Deletion (medium risk)

**Goal**: Delete all writing generation, orchestration, N-best, token management, and review submission modules.

1. Remove `mode='write'` from `deepResearch.ts` + its ~50 writing imports (MUST precede deepWriter/ deletion — deepResearch.ts imports from deepWriter/)
2. Delete `llm/deepWriterAgent.ts` + remove its re-export from `llm/index.ts` (safe after step 1 — `deepResearch.ts` no longer imports `DeepWriterAgent`; `deepWriter/writer.ts` about to be deleted in step 4)
3. Delete from `core/writing/`: all 32 existing files listed in §6 (everything except renderLatex.ts, latexCompileGate.ts, draftSchemas.ts, staging.ts, evidence.ts; keep writingTypes.ts[new])
4. Delete from `tools/writing/`: entire directory **except `llm/` and `types.ts`**. Delete: rag/, verifier/, claimsTable/, contentIndex/, originality/, outline/, reference/, prompts/, rubric/, templates/, utils/, deepWriter/, state/, writingToolHandlers.ts, inputSchemas.ts, styleCorpusTools.ts, index.ts. (Note: `types.ts` is kept because `llm/config.ts`, `llm/types.ts`, and `llm/clients/*` import from it — deferred to Batch 3)
5. Remove ~28 writing tool registrations from `registry.ts`
6. Remove must-remove imports in `registry.ts`: all writing schema imports, writing handler imports, and `HEP_RUN_STAGE_CONTENT` usage in deleted tool registrations. Note: `HepRenderLatexToolSchema` `allowed_citations`/`verification_artifact_name` params already removed in Batch 1 step 5. `HepRunBuildCitationMappingToolSchema` params `allowed_citations_primary`/`include_mapped_references` are NOT removed — they are actively consumed by the handler (R6 Codex finding).
7. Run `pnpm -r build` — fix any remaining broken imports (tests deferred to Batch 4)

**Risk**: Medium. Large deletion but dependency graph is fully mapped — no KEEP module depends on any DELETE module (after Batch 1 extractions).

### Batch 3: LLM Client Migration + Final Cleanup (low risk)

**Goal**: Migrate sole remaining LLM consumer to MCP sampling; delete LLM infrastructure; clean up stale next_actions hints.

1. **Plumb MCP sampling into tool handlers**: Currently `ToolHandlerContext` only has `{reportProgress, rawArgs}`. Must:
   a. Add `sendRequest` (from MCP SDK `extra.sendRequest`) to the handler context passed through `index.ts` → `dispatcher.ts` → tool handlers
   b. Add `createMessage` convenience wrapper (calls `sendRequest('sampling/createMessage', ...)`)
   c. This is prerequisite infrastructure for sampling migration — without it, `theoreticalConflicts.ts` cannot call `sampling/createMessage`
2. Migrate `theoreticalConflicts.ts` from `createLLMClient()` to `sampling/createMessage` (using the new `createMessage` from handler context). This requires threading ctx through the handler chain: `registry.ts` `inspire_critical_research` handler → `performCriticalResearch()` → `performTheoreticalConflicts()` (currently take no ctx argument).
3. Delete `tools/writing/llm/` directory (clients/, config.ts, types.ts, index.ts) — now safe since sole consumer migrated (note: `deepWriterAgent.ts` already deleted in Batch 2)
4. Delete `tools/writing/types.ts` (deferred from Batch 2 — `llm/` imports from it)
5. Delete any remaining `tools/writing/` directory (should be empty after Batch 2 + this step)
6. Clean up stale `next_actions` hints in KEEP files that reference deleted tools:
   - `exportPaperScaffold.ts`: remove reference to `HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1`
   - `create-from-idea.ts`: remove reference to `HEP_RUN_BUILD_EVIDENCE_INDEX_V1`
   - `latexCompileGate.ts`: remove `mode:'write'` suggestion in next_actions
7. Run `pnpm -r build && pnpm -r test` — full validation

**Risk**: Low-medium. Sampling plumbing is straightforward (single new field in handler context type). Migration is single consumer with well-defined sampling protocol. Note: sampling depends on the MCP client implementing `sampling/createMessage`; if the intended client doesn't support it, `mode='theoretical'` will fail (acceptable breaking change per §1.4).

### Batch 4: Test Cleanup + Verification (low risk)

**Goal**: Clean up tests, verify final state, update documentation.

1. Delete test files for removed modules (~38 files, ~260 tests)
2. Update `toolContracts.test.ts` — verify tool count
3. Run full test suite: `pnpm -r test`
4. Verify tool count: `getTools('standard')` ≤ 55, `getTools('full')` ≤ 72
5. Run MCP smoke test: `make smoke`
6. Update `docs/ARCHITECTURE.md`
7. Delete writing recipe docs: `WRITING_RECIPE_CLIENT_PATH.md`, `WRITING_RECIPE_DRAFT_PATH.md`
8. Update `packages/hep-mcp/CLAUDE.md` (remove Client Path/writing pipeline references)

**Risk**: Low. Verification + cleanup only.

---

## 8. research-writer Skill Enhancement (NEW-SKILL-WRITING)

### Current State

research-writer already implements:
- RevTeX4-2 scaffold generation
- Section-by-section drafting with writer→auditor convergence (Claude + Gemini)
- BibTeX RevTeX 4.2 hygiene validation
- Evidence-gate checking
- MCP paper manifest consumption

### Enhancement Plan

Add hep-mcp evidence tool integration to research-writer:

1. **Evidence retrieval**: Call `hep_project_query_evidence` and `hep_project_query_evidence_semantic` for section-level evidence grounding
2. **Citation strategy**: Cite from evidence catalog entries (deterministic, traceable) instead of LLM-hallucinated citations
3. **Cross-section coherence**: Track evidence usage across sections to prevent contradictions
4. **Compilation**: Use `hep_render_latex` + `hep_export_project` for final compilation and packaging
5. **Measurement integration**: Use `hep_project_compare_measurements` for numerical consistency

No new skill directory needed. Estimated: ~200 LOC of SKILL.md revisions + script enhancements.

### Post-Removal Capability Ownership

| Capability | Old Owner (hep-mcp) | New Owner | Mechanism |
|-----------|---------------------|-----------|-----------|
| Token budget planning | `hep_run_writing_create_token_budget_plan_v1` | research-writer skill | Heuristic length control in SKILL.md prompts (target word counts per section) |
| Evidence selection/reranking | `hep_run_writing_build_evidence_packet_section_v2` + `submit_rerank_result_v1` | research-writer skill | `hep_project_query_evidence(_semantic)` provides BM25/semantic results; LLM reranking handled by the agent calling the skill (no embedded LLM) |
| Section integration | `hep_run_writing_integrate_sections_v1` | research-writer skill | Outline-guided section assembly + `hep_render_latex` for LaTeX compilation |
| Review/revision cycle | `submit_review` + `submit_revision_plan` + `refinement_orchestrator` | paper-reviser + referee-review skills | Independent skill invocations; orchestrator coordinates |
| Style corpus | 8 `inspire_style_corpus_*` tools | research-writer SKILL.md | Discussion learning from exemplar corpus (already implemented in research-writer) |

---

## 9. REDESIGN_PLAN Impact

### Items to Update

| Item | Change |
|------|--------|
| **NEW-06** | Update LOC estimates, batch structure (4 batches vs 6), tool count targets |
| **NEW-MCP-SAMPLING** | Simplify: 1 consumer (theoreticalConflicts.ts) instead of 2. llmReranker.ts fully deleted, not migrated |
| **NEW-SKILL-WRITING** | Unchanged — enhance research-writer with evidence tool integration |
| **NEW-R14** | Update: `@autoresearch/writing` package scope reduced (no writing pipeline to extract); `@autoresearch/corpora` cancelled |
| **Phase 3 checklist** | Update tool count targets and test count estimates |

### Items Unaffected

All other Phase 3 items (M-03/M-04/M-07~M-10/M-12/M-13/M-15~M-17, L-08, NEW-R11/R12, UX-03/UX-04, RT-01/RT-04, NEW-CONN-05, NEW-COMP-02, NEW-SKILL-01, NEW-RT-05) are unaffected.

---

## 10. Metrics Summary

| Metric | Before | After |
|--------|--------|-------|
| LOC (src/) | ~98K | ~58K |
| Tools (full) | 102 | 72 |
| Tools (standard) | 79 | 56 |
| Tests (hep-mcp) | 727 | ~470 |
| LLM client consumers | 7 | 0 (after sampling migration) |
| Files in core/writing/ | 37 | 6 |
| Files in tools/writing/ | 69 | 0 |
| Files in corpora/ | 16 | 0 |
| Deleted tools | — | 30 (23 standard + 7 full-only) |
| Extracted functions | — | 4 (to 3 new files) |

---

## 11. Success Criteria

1. `pnpm -r build` passes with 0 errors
2. `pnpm -r test` passes (expected: ~470 tests)
3. `getTools('standard')` = 56, `getTools('full')` = 72
4. Zero `createLLMClient` calls in codebase (replaced by sampling)
5. `hep://corpora/` resource namespace removed
6. `mode='write'` absent from `deepResearch.ts`
7. `tools/writing/` directory does not exist
8. `corpora/` directory does not exist
9. All 4 extracted functions verified in their new locations with passing tests
10. `docs/ARCHITECTURE.md` updated
11. `WRITING_RECIPE_CLIENT_PATH.md` and `WRITING_RECIPE_DRAFT_PATH.md` deleted

---

## 12. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Missed hidden extraction dependency | Low | High | Full import graph traced (grep verified); Batch 1 extracts first, Batch 2 deletes second |
| Breaking retained research tools | Low | High | deepResearch analyze/synthesize modes tested immediately after mode='write' removal |
| theoreticalConflicts MCP sampling regression | Low | Medium | Sampling protocol well-defined; functional test before + after |
| Test coverage gap for retained modules | Medium | Low | Retained modules keep their tests; writing tests only test writing logic |
| Skill layer not ready | Low | Low | Skills already work independently; enhancement is additive |

---

## Appendix: Dual-Model Review Log

### R1 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: PASS (0 BLOCKING)

**NON-BLOCKING**:
- NB1 [LOW]: Tool count arithmetic imprecision — suggested 70/47, actual 71/55 after keeping `hep_run_stage_content`
- NB2 [LOW]: deepResearch.ts cleanup should scrub dead types (`WriteResumeFrom`, `RUN_WRITING_STEPS`) after mode='write' removal

**Validated claims**: All 7 review criteria verified independently (dependency extractions, llmReranker deletion, deepResearch isolation, MCP SEP-1577, EQ-Bench scores, AI Scientist v2, skill coverage).

### R1 — Codex GPT-5.2 (2026-03-01)

**Verdict**: FAIL (2 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | `hep_run_stage_content` deletion unsafe — `exportPaperScaffold.ts` (KEEP) imports it for figure recovery | **ACCEPTED**: Moved from DELETE → KEEP. It's a general-purpose content staging tool, not writing-specific |
| B2 | Tool count targets inconsistent with actual registry exposures | **ACCEPTED**: Fixed to exact counts: 71 full / 55 standard (31 tools deleted: 24 standard + 7 full-only) |

**NON-BLOCKING addressed**:
- NB1 [HIGH]: renderLatex.ts new contract — added explicit post-restructuring contract description
- NB2 [MEDIUM]: Must-remove imports in registry.ts — added to Batch 2 step 6
- NB3 [MEDIUM]: SOTA numeric claims — noted as motivation (verified by Gemini independently)
- NB4 [LOW]: Post-removal capability ownership — added explicit ownership table (§8)

### R2 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: PASS (0 BLOCKING)

**NON-BLOCKING**:
- NB1 [MEDIUM]: `HepRenderLatexToolSchema` in registry.ts should also remove `allowed_citations` and `verification_artifact_name` params
- NB2 [LOW]: `HepRunBuildCitationMappingToolSchema` should remove `allowed_citations_primary` and `include_mapped_references` params (no longer consumed)

**Validated claims**: Dependency chain verified, tool count math confirmed (71/55), extraction coverage complete, AI Scientist v2 and MCP SEP-1577 independently verified via web search, skill coverage ownership table validated.

### R2 — Codex GPT-5.2 (2026-03-01)

**Verdict**: FAIL (1 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | Batch 2 deletes `tools/writing/` (including `llm/`), but `theoreticalConflicts.ts` still imports from `tools/writing/llm/`. Build breaks after Batch 2. | **ACCEPTED**: Batch 2 now explicitly excludes `tools/writing/llm/` from deletion. Batch 3 migrates theoreticalConflicts.ts to MCP sampling, then deletes `tools/writing/llm/`. |

**NON-BLOCKING addressed**:
- NB1 [MEDIUM]: Stale `next_actions` hints in KEEP files referencing deleted tools — added cleanup step to Batch 3 (exportPaperScaffold.ts + create-from-idea.ts)
- NB2 [MEDIUM]: AI Scientist v2 wording corrected ("accepted to ICLR workshop, voluntarily withdrawn" — not "first peer-reviewed")
- NB3 [LOW]: Batch 1 step ordering fixed — resources.ts import removal now precedes corpora/ deletion
- NB4 [LOW]: Table row numbering acknowledged (strikethrough row is intentional for traceability)

### R3 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: FAIL (1 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | Batch 1 Step 7 deletes `tools/writing/deepWriter/` and `deepWriterAgent.ts`, but `deepResearch.ts` still imports `DeepWriterAgent`/`buildWritingPacket` for mode='write' (not removed until Batch 2 Step 5). Build breaks after Batch 1. | **ACCEPTED**: Batch 1 Step 7 now only deletes `deepWriterAgent.ts` (zero importers). `deepWriter/` deletion deferred to Batch 2 (after mode='write' removal). |

**NON-BLOCKING**:
- NB1 [LOW]: Style corpus schema imports cleanup in Batch 1 Step 9 — should explicitly mention removing the 8 schema imports from `registry.ts`

**Validated claims**: R2 B1 fix (Batch 2 excludes `tools/writing/llm/`, Batch 3 handles migration + deletion) verified. AI Scientist v2 ICLR workshop acceptance + voluntary withdrawal confirmed. EQ-Bench longform degradation scores confirmed. Tool count (71/55) verified. MCP Sampling SEP-1577 verified.

### R3 — Codex GPT-5.2 (2026-03-01)

**Verdict**: NO OUTPUT (0 bytes — API stream disconnect, known issue with large review packets. Resubmitted in R4.)

### R4 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: FAIL (2 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | Batch 1 Step 7 deletes `deepWriterAgent.ts` but it's re-exported from `llm/index.ts` and imported by `deepResearch.ts` via `llm/index.js`. Build breaks after Batch 1. | **ACCEPTED**: `deepWriterAgent.ts` deletion deferred to Batch 3 (deleted with entire `llm/` directory). Batch 1 has no dead code deletion step. |
| B2 | Batch 2 deletes `core/writing/staging.ts`, but `hep_run_stage_content` (KEEP tool) dynamically imports `stageRunContent` from it via `registry.ts:1527`. Build breaks. | **ACCEPTED**: `staging.ts` added to KEEP list (6th file in `core/writing/`). Removed from deletion list. |

**NON-BLOCKING addressed**:
- NB1 [MEDIUM]: `allowed_citations` cleanup — explicit schema cleanup steps added to Batch 2 step 6 (HepRenderLatexToolSchema + HepRunBuildCitationMappingToolSchema)
- NB2 [LOW]: `candidatePool.ts` deletion implicit in "all 31 files listed in §6" — no separate step needed

**Validated claims**: MCP SEP-1577, EQ-Bench degradation, Context Rot confirmed. AI Scientist v2 not independently verified by Gemini.

### R4 — Codex GPT-5.2 (2026-03-01)

**Verdict**: FAIL (1 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | `hep_project_query_evidence_semantic` (KEEP) requires embeddings built by `hep_run_build_writing_evidence` (DELETE). Deleting the builder breaks semantic retrieval. | **ACCEPTED**: `hep_run_build_writing_evidence` moved from DELETE → KEEP (uses local FNV1a32 hashing, no LLM calls — data preparation tool). `evidence.ts` kept in `core/writing/`. Extraction #3 cancelled (no longer needed). Tool counts updated: 30 DELETE (23 standard + 7 full-only), 72 full / 56 standard KEEP. |

**NON-BLOCKING addressed**:
- NB1 [MEDIUM]: R4 packet text now consistent with proposal (deepWriterAgent.ts deferral)
- NB2 [MEDIUM]: Batch 2 reordered — `mode='write'` removal (step 1) now precedes directory deletions (steps 2-3) for tree compilability during batch
- NB3 [LOW]: hep_run_stage_content strikethrough row acknowledged (intentional for traceability)
- NB4 [MEDIUM]: SOTA claims precision — Chroma "by 1K tokens" and exact EQ-Bench numbers noted as approximate/unverifiable from primary sources; kept as motivation with caveat

### R5 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: PASS (0 BLOCKING)

**NON-BLOCKING**:
- NB1 [LOW]: `HepExportProjectToolSchema` still references `rendered_latex_verification_artifact_name` — should be removed after `verifyCitations` deletion
- NB2 [LOW]: `hep_render_latex` output interface should stop returning verification summary/artifact

**Validated claims**: Dependency chains complete (all KEEP→DELETE paths resolved). Tool counts confirmed (72/56). MCP SEP-1577, Context Rot, AI Scientist v2, EQ-Bench all independently verified.

### R5 — Codex GPT-5.2 (2026-03-01)

**Verdict**: FAIL (2 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | Batch 1 deletes `corpora/` but `tools/writing/inputSchemas.ts` imports `StyleIdSchema` from `../../corpora/style/schemas.js`. `tsc` compiles all `src/**/*` so build breaks. | **ACCEPTED**: Added Batch 1 step 7 — remove `StyleIdSchema` import from `inputSchemas.ts` (replace with inline `z.string()`) BEFORE deleting `corpora/`. |
| B2 | Batch 2 keeps `llm/` but deletes `tools/writing/types.ts` (imported by `llm/config.ts`, `llm/types.ts`, `llm/clients/*`) and `../verifier/*`, `../originality/*`, `../prompts/*` (imported by `deepWriterAgent.ts`). Build breaks. | **ACCEPTED**: (a) `types.ts` deferred to Batch 3 — `llm/` imports from it. (b) `deepWriterAgent.ts` deleted in Batch 2 step 2 (after mode='write' removal) + re-export removed from `llm/index.ts`. |

**NON-BLOCKING addressed**:
- NB2 [MEDIUM]: SOTA EQ-Bench precision noted — leaderboard is JS-driven, exact numbers approximate
- NB3 [LOW]: `latexCompileGate.ts` mode='write' hint — added to Batch 3 step 5 cleanup list
- NB4 [LOW]: §3.1 strikethrough rows acknowledged (intentional for traceability)

### R6 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: PASS (0 BLOCKING)

**NON-BLOCKING**:
- NB1 [LOW]: Batch 4 test cleanup should mention mock data / snapshot tests / `__fixtures__` for deleted modules

**Validated claims**: Dependency chains complete, tool counts (72/56) verified, MCP SEP-1577 confirmed, Context Rot confirmed, AI Scientist v2 confirmed, EQ-Bench degradation confirmed. `theoreticalConflicts.ts` dependency on `types.ts` correctly protected by deferring deletion.

### R6 — Codex GPT-5.2 (2026-03-01)

**Verdict**: FAIL (2 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | `hep_render_latex` verification removal not fully propagated: `exportProject.ts` requires `rendered_latex_verification.json` (will fail if absent). Also `HepRenderLatexToolSchema` must be updated in same batch as handler. | **ACCEPTED**: (a) Batch 1 step 5 now updates both handler AND schema in same batch. (b) Added step 5a: update `exportProject.ts` to treat verification artifact as optional. |
| B2 | `hep_run_build_citation_mapping` schema cleanup contradicts implementation: `allowed_citations_primary` and `include_mapped_references` ARE actively consumed by the handler. | **ACCEPTED**: Dropped the schema cleanup — those params are NOT "no longer consumed". They're real, active parameters. |

**NON-BLOCKING addressed**:
- NB1 [HIGH]: Bookkeeping fixed: `core/writing/` 32 of 37 (5 existing kept), `tools/writing/` 69 files (not 61), §5 deepWriterAgent.ts table updated to say Batch 2
- NB2 [MEDIUM]: `tools/writing/index.ts` and `state/` explicitly added to Batch 2 deletion list
- NB3 [MEDIUM]: EQ-Bench numeric precision — noted as approximate
- NB4 [LOW]: Principle wording changed from "Zero LLM calls" to "No embedded LLM clients"

### R7 — Gemini 3.1 Pro Preview (2026-03-01)

**Verdict**: PASS (0 BLOCKING, 0 NON-BLOCKING)

**Validated claims**: Tool count arithmetic (72/56) verified. Dependency paths (KEEP→DELETE) verified via grep analysis — `mode='write'` removal fully severs deepResearch→candidatePool/outlinePlanner/qualityPolicy dependencies, `llm/` deferred deletion protects `theoreticalConflicts.ts`, `evidence.ts` preserved for `evidenceSemantic.ts`. EQ-Bench confirmed. MCP SEP-1577 confirmed. AI Scientist v2 confirmed. Context Rot confirmed.

### R7 — Codex GPT-5.2 (2026-03-01)

**Verdict**: FAIL (1 BLOCKING)

| # | Finding | Resolution |
|---|---------|------------|
| B1 | Batch 3 step 1 ("migrate `theoreticalConflicts.ts` to `sampling/createMessage`") is not executable as written. `ToolHandlerContext` only has `{reportProgress, rawArgs}` — `extra.sendRequest`/`server.createMessage()` is not reachable from tool code. `index.ts:193` only passes `{requestId, progressToken, sendNotification}` to `handleToolCall()`. Without plumbing `sendRequest` end-to-end, sampling migration is impossible. | **ACCEPTED**: Added explicit Batch 3 step 1 — plumb `sendRequest` from MCP SDK `extra.sendRequest` through `index.ts` → `dispatcher.ts` → `ToolHandlerContext`. Add `createMessage` convenience wrapper. This is prerequisite infrastructure before `theoreticalConflicts.ts` migration. |

**NON-BLOCKING addressed**:
- NB1 [HIGH]: EQ-Bench numeric precision — downgraded to qualitative phrasing ("near-zero degradation per section") since leaderboard is JS-driven and exact numbers not independently confirmable from static sources
- NB2 [MEDIUM]: Batch 1 step 9 validation gate — changed from `pnpm -r build && pnpm -r test` to `pnpm -r build` only, since deleting style corpus tools before their tests (Batch 4) would cause test failures
- NB3 [LOW]: Test count clarified — 726 tests (hep-mcp package only), 1103 monorepo total; audit baseline "1156" was monorepo-wide at a later snapshot

### R8 — Gemini 3.1 Pro Preview (2026-03-01) ✅ CONVERGED

**Verdict**: PASS (0 BLOCKING, 2 LOW NON-BLOCKING)

**NON-BLOCKING** (both LOW implementation details, not proposal issues — discarded):
- NB1: `createMessage` SDK binding specifics
- NB2: `exportProject.ts` stray warning suppression

**Validated claims**: MCP Sampling SEP-1577 verified. Context Rot verified. Dependency extraction order verified via grep. Tool counts (72/56) verified. R7 fix (sampling plumbing) verified.

### R8 — Codex GPT-5.2 (2026-03-01) ✅ CONVERGED

**Verdict**: PASS (0 BLOCKING)

**NON-BLOCKING addressed**:
- NB1 [HIGH]: §3.1 KEEP strikethrough rows — added clarifying note that 2 rows (hep_run_build_writing_evidence, hep_run_stage_content) are NOT counted in 30 DELETE total
- NB2 [MEDIUM]: Batch 2 "run tests" → changed to `pnpm -r build` (tests deferred to Batch 4)
- NB3 [MEDIUM]: Batch 3 step 2 handler threading — added explicit sub-step: thread ctx through `registry.ts` handler → `performCriticalResearch()` → `performTheoreticalConflicts()`
- NB4 [LOW]: §6 duplicate `evidenceSemantic.ts` line removed; `latex/18 files` → clarified only figureExtractor + tableExtractor update hepTokenizer import
- NB5 [LOW]: Client compatibility risk for sampling — added note that `mode='theoretical'` will fail if MCP client doesn't support `sampling/createMessage` (acceptable per §1.4)

**Validated claims**: All 5 review criteria PASS. Dependency chains complete. Tool counts (72/56) verified. MCP sampling protocol confirmed. LongGenBench + WritingPath + LongWriter support outline-guided generation. EQ-Bench per-chapter degradation metric confirmed (qualitative framing accepted).

---

**CONVERGENCE ACHIEVED at R8**: Both Gemini (4 consecutive PASS: R5-R8) and Codex (first PASS at R8) return 0 BLOCKING findings on full packet review. Total review rounds: 8 (R1-R8). Total unique BLOCKING findings resolved: 14 (Codex: 10, Gemini: 4).
