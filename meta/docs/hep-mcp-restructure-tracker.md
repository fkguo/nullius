# hep-mcp Restructuring Tracker (NEW-06 + NEW-MCP-SAMPLING)

> **Created**: 2026-03-01
> **Source**: `meta/docs/hep-mcp-restructuring-proposal.md` (R8 converged)
> **Status**: BATCH 1 COMPLETE

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

**Session**: _not started_
**Commit**: _pending_

- [ ] 1. Remove `mode='write'` from `deepResearch.ts` + ~50 writing imports
- [ ] 2. Delete `llm/deepWriterAgent.ts` + remove re-export from `llm/index.ts`
- [ ] 3. Delete `core/writing/` 32 files (keep: renderLatex, latexCompileGate, draftSchemas, staging, evidence, writingTypes)
- [ ] 4. Delete `tools/writing/` except `llm/` and `types.ts`
- [ ] 5. Remove ~28 writing tool registrations from `registry.ts`
- [ ] 6. Remove writing schema/handler imports from `registry.ts` (preserve citation mapping params)
- [ ] 7. `pnpm -r build` passes

**Build gate**: _pending_
**Review**: _pending_
**Deviations**: _none_

---

## Batch 3: LLM Client Migration + Final Cleanup (low-medium risk)

**Session**: _not started_
**Commit**: _pending_

- [ ] 1. Plumb MCP sampling: `sendRequest`/`createMessage` into `ToolHandlerContext` (index.ts → dispatcher.ts → handlers)
- [ ] 2. Migrate `theoreticalConflicts.ts` to `ctx.createMessage()` (thread ctx: registry handler → performCriticalResearch → performTheoreticalConflicts)
- [ ] 3. Delete `tools/writing/llm/` (clients/, config.ts, types.ts, index.ts)
- [ ] 4. Delete `tools/writing/types.ts`
- [ ] 5. Delete remaining `tools/writing/` directory
- [ ] 6. Clean stale `next_actions` hints (exportPaperScaffold, create-from-idea, latexCompileGate)
- [ ] 7. `pnpm -r build && pnpm -r test` passes

**Build gate**: _pending_
**Review**: _pending_
**Deviations**: _none_

---

## Batch 4: Test Cleanup + Verification (low risk)

**Session**: _not started_
**Commit**: _pending_

- [ ] 1. Delete test files for removed modules (~38 files, ~260 tests)
- [ ] 2. Update `toolContracts.test.ts` — verify tool count
- [ ] 3. `pnpm -r test` passes (target: ~470 tests)
- [ ] 4. Verify: `getTools('standard')` = 56, `getTools('full')` = 72
- [ ] 5. `make smoke` passes
- [ ] 6. Update `docs/ARCHITECTURE.md`
- [ ] 7. Delete writing recipe docs
- [ ] 8. Update `packages/hep-mcp/CLAUDE.md`

**Build gate**: _pending_
**Review**: _pending_
**Deviations**: _none_

---

## Final Acceptance

- [ ] `getTools('full')` = 72
- [ ] `getTools('standard')` = 56
- [ ] `pnpm -r build` 0 errors
- [ ] `pnpm -r test` ~470 tests pass
- [ ] `make smoke` passes
- [ ] No `createLLMClient` calls in codebase
- [ ] No `tools/writing/` directory
- [ ] No `corpora/` directory
- [ ] `deepResearch.ts` has no `mode='write'`
- [ ] `theoreticalConflicts.ts` uses MCP sampling
- [ ] `docs/ARCHITECTURE.md` updated
- [ ] `packages/hep-mcp/CLAUDE.md` updated
