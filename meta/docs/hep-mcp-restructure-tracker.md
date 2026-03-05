# hep-mcp Restructuring Tracker (NEW-06 + NEW-MCP-SAMPLING)

> **Created**: 2026-03-01
> **Source**: `meta/docs/hep-mcp-restructuring-proposal.md` (R8 converged)
> **Status**: BATCH 4 COMPLETE (CONVERGED)

## Baseline Snapshot

| Metric | Value |
|--------|-------|
| `getTools('full')` | 102 |
| `getTools('standard')` | 79 |
| `pnpm -r test` (hep-mcp) | 727 passed |
| `pnpm -r build` | 0 errors |

---

## Batch 1: Extractions + Dead Code (low risk)

**Session**: 2026-03-01
**Commit**: `de27277`

- [x] 1. Create `utils/latex.ts` — extract `stripLatexPreserveHEP` from `rag/hepTokenizer.ts`
- [x] 2. Create `utils/bibtex.ts` — extract `extractKeyFromBibtex` from `reference/bibtexUtils.ts`
- [x] 3. Create `core/writing/writingTypes.ts` — extract `SentenceAttribution`, `SentenceType` from `tools/writing/types.ts`
- [x] 4. Update KEEP importers to new paths (figureExtractor, tableExtractor, registry, renderLatex)
- [x] 5. Strip `verifyCitations` from `renderLatex.ts` AND `HepRenderLatexToolSchema` in `registry.ts`
- [x] 5a. Update `exportProject.ts` — `rendered_latex_verification.json` optional
- [x] 6. Clean `resources.ts` — remove `hep://corpora/` handlers
- [x] 7. Remove `StyleIdSchema` import from `inputSchemas.ts` (removed all StyleCorpus* schemas, not just inlined)
- [x] 8. Delete `corpora/` (16 files) + `styleCorpusTools.ts` + 8 registry entries + 8 shared constant imports
- [x] 9. `pnpm -r build` passes

**Build gate**: PASS (0 errors, all 11 packages)
**Review**: R1 CONVERGED — Codex 0 BLOCKING / 1 NON-BLOCKING (coverage semantics, fixed), Gemini 0 BLOCKING / READY
**Deviations**:
- Step 7: Instead of inlining `z.string().default('rmp')`, removed all 8 `StyleCorpus*` schemas entirely (they're dead code after Step 8 removes their registry entries). `CorpusEvidenceTypeSchema` also removed.
- Step 5: Also removed `normalizeAllowedCitationsInput`, `expandAllowedCitations`, `AllowedCitationsArtifactInputSchema`, `AllowedCitationsInputSchema` — all dead after verifyCitations removal.
- Step 5a: Also removed now-dead `readRunArtifactJson` function from exportProject.ts (only caller was the verification read).

---

## Batch 2: Writing Pipeline Deletion (medium risk)

**Session**: 2026-03-01
**Commit**: `16b32be` (历史分支) / `33c2448` (main branch equivalent)

- [x] 1. Remove `mode='write'` from `deepResearch.ts` + ~50 writing imports
- [x] 2. Delete `llm/deepWriterAgent.ts` + remove re-export from `llm/index.ts`
- [x] 3. Delete `core/writing/` 32 files (keep: renderLatex, latexCompileGate, draftSchemas, staging, evidence, writingTypes)
- [x] 4. Delete `tools/writing/` except `llm/` and `types.ts`
- [x] 5. Remove ~22 writing tool registrations from `registry.ts`
- [x] 6. Remove writing schema/handler imports from `registry.ts` (preserve citation mapping params)
- [x] 7. `pnpm -r build` passes

**Build gate**: PASS (0 errors, all 11 packages)
**Review**: R1 CONVERGED — Codex 0 BLOCKING / 1 NON-BLOCKING (stale comment, fixed), Gemini Approved / 2 findings (both already fixed before review completed)
**Deviations**:
- Steps 5-6 combined: removed 22 tool registrations, ~15 schema definitions, ~5 dead schema imports, ~22 shared constants. Cleaned `mode=write` references from tool descriptions (HEP_RUN_BUILD_WRITING_EVIDENCE, INSPIRE_RESEARCH_NAVIGATOR).
- Step 1: deepResearch.ts rewritten from 2808→121 lines. Also cleaned discoveryHints.ts (removed write mode suggestion).
- Step 3: Also removed `ideaToOutline.ts` from core/writing/ (discovered as dead code).
- Step 4: Also removed `llm/services/`, `llm/prompts/`, `llm/reranker/` subdirectories.
- Additional: Fixed stale `mode: 'write'` next_actions in `latexCompileGate.ts`, stale `HEP_RUN_BUILD_EVIDENCE_INDEX_V1` in `create-from-idea.ts`, stale comment in `registry.ts`.

---

## Batch 3: LLM Client Migration + Final Cleanup (low-medium risk)

**Session**: 2026-03-01
**Commit**: `7b0ebb7` (main branch)

- [x] 1. Plumb MCP sampling: `sendRequest`/`createMessage` into `ToolHandlerContext` (index.ts → dispatcher.ts → handlers)
- [x] 2. Migrate `theoreticalConflicts.ts` to `ctx.createMessage()` (thread ctx: registry handler → performCriticalResearch → performTheoreticalConflicts)
- [x] 3. Delete `tools/writing/llm/` (clients/, config.ts, types.ts, index.ts)
- [x] 4. Delete `tools/writing/types.ts`
- [x] 5. Delete remaining `tools/writing/` directory
- [x] 6. Clean stale `next_actions` hints (exportPaperScaffold, create-from-idea, latexCompileGate)
- [x] 7. `pnpm -r build && pnpm -r test` passes

**Build gate**: PASS (`pnpm -r build` + `pnpm -r test`)
**Review**: R2 CONVERGED — Codex 0 BLOCKING / 0 NON-BLOCKING, Gemini 0 BLOCKING / 0 NON-BLOCKING
**Deviations**:
- Added stricter unsupported-sampling detection: `llm_mode='internal'` now returns `INVALID_PARAMS` when MCP sampling exists but method is unsupported (`Method not found` / `-32601` path).
- Hardened sampling text extraction to handle MCP array content blocks (`content: [{type:'text',...}]`).
- Added/updated regression tests in `tests/research/theoreticalConflicts.test.ts` for unsupported method + array content parsing.

---

## Batch 4: Test Cleanup + Verification (low risk)

**Session**: 2026-03-01
**Commit**: `095887e` (main branch)

- [x] 1. Delete test files for removed modules (~38 files, ~260 tests)
- [x] 2. Update `toolContracts.test.ts` — verify tool count
- [x] 3. `pnpm -r test` passes (actual: hep-mcp 491 passed, 2 skipped)
- [x] 4. Verify: `getTools('standard')` = 56, `getTools('full')` = 72
- [x] 5. `make smoke` passes
- [x] 6. Update `docs/ARCHITECTURE.md`
- [x] 7. Delete writing recipe docs
- [x] 8. Update `packages/hep-mcp/CLAUDE.md`

**Build gate**: PASS (`pnpm -r build` + `pnpm -r test`)
**Review**: included in NEW-06 convergence flow (final state: 0 BLOCKING)
**Deviations**:
- Test total after cleanup stabilizes at current baseline (not legacy target in proposal): `packages/hep-mcp` now 491 passed + 2 skipped.
- Additional docs cleanup performed beyond minimum list to remove stale write-pipeline references.

---

## Final Acceptance

- [x] `getTools('full')` = 72
- [x] `getTools('standard')` = 56
- [x] `pnpm -r build` 0 errors
- [x] `pnpm -r test` current baseline passes (`packages/hep-mcp`: 491 passed, 2 skipped)
- [x] `make smoke` passes
- [x] No `createLLMClient` calls in codebase
- [x] No `tools/writing/` directory
- [x] No `corpora/` directory
- [x] `deepResearch.ts` has no `mode='write'`
- [x] `theoreticalConflicts.ts` uses MCP sampling
- [x] `docs/ARCHITECTURE.md` updated
- [x] `packages/hep-mcp/CLAUDE.md` updated
