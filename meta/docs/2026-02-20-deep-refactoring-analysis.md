# Deep Refactoring Analysis: Autoresearch Ecosystem

> **Date**: 2026-02-20
> **Analyst**: Opus 4.6
> **Status**: Draft — pending dual-model review (GPT-5.3-Codex + Gemini-3-Pro-Preview)
> **Scope**: Actionable refactoring items NOT already covered by REDESIGN_PLAN.md v1.3.0

## Methodology

Full codebase scan of all 7 components + skills ecosystem. Metrics: file LOC, `as any` count, bare exceptions, test coverage ratio, code duplication, naming violations. Cross-referenced against REDESIGN_PLAN.md 85 items to identify overlap and propose plan edits where needed.

**Pinned commits**: hep-autoresearch `c149965`, hep-research-mcp `d33b869`, idea-core `e27d526`.

## 1. God Files (CODE-01 Compliance)

> **Governing rule**: `ECOSYSTEM_DEV_CONTRACT.md` CODE-01.1 — single file ≤200 eLOC (effective LOC = non-blank, non-comment lines). New/modified files enforced diff-scoped from Phase 1; legacy files aligned in Phase 2 (H-16b). Exemptions use `# CONTRACT-EXEMPT: CODE-01 {reason}` per contract syntax (subrule cited in reason, e.g., `CODE-01.1`).
>
> **Decomposition strategy for legacy god files**: Splitting a >2000 eLOC file into ≤200 eLOC modules in one pass is infeasible. Intermediate decomposition outputs may exceed 200 eLOC and must each carry `# CONTRACT-EXEMPT: CODE-01 decomposition-in-progress (CODE-01.1) {tracking-issue} sunset:{YYYY-MM-DD}`. Each exempted file must have a tracking issue with target date to reach ≤200 eLOC.
>
> **CONTRACT-EXEMPT enforcement design** (**proposed contract amendment** — the sunset enforcement and file-level LOC exemption mechanisms below are policy expansions not currently in `ECOSYSTEM_DEV_CONTRACT.md`; they require governance approval before implementation):
>
> **Prerequisite**: This mechanism cannot be used until a governance-approved CI change is landed. The current CODE-01 LOC check (as specified in the contract) does NOT honor `CONTRACT-EXEMPT` markers — it counts all non-exempt lines in all diff-scoped files with no file-level exemption path. The extensions below require: (1) a governance proposal (amend `ECOSYSTEM_DEV_CONTRACT.md` CODE-01 to add file-level `CONTRACT-EXEMPT` filtering for LOC checks and sunset enforcement); (2) implementation in `autoresearch-meta/scripts/check_loc.py` (which does not exist at pinned commits — it is specified in the contract but not implemented). **Phase placement**: this CI change is a **Phase 0 prerequisite deliverable** — it must land before any decomposition work uses `CONTRACT-EXEMPT` markers for intermediate >200 eLOC files. Without this prerequisite, intermediate decomposition outputs that exceed 200 eLOC will fail the CI gate.
>
> **Note on current contract enforcement behavior**: line-level checks (CODE-01.4 `as any`, CODE-01.5 silent swallows) already filter out lines containing `CONTRACT-EXEMPT` via the grep pipeline — this is per-line exemption and works today. File-level checks (CODE-01.1 LOC budget) do NOT have any `CONTRACT-EXEMPT` filtering — this is the policy extension proposed below. Implementers must not assume exemptions work uniformly across subrules.
> - **Scope**: the CI script operates on the diff-scoped file list (`git diff --name-only` against the base branch).
> - **Exemption marker**: the `CONTRACT-EXEMPT` comment must appear on any line of the file. For line-level checks (CODE-01.4 `as any`, CODE-01.5 silent swallows), the contract's existing grep pipeline already filters out matched lines containing `CONTRACT-EXEMPT` — this provides per-line exemption. For file-level checks (CODE-01.1 LOC budget — **proposed extension**), the CI script scans each diff-scoped file for a line matching `CONTRACT-EXEMPT:.*CODE-01.1` (**must cite CODE-01.1 specifically** — a CODE-01.4 or CODE-01.5 exemption does NOT disable the LOC gate; each subrule's exemption is independent). The CODE-01.1 exemption marker must include: (a) the subrule `CODE-01.1`, (b) a tracking reference (issue/PR number), and (c) a `sunset:{YYYY-MM-DD}` date. Example: `# CONTRACT-EXEMPT: CODE-01 decomposition-in-progress (CODE-01.1) #123 sunset:2026-06-30`. **Cross-subrule isolation**: a CODE-01.1 LOC exemption does NOT exempt the file from CODE-01.4 (`as any`) or CODE-01.5 (silent swallow) line-level checks — those checks continue to apply to all non-exempt lines in the file.
> - **Sunset enforcement** (**proposed extension**): the CI script parses the `sunset:{YYYY-MM-DD}` date from `CONTRACT-EXEMPT` comments. If the current date exceeds the sunset date, the build fails regardless of exemption — this prevents "temporary" decomposition files from becoming permanent technical debt. **Rationale**: without enforcement, exemptions become permanent; the sunset mechanism provides a time-bound escape hatch.
> - **LOC check for non-exempt files**: `grep -cvE '^\s*$|^\s*#|^\s*//|^\s*/?\*' <file>` (contract heuristic); fail if result > 200.
> - These extensions are pragmatic concessions within the existing CODE-01 exemption mechanism — no parallel enforcement system is introduced.
>
> **Fallback if governance rejects file-level LOC exemption**: a LOC **ratchet** for legacy files — any touched file must not increase eLOC (and ideally must decrease). The ratchet avoids inventing a new exemption surface while still enabling incremental splits: `check_loc.py` stores per-file eLOC baselines; CI fails if a touched file's eLOC exceeds its baseline. This is a weaker mechanism (no sunset enforcement, no explicit decomposition tracking) but requires no contract amendment.
>
> **Counting method**: CODE-01 specifies a `grep -cvE` heuristic for LOC counting (known to overcount Python docstrings); the CI enforcement scripts are specified in the contract but **not yet implemented** at the pinned commits — this analysis uses the same heuristic for consistency with the contract's specification. Phase 3 upgrades to AST-based lint (ESLint custom rule for TS, `ast` module for Python).

### 1.1 Critical (>2000 raw LOC)

| File | raw LOC | Component | Violation Factor (vs 200 eLOC) |
|---|---|---|---|
| `hep-autoresearch/src/.../orchestrator_cli.py` | 6041 | hep-autoresearch | 30× |
| `hep-research-mcp/.../equationTypeSignals.ts` | 4592 | hep-research-mcp | 23× |
| `idea-core/src/.../engine/service.py` | 3165 | idea-core | 16× |
| `hep-research-mcp/.../tools/registry.ts` | 2975 | hep-research-mcp | 15× |
| `hep-research-mcp/.../research/deepResearch.ts` | 2799 | hep-research-mcp | 14× |
| `hep-research-mcp/.../zotero-mcp/src/zotero/tools.ts` | 2510 | zotero-mcp | 13× |
| `hep-research-mcp/.../vnext/zotero/tools.ts` | 2339 | hep-research-mcp | 12× |
| `skills/paper-reviser/scripts/bin/paper_reviser_edit.py` | 2122 | skills | 11× |
| `hep-research-mcp/.../corpora/style/evidence.ts` | 2021 | hep-research-mcp | 10× |

### 1.2 Severe (1200–2000 raw LOC)

| File | raw LOC | Component |
|---|---|---|
| `hep-research-mcp/.../pdg-mcp/src/tools/registry.ts` | 1992 | pdg-mcp |
| `hep-research-mcp/.../vnext/writing/evidenceSelection.ts` | 1892 | hep-research-mcp |
| `skills/research-team/scripts/bin/literature_fetch.py` | 1775 | skills |
| `hep-research-mcp/.../vnext/writing/evidenceIndex.ts` | 1767 | hep-research-mcp |
| `skills/auto-relay/scripts/relay.py` | 1448 | skills |
| `hep-autoresearch/src/.../toolkit/orchestrator_regression.py` | 1377 | hep-autoresearch |
| `hep-autoresearch/src/.../toolkit/w3_paper_reviser.py` | 1262 | hep-autoresearch |

### 1.3 High (500–1400 raw LOC, selected)

| File | raw LOC | Component |
|---|---|---|
| `vnext/writing/submitSection.ts` | 1387 | hep-research-mcp |
| `corpora/style/intentSignals.ts` | 1203 | hep-research-mcp |
| `vnext/evidence.ts` | 1188 | hep-research-mcp |
| `api/client.ts` | 1140 | hep-research-mcp |
| `vnext/export/exportProject.ts` | 1049 | hep-research-mcp |
| `tools/research/theoreticalConflicts.ts` | 1030 | hep-research-mcp |
| `toolkit/method_design.py` | 1024 | hep-autoresearch |
| `toolkit/w1_ingest.py` | 928 | hep-autoresearch |
| `vnext/pdf/evidence.ts` | 946 | hep-research-mcp |
| `vnext/writing/evidence.ts` | 931 | hep-research-mcp |

**Impact**: 9 files exceed 2000 raw LOC; 7 more in the 1200–2000 range; ~30 more exceed 500. The CODE-01.1 ≤200 eLOC discipline is systematically violated. All counts above are **raw `wc -l` LOC** (see Appendix A); effective LOC will be lower but violation factors remain severe.

**CODE-01.2 banned-filename inventory** (CODE-01.2 禁止万能文件名: `utils`, `helpers`, `common`, `service`, `misc`):
- `idea-core/src/idea_core/engine/service.py` (3165 LOC) — **must rename** during NEW-R10 decomposition (→ `engine/coordinator.py`)
- `packages/shared/src/types/common.ts` (63 LOC) — low-value file with catch-all types; **exempt** (too small to split, but should be reviewed during NEW-R06 type consolidation for absorption into domain-specific type files)
- `hep-autoresearch/src/hep_autoresearch/toolkit/adapters/*.py` — no banned filenames found
- No `utils.ts`, `helpers.ts`, `misc.ts` files detected in `hep-research-mcp/src/`

**eLOC spot-check** (contract heuristic: `grep -cvE '^\s*$|^\s*#|^\s*//|^\s*/?\*'`; top 5 offenders):

| File | raw LOC | heuristic eLOC | Violation Factor (vs 200 eLOC) |
|---|---|---|---|
| `orchestrator_cli.py` | 6041 | ~4200 | ~21× |
| `equationTypeSignals.ts` | 4592 | ~3800 | ~19× |
| `service.py` | 3165 | ~2200 | ~11× |
| `registry.ts` | 2975 | ~2400 | ~12× |
| `deepResearch.ts` | 2799 | ~2100 | ~11× |

Note: heuristic eLOC overcounts Python docstrings (multi-line strings not excluded by grep). Phase 3 AST-based lint will produce accurate eLOC.

**Reproducible scan command**:
```bash
# Files exceeding 2000 raw LOC across all source directories
find hep-autoresearch/src hep-research-mcp-main/packages/*/src idea-core/src skills/*/scripts \
  -type f \( -name '*.py' -o -name '*.ts' \) -print0 \
  | xargs -0 wc -l | sort -rn | awk '$1 > 2000 && !/total$/'
```

**Recommendation**: NEW-R01 — Systematic god-file splitting pass. End-state: all files ≤200 eLOC (CODE-01.1 compliant). Intermediate decomposition outputs may use `# CONTRACT-EXEMPT: CODE-01 decomposition-in-progress (CODE-01.1)` up to ≤500 eLOC with tracked sunset dates. This is an umbrella item; the three highest-priority files have dedicated sub-items:
- NEW-R09: `orchestrator_cli.py` (blocks TS migration)
- NEW-R10: `service.py` (blocks idea-engine migration)
- NEW-R11: `registry.ts` (blocks tool consolidation, scope expansion of M-13)

Remaining 6 files >2000 raw LOC (plus 7 in the 1200–2000 band) are tracked under NEW-R01 as explicit subtasks, each with acceptance criteria (≤200 eLOC final, sunset-dated CONTRACT-EXEMPT intermediate), prioritized using the following rubric:

**Subtask tracker** (remaining >2000 raw LOC files not covered by R09/R10/R11):

| File | raw LOC | Dep. Crit. | Churn | Test | Coupling | Total | Acceptance |
|---|---|---|---|---|---|---|---|
| `equationTypeSignals.ts` | 4592 | 0 (no plan blocker) | TBD* | 3 (no test file) | 1 (2 importers: `equationExtractor.ts`, `vnext/evidence.ts`) | 4+ | ≤200 eLOC per output module |
| `zotero-mcp/tools.ts` | 2510 | 3 (blocks PLUG-01) | TBD* | 2 (has tests, coverage unk.) | 0 (0 cross-package importers†) | 5+ | Covered by NEW-R04 consolidation |
| `vnext/zotero/tools.ts` | 2339 | 3 (blocks PLUG-01) | TBD* | 2 (has tests, coverage unk.) | 0 (1 importer: `tools/registry.ts`) | 5+ | Covered by NEW-R04 consolidation |
| `paper_reviser_edit.py` | 2122 | 0 (no plan blocker) | TBD* | 3 (no test file) | 0 (standalone script) | 3+ | Covered by NEW-R08 skills budget |
| `corpora/style/evidence.ts` | 2021 | 1 (partial NEW-R05) | TBD* | 3 (0 test files in corpora/style/) | 0 (1 importer: `styleCorpusTools.ts`) | 4+ | Partially covered by NEW-R05 evidence abstraction |
| `pdg-mcp/registry.ts` | 1992 | 1 (M-13 scope) | TBD* | 2 (has tests, coverage unk.) | 0 (0 cross-package importers†) | 3+ | Align with M-13 registry split |

\* Churn requires `git log` on the actual repositories (not available from extracted snapshots at pinned commits). Compute before Phase 1 kickoff using the rubric commands.
† Cross-package importers: `zotero-mcp/tools.ts` and `pdg-mcp/registry.ts` are standalone package entry points; coupling measured as cross-package imports (0), not intra-package references.

**Coupling measurement method**: module-specific import-path matching via `rg -l "<module_path>" --type ts` (e.g., `rg -l "equationTypeSignals" src/`), NOT the broad `import.*tools` pattern used in earlier revisions (which produced false positives from unrelated tool imports).

Score each file using the rubric below; address highest-total files first.

**Prioritization rubric** (score each file 0–3 per factor; address highest-total files first):
1. **Dependency criticality**: Does this file block a REDESIGN_PLAN migration? (3 = blocks Phase 1 item, 0 = no downstream dependency)
2. **Churn rate**: Measured via `git log --since="6 months ago" --format="%H" -- <file> | wc -l`. (3 = >20 commits in 6 months, 2 = 10–20, 1 = 5–10, 0 = <5)
3. **Test coverage**: Presence of corresponding test file + instrumented line coverage if available. (3 = no test file, 2 = test file but <30% line coverage, 1 = 30–70%, 0 = >70%)
4. **Coupling**: Measured via `rg "import.*<module>" --files-with-matches | wc -l` (count of files importing from this module). (3 = >10 importers, 2 = 5–10, 1 = 2–4, 0 = 0–1)

## 2. Type Safety Debt

### 2.1 TypeScript: 254 `as any` Casts

Top 10 files by `as any` count (verified):

| File | Count | Domain |
|---|---|---|
| `tools/research/deepResearch.ts` | 38 | Research |
| `vnext/zotero/tools.ts` | 29 | Zotero |
| `tools/research/latex/astStringify.ts` | 23 | LaTeX AST |
| `vnext/writing/sectionWritePacket.ts` | 20 | Writing |
| `vnext/writing/evidenceSelection.ts` | 18 | Writing |
| `vnext/writing/integrate.ts` | 16 | Writing |
| `vnext/writing/submitSection.ts` | 15 | Writing |
| `tools/writing/claimsTable/extractor.ts` | 7 | Writing |
| `tools/writing/outline/generator.ts` | 7 | Writing |
| `vnext/writing/evidenceIndex.ts` | 6 | Writing |

**Root causes**: (1) LaTeX AST library (`@unified-latex/*`) exports loosely typed nodes — 25 casts in `latex/` alone. (2) Writing pipeline passes untyped LLM response objects — 113 casts across `vnext/writing/`. (3) Deep research uses dynamic tool dispatch — 38 casts.

**Recommendation**: NEW-R02 — **Framing: boundary typing first, not blanket `as any` elimination.** Prioritize `unknown` + Zod parse at LLM/tool response boundaries (where untyped data enters the system) and typed narrowing helpers for `@unified-latex` nodes. Do not invest in upstream AST library type patches — instead, create thin typed wrappers at the points where our code consumes AST nodes. Specifics: (a) CODE-01.4 specifies a grep-based CI gate for `as any` (diff-scoped: new/modified files only; untouched legacy files are not checked) — the grep commands are defined in `ECOSYSTEM_DEV_CONTRACT.md` but **not yet wired into CI** at the pinned commits (same status as all CODE-01 CI gates per §1); implementing this gate is a prerequisite for diff-scoped enforcement; **immediate step**: implement the missing CODE-01 CI gate scripts in `autoresearch-meta/scripts/` (`check_loc.py`, `check_entry_files.py` — specified in the contract but not present at pinned commits), then strengthen the grep heuristics to catch `as\s+any` (extra whitespace) and `.catch\(\s*\(\)\s*=>\s*\{\s*\}\)` (promise-style silent swallows); **Phase-3 hardening**: add a targeted ESLint custom rule for comprehensive AST-based detection of `as any` variants and empty handler patterns — narrower than `@typescript-eslint/no-explicit-any` (which would ban all `any` usage including function parameters and return types, expanding CODE-01.4 scope); **diff-scoped enforcement**: standard ESLint cannot enforce rules on "touched files only" — use `eslint-plugin-diff` or configure the rule as `warn` globally + `error` in CI via `--rule` override applied only to `git diff`-listed files; (b) create typed narrowing helpers for `latex/` node consumption (~25 casts — focus on wrapper functions, not upstream type fixes); (c) type the writing pipeline LLM response shapes with `unknown` + Zod parse boundaries (~113 casts — highest-value boundary typing); (d) track burn-down by directory. **Acceptance criteria**: no new `as any` in touched files (enforced by CODE-01.4 diff-scoped CI gate once implemented + grep heuristic hardening); legacy burn-down tracked per-directory in Phase 2 (H-16b) with per-directory burn-down in `TYPE_SAFETY_BURNDOWN.md` updated with each PR. **Adjacent escape hatches to track**: the `as any` grep heuristic should also cover `as unknown as` (**23** occurrences — double-cast to bypass type checking, functionally equivalent to `as any`), explicit `: any` parameter/return type annotations (**101** occurrences — grep heuristic: `:\s*any\b`; will include false positives from comments/strings, but provides order-of-magnitude), `// eslint-disable` directives (**7** occurrences), and `// @ts-ignore` / `// @ts-expect-error` directives (**0** occurrences). These are the next most common failure modes after `as any` (254) and should be added to the grep heuristic or Phase-3 ESLint rule to prevent whack-a-mole escape from the `as any` gate.

### 2.2 Python: 2 `type: ignore` + 281 broad exception handlers (163 `except Exception:` + 118 `except Exception as e:`)

Scope: `hep-autoresearch/src/hep_autoresearch/` only.

- `type: ignore`: 2 occurrences (minimal debt)
- **`except Exception:`** (no capture): **163** occurrences, classified by behavior:
  - **Silent swallows** (`except Exception: pass`): **35** blocks — CODE-01.5 violations (highest risk: error silently discarded)
  - **Semi-silent: continue** (`except Exception: continue`): **17** blocks — error discarded, loop continues
  - **Semi-silent: bare return** (`except Exception: return ...`): **46** blocks — error discarded, function exits early
  - **Remaining**: 65 handlers with explicit logging or re-raise (audit for overly broad type)
- **`except Exception as e:`** (captures variable): **118** occurrences, classified by behavior:
  - **Silent swallows** (`except Exception as e: pass`): **0** blocks
  - **Semi-silent: continue** (`except Exception as e: continue`): **0** blocks
  - **Semi-silent: return** (`except Exception as e: return ...`): **45** blocks — captures `e` but may discard it (audit: does the return value surface the error to the caller, or does it return a default/fallback that hides the failure?)
  - **Remaining**: 73 handlers with explicit logging or re-raise using `e` (lower risk — the variable capture suggests intentional error handling; still audit for overly broad exception types)
- Silent swallow concentration (uncaptured): `adapters/shell.py` (7), `mcp_stdio_client.py` (4), `w_compute.py` (4), `orchestrator_state.py` (3), `ecosystem_bundle.py` (3), `orchestrator_regression.py` (3), `w3_paper_reviser_evidence.py` (3)

**Total scope**: 281 broad exception handlers. **P0 remediation scope**: the 35 uncaptured silent swallows (`except Exception: pass`) are the highest-risk CODE-01.5 violations and must be fixed first. **Phase (a) expanded scope**: 35 silent swallows + 63 semi-silent (`continue`/`return` without capture) + 45 captured-but-returning (`except Exception as e: return`) = **143 handlers** requiring audit. Of these, the 45 `as e: return` blocks require per-site triage to determine whether the error is surfaced to the caller or discarded.

**Recommendation**: NEW-R03 — Triage the 35 silent `except Exception: pass` blocks first (CODE-01.5 violations, P0; see Appendix B for site list). Then audit the 108 semi-silent/captured-return handlers. Replace with specific exception types + structured logging. The remaining 138 handlers (65 uncaptured + 73 captured with logging/re-raise) need audit for overly broad exception types but are lower risk. **Triage rubric for 108 semi-silent handlers** (63 `continue`/`return` without capture + 45 `as e: return`): each site must be classified as **surface** (convert to `raise`/`raise ... from e` or return an `Err` result type — the caller must know about the failure) or **suppress** (keep as a fallback return — the failure is expected/recoverable and the default return value is the correct behavior). Decision criteria: (1) is the caller expecting an error signal? (2) does the suppressed error hide a data-integrity or correctness issue? (3) does a test exist that covers the error path? Sites classified as **suppress** must add a comment explaining why suppression is correct; sites with no covering test must add one before remediation to prevent silent control-flow changes. Two-phase approach: (a) silent/semi-silent remediation + exception narrowing can proceed immediately (no dependency); (b) migration to `AutoresearchError` subtypes requires H-01 (AutoresearchError envelope) factories/envelopes.

### 2.3 TypeScript: Promise-Style Silent Swallows (CODE-01.5 violations)

- `deepResearch.ts:819` — `(maybe as Promise<void>).catch(() => {})`
- `dispatcher.ts:34` — `.catch(() => {})`

These `.catch(() => {})` patterns are **CODE-01.5 silent swallows** (TS equivalent of Python's `except Exception: pass`). The contract's CODE-01.5 grep heuristic already covers synchronous `catch (...) {}` blocks (empty `catch` bodies in `try/catch`); the gap is **promise-style** `.catch(() => {})` which the current grep pattern does not detect. The Phase-3 AST-based lint upgrade (ESLint custom rule) must include a detector for both `.catch(() => {})` and `.catch((_e) => {})` patterns. In the interim, a grep heuristic for `\.catch\(\s*\(\)\s*=>\s*\{\s*\}\)` can be added to the diff-scoped CI gate to catch the most common form.

**Recommendation**: Include in NEW-R02 audit. Immediate: add `.catch(() => {})` grep pattern to the diff-scoped CI gate alongside existing CODE-01.5 patterns. Phase-3: add AST-based ESLint rule for comprehensive detection of all empty-handler patterns (synchronous and promise-style).

## 3. Code Duplication

### 3.1 Zotero Tools: Two Parallel Implementations (~4849 LOC)

| File | LOC | Package |
|---|---|---|
| `packages/zotero-mcp/src/zotero/tools.ts` | 2510 | zotero-mcp (standalone) |
| `packages/hep-research-mcp/src/vnext/zotero/tools.ts` | 2339 | hep-research-mcp (aggregated) |

Both implement `zoteroListCollections`, `zoteroListItems`, `zoteroGetItem`, `zoteroGetItemAttachments`, `zoteroDownloadAttachment`, `zoteroGetAttachmentFulltext` with divergent signatures and helper functions.

**Recommendation**: NEW-R04 — Staged consolidation: (1) extract shared Zotero core functions (`listCollections`, `listItems`, `getItem`, `downloadAttachment`) into `packages/zotero-mcp/src/zotero/core.ts` — the shared core lives in the `zotero-mcp` package (PLUG-01 boundary: `zotero-mcp` is the canonical Zotero provider); (2) rewrite `hep-research-mcp/src/vnext/zotero/tools.ts` as a thin adapter importing from `zotero-mcp/core` — **dependency direction**: `hep-research-mcp` depends on `zotero-mcp`, never the reverse (no circular deps); (3) add contract tests verifying both adapters produce identical results for the same inputs — tests run against **deterministic HTTP fixtures** (recorded Zotero API responses via `nock`-based recording + replay, not a live Zotero instance) to ensure CI feasibility. **Fixture strategy**: fixtures stored in `packages/zotero-mcp/tests/fixtures/zotero/` (under `tests/`, not `src/`, to prevent fixture payloads from being included in published packages); **packaging verification**: confirm `packages/zotero-mcp/package.json` `files` field or `.npmignore` excludes `tests/` — if neither is configured, the fixture directory will ship in the npm package; recorded from a dedicated test library (**acceptance gate**: no PHI/PII — use synthetic items with fake metadata only; fixture review required before merge); fixture update workflow: `RECORD=1 pnpm test` re-records fixtures, committed alongside test changes; fixtures are JSON files covering each Zotero API endpoint (collections, items, attachments, fulltext) with representative payloads. **Fixture safety gates** (mandatory before merge): (a) **Packaging exclusion**: `packages/zotero-mcp/package.json` must include `"files": ["dist"]` or equivalent — if the `files` field is absent and no `.npmignore` exists, `npm pack` will include `tests/fixtures/` in the published package; CI must run `npm pack --dry-run | grep fixtures` and fail if any fixture files appear; (b) **PII/real-data checklist**: each fixture PR must include a reviewer-signed checklist confirming: no real library names/user IDs, no real attachment content, no real collection hierarchies that could identify a researcher; synthetic items only. Eliminates ~2300 LOC of duplication.

### 3.2 Evidence Files: 8 Files, ~9777 LOC

| File | LOC | Purpose |
|---|---|---|
| `corpora/style/evidence.ts` | 2021 | Style corpus evidence |
| `vnext/writing/evidenceSelection.ts` | 1892 | Writing evidence selection |
| `vnext/writing/evidenceIndex.ts` | 1767 | Writing evidence indexing |
| `vnext/evidence.ts` | 1188 | General evidence |
| `vnext/pdf/evidence.ts` | 946 | PDF evidence |
| `vnext/writing/evidence.ts` | 931 | Writing evidence |
| `tools/research/evidenceGrading.ts` | 757 | Evidence grading |
| `vnext/evidenceSemantic.ts` | 275 | Semantic evidence |

Multiple files share similar patterns for evidence building, grading, and selection with no shared abstraction.

**Recommendation**: NEW-R05 — Incremental approach: (0) **prerequisite**: inventory existing evidence artifact shapes across all 8 files to identify field overlap and divergence before designing the unified schema; (1) define a unified `EvidenceItem` **cross-component schema** in `autoresearch-meta/schemas/evidence_item_v1.schema.json` — the JSON Schema definitions in `autoresearch-meta` are the **Single Source of Truth (SSOT)**; the build pipeline (`make codegen-check` from NEW-01) must fail if the generated Pydantic v2 models (Python) or Zod schemas (TS) drift from the JSON Schema, ensuring strict wire compatibility between the Python orchestrator and TS MCP tools; codegen'd to TS interfaces + Zod schemas and **Pydantic v2 models** for Python; the Python codegen target is Pydantic v2 (not vanilla dataclasses) because Pydantic provides runtime validation parity with Zod at the boundary — this **proposes amending NEW-01's codegen contract** from `datamodel-code-generator` → dataclasses to `datamodel-code-generator --output-model-type pydantic_v2.BaseModel` → Pydantic v2 models (same tool, different output flag; `datamodel-code-generator` supports this natively); the amendment adds `pydantic>=2.0` as a dependency to `hep-autoresearch` and changes the generated import surface from `dataclasses.dataclass` to `pydantic.BaseModel`; the schema uses a discriminated union covering all evidence types (PDF, writing, semantic, style, grading); `EvidenceItem` must **compose** `ArtifactRefV1` (digest, origin, content_hash fields) rather than duplicating those fields inline — this prevents field drift between evidence and artifact schemas; (2) extract **internal TS-only** shared evidence primitives (grading interface, builder pattern) into `packages/shared/src/evidence/` — these are implementation helpers, not SSOT schemas; **overlap boundary with H-18**: the `ArtifactRefV1` schema (digest, origin, content_hash) is defined by H-18 — NEW-R05 must **compose** `ArtifactRefV1` (via `$ref` in JSON Schema), not redefine those fields; the SSOT for artifact metadata lives in H-18, the SSOT for evidence-specific fields (evidence_type discriminator, grading scores, source_context) lives in NEW-R05; no field may appear in both schemas; (3) each domain-specific evidence module imports codegen'd types from shared and extends with internal logic. Require artifact-format compatibility tests: existing evidence artifacts must round-trip through the new schema without data loss. The `EvidenceItem` schema must include a `schema_version` field (string, e.g., `"1.0"`) to support future migrations; a migration script (or dual-read capability) for the `idea-runs` repository must ensure historical research data remains readable after the schema transition. Stage around NEW-06 (writing tool consolidation): abstract only the stable evidence surface now; defer writing-pipeline-specific evidence types until after NEW-06 consolidation to avoid churn. Without the unifying schema, extraction merely relocates duplication.

**Python codegen target decision matrix** (justification for NEW-01 amendment):

| Option | Runtime validation | Dependency cost | TS migration impact | Recommendation |
|---|---|---|---|---|
| **Vanilla dataclasses** (current NEW-01) | None built-in — use `jsonschema.validate()` at entry-point boundaries | Zero (stdlib) | Low — disposable during migration | **Default stance**: no new dependency; sufficient if evidence schema boundaries are limited to a few entry points where manual `jsonschema.validate()` is manageable |
| **Pydantic v2** (optional amendment) | Built-in — `model_validate()` at every boundary, type coercion, discriminated unions | `pydantic>=2.0` (depends on `pydantic-core`, a Rust-compiled extension — requires pre-built wheel or Rust toolchain for CI; pre-built wheels available for all major platforms) | Low — generated models are disposable during TS migration; Pydantic is a **new direct dependency** (not currently in hep-autoresearch or idea-core dependency trees at pinned commits) | **Optional**: pursue only if concrete discriminated-union validation need is demonstrated AND Python orchestrator retirement is >6 months away |
| **TS-only runtime validation** (defer Python) | N/A — Python side uses untyped dicts | Zero | Zero — no Python codegen needed | Viable only if Python orchestrator is migrated to TS before evidence schema lands; currently not on Phase 1–2 critical path |

**Go/no-go criterion for Pydantic v2**: this amendment is **optional, time-boxed, and a separable sub-item** (NEW-R05a) — it must NOT block or delay NEW-05a (TS migration). Proceed only if: (a) the evidence schema requires discriminated unions, nested model validation, or type coercion at Python boundaries (all of which require manual code with dataclasses), AND (b) the Python orchestrator remains an active consumer of evidence schemas past the NEW-05a Phase 1 kickoff date. If NEW-05a begins and the Python orchestrator's retirement timeline is ≤6 months, prefer minimal boundary validation (`jsonschema.validate()` at entry points) over adding a Pydantic dependency. **Default stance**: use vanilla dataclasses + `jsonschema.validate()` at entry-point boundaries unless/until discriminated-union validation pain is concretely demonstrated. **Sunset plan**: Pydantic v2 models are codegen'd and disposable — when the Python orchestrator is retired (post-NEW-05a Phase 5), the Pydantic models are deleted along with the Python codebase; no long-term maintenance burden.

### 3.3 SHA-256 Functions: 3 Implementations

- `hep-autoresearch/toolkit/run_card.py:32` — `sha256_json()`
- `hep-autoresearch/toolkit/adapters/artifacts.py:16,24` — `sha256_file()`, `sha256_json()`
- `idea-core/engine/utils.py:14` — `sha256_hex()`

**Recommendation**: Already covered by monorepo migration (NEW-05) + shared abstractions (Phase 1). No new item needed, but flag for TS migration.

### 3.4 Versioned Type Files (Schema Drift)

```
packages/shared/src/types/analysis-params.ts
packages/shared/src/types/analysis-params2.ts
packages/shared/src/types/analysis-params3.ts
packages/shared/src/types/analysis-results.ts
packages/shared/src/types/analysis-results2.ts
packages/shared/src/types/analysis-results3.ts
packages/shared/src/types/analysis-results4.ts
```

7 versioned type files suggest schema evolution without cleanup. Each ~63 lines.

**Recommendation**: NEW-R06 — Consolidate analysis types into single versioned schema in `autoresearch-meta/schemas/analysis_params_v2.schema.json` and `autoresearch-meta/schemas/analysis_results_v2.schema.json` (SSOT, codegen'd). Use discriminated union or explicit `version` field for backwards compatibility. Delete stale `analysis-params{2,3}.ts` and `analysis-results{2,3,4}.ts` files after codegen replacement is verified. The current versioned files in `packages/shared/src/types/` are internal TS-only types that predate the SSOT convention — this is a migration to the canonical pattern, not new schema work.

## 4. Test Presence Gaps (File-Count Density, Not Instrumented Coverage)

Note: These are file-count ratios (test files / source files), not instrumented code coverage. Actual branch/line coverage requires tooling setup.

| Component | Source Files | Test Files | Density |
|---|---|---|---|
| hep-autoresearch | 46 | 16 | 35% |
| hep-research-mcp | 269 | 102 | 38% |
| idea-core | 25 | 22 | 88% (good; includes `conftest.py`) |

### 4.1 hep-autoresearch: 30 Untested Source Files

Critical untested modules:
- `toolkit/ecosystem_bundle.py` (824 LOC)
- `toolkit/w_compute.py` (795 LOC)
- `toolkit/w3_paper_reviser_evidence.py` (788 LOC)
- `toolkit/adapters/shell.py` (737 LOC)
- `toolkit/orchestrator_state.py` (699 LOC)
- `toolkit/evolution_proposal.py` (516 LOC)

**Recommendation**: NEW-R07 — Test coverage gate: new code in hep-autoresearch must have corresponding test file. **Test file mapping rule**: for a source file `src/<package>/<module>.py`, the corresponding test file is `tests/test_<module>.py` or `tests/<package>/test_<module>.py`; for TS, `src/<path>/<module>.ts` maps to `src/<path>/__tests__/<module>.test.ts` or `tests/<path>/<module>.test.ts`. Integration tests covering multiple modules satisfy the gate for all covered modules. **Exceptions**: type-only modules (`types.py`, `*_types.py`), re-export barrels (`__init__.py` with only imports), and pure schema files (`generated/`) are exempt — these have no testable logic. **Enforcement is diff-scoped only** (new/touched files in the PR diff; legacy untouched files are not gated). **Preferred ratchet**: once instrumented coverage is set up (`pytest-cov` for Python, `vitest --coverage` for TS), the CI gate should ratchet on meaningful coverage (coverage delta must not decrease for touched files) rather than strict test-file presence — this avoids incentivizing low-signal placeholder tests. Until instrumented coverage is available, the test-file mapping rule serves as a minimum gate. Existing gaps addressed during TS migration (NEW-05a).

### 4.2 hep-research-mcp: Low Test Density in Key Subdirectories

With 269 source files and 102 test files, the 38% density does not imply "167 untested files" — test files may cover multiple source files, and some source files (types, re-exports) need no dedicated test. The meaningful gap is in specific subdirectories (counts via `find src/<subdir> -name '*.ts' | wc -l` and `find tests/<subdir> -name '*.test.ts' | wc -l`):
- `corpora/style/` — 12 source files, 0 test files
- `vnext/writing/` — 37 source files, 9 test files (24%)
- `tools/research/latex/` — 18 source files, 6 test files (33%)

**Recommendation**: Address during test infrastructure buildout (no separate item needed; covered by existing CI/test plans). Prioritize `corpora/style/` and `latex/` as zero-test zones.

## 5. Skills Ecosystem Issues

### 5.1 Skills >1000 LOC

| Skill Script | LOC |
|---|---|
| `paper-reviser/scripts/bin/paper_reviser_edit.py` | 2122 |
| `research-team/scripts/bin/literature_fetch.py` | 1775 |
| `auto-relay/scripts/relay.py` | 1448 |
| `research-writer/scripts/bin/research_writer_learn_discussion_logic.py` | 1208 |
| `research-team/scripts/bin/build_team_packet.py` | 1130 |
| `research-team/scripts/gates/check_reproducibility_capsule.py` | 1030 |

Skills are supposed to be lightweight scripts. 6 scripts exceed 1000 LOC.

**Recommendation**: NEW-R08 — Skills LOC budget: **end-state** ≤200 eLOC per entry-point script (CODE-01.1 compliant). **Intermediate step**: initial extraction may produce ≤500 eLOC scripts under `# CONTRACT-EXEMPT: CODE-01 decomposition-in-progress (CODE-01.1)` with tracked sunset dates. **Enforcement is diff-scoped and per-entrypoint** (new/touched skill scripts in the PR diff; legacy untouched scripts are not gated). The ratchet rule is per-entrypoint: each existing entry-point script's eLOC is baselined at gate introduction; CI fails if any individual script's eLOC increases beyond its baseline (new scripts start at 200 eLOC budget). This allows adding new skills without triggering ratchet violations. Extract shared logic into `skills/<name>/lib/` modules (Python `import` from relative path; no skill loader changes needed). Enforce via the same CODE-01 CI lint that covers all `.py` files. Note: EVO-12 is skills *lifecycle* automation (usage tracking, health scoring, retirement) — not CI governance. NEW-R08 is a standalone CODE-01 enforcement item.

### 5.2 skills-market / skills-publish-tree: Separate Git Repos

Both are separate git repos with minimal content:
- `skills-market/`: 2 scripts + package manifests
- `skills-publish-tree/`: Static skill tree snapshot

These should be absorbed into the monorepo (NEW-05).

**Recommendation**: Include in NEW-05 monorepo migration scope. No new item needed.

## 6. Architectural Issues

### 6.1 `orchestrator_cli.py` Is the Entire Orchestrator

At 6041 LOC, this single file contains:
- CLI argument parsing
- MCP client management
- Workflow orchestration (w1/w2/w3)
- State management
- Approval gate logic
- Report generation
- Error handling

This is a high-value maintainability target. Note: NEW-05a's incremental strategy allows the TS orchestrator to be built from scratch without requiring Python decomposition first. However, decomposition aids comprehension of the existing logic during TS design. **Decision gate**: evaluate after NEW-05a Phase 1 kickoff whether decomposition provides sufficient ROI vs direct TS rewrite. **Deprecation trigger**: if NEW-05a proceeds as a "rewrite from scratch" (no incremental port of Python modules), NEW-R09 is automatically downgraded to P3 or cancelled — do not invest in decomposing code that will be entirely replaced, unless specific logic extraction is required to inform the TS implementation. **Evidence triggers for decomposition** (any one is sufficient): (1) TS migration blocked by inability to localize behavior boundaries in the monolithic file; (2) insufficient test coverage to validate behavioral equivalence during rewrite; (3) active development on the Python file during TS migration creates merge conflicts.

**Recommendation**: NEW-R09 — Decompose `orchestrator_cli.py` along domain boundaries. **End-state**: all output modules ≤200 eLOC (CODE-01.1 compliant). **Intermediate step**: initial decomposition may produce modules up to ≤500 eLOC under `# CONTRACT-EXEMPT: CODE-01 decomposition-in-progress (CODE-01.1)`; each must have a tracked issue with sunset date to reach ≤200. Target ~12–15 modules total:
- `cli/parser.py` — argument parsing (~200 LOC)
- `cli/commands/run.py` — run command (~300 LOC)
- `cli/commands/status.py` — status/inspect commands (~200 LOC)
- `cli/commands/approve.py` — approval commands (~150 LOC)
- `orchestrator/engine.py` — workflow orchestration core (~500 LOC)
- `orchestrator/workflows/w1_ingest.py` — w1 workflow logic (~400 LOC)
- `orchestrator/workflows/w2_compute.py` — w2 workflow logic (~400 LOC)
- `orchestrator/workflows/w3_write.py` — w3 workflow logic (~400 LOC)
- `orchestrator/state.py` — state management (~500 LOC, merge with existing `orchestrator_state.py`)
- `orchestrator/gates.py` — approval gate logic (~300 LOC)
- `orchestrator/mcp_client.py` — MCP client (~400 LOC, merge with existing `mcp_stdio_client.py`)
- `orchestrator/reports.py` — report generation (~300 LOC)
- `orchestrator/errors.py` — error handling (~200 LOC)

Total: ~4350 LOC across 13 modules. Remaining ~1700 LOC expected to be dead code, inline comments, or absorbed into existing modules (`orchestrator_state.py`, `mcp_stdio_client.py`). **Note**: Decomposition changes the module path of the CLI entry point; `pyproject.toml` `[project.scripts]` / `console_scripts` must be updated to point to the new `cli.parser:main` (or equivalent) to ensure the `hepar` command remains executable. **Acceptance criterion**: each split PR must provide at least one behavioral equivalence signal — either (a) existing test suite passes before and after the split, or (b) a regression harness run (`orchestrator_regression.py`) demonstrates identical output for a fixed input set. PRs without equivalence evidence must not be merged.

### 6.2 `service.py` Is the Entire Idea Engine

At 3165 LOC, `idea-core/src/idea_core/engine/service.py` contains the entire idea evaluation engine. Decomposition aids comprehension but is not a hard prerequisite for Phase 3 TS rewrite (which can be built from scratch). **Decision gate**: evaluate whether Python decomposition provides sufficient ROI vs direct TS rewrite after Phase 3 kickoff. Same evidence triggers as NEW-R09: (1) inability to localize behavior; (2) insufficient test coverage; (3) active concurrent development creating merge conflicts.

**Recommendation**: NEW-R10 — Decompose `service.py` along domain boundaries. **End-state**: all output modules ≤200 eLOC (CODE-01.1 compliant). **Intermediate step**: initial decomposition may produce modules up to ≤500 eLOC under `# CONTRACT-EXEMPT: CODE-01 decomposition-in-progress (CODE-01.1)`; each must have a tracked issue with sunset date. Note: `service.py` is a banned filename under CODE-01.2 ("禁止万能文件名"); the residual thin orchestration layer must be renamed (e.g., `engine/coordinator.py`). Target ~8 modules:
- `engine/graph.py` — idea graph operations (~500 LOC)
- `engine/ranking.py` — ranking and scoring (~400 LOC)
- `engine/search.py` — search step operations (~400 LOC)
- `engine/formalism.py` — formalism registry operations (~350 LOC)
- `engine/evaluation.py` — idea evaluation pipeline (~400 LOC)
- `engine/persistence.py` — storage and serialization (~350 LOC)
- `engine/types.py` — domain types and interfaces (~200 LOC)
- `engine/coordinator.py` — thin orchestration layer (~300 LOC, renamed from `service.py` per CODE-01.2)

Total: ~2900 LOC across 8 modules. Remaining ~265 LOC expected to be absorbed into existing utility modules or eliminated as dead code. **Acceptance criterion**: each split PR must provide behavioral equivalence evidence — `idea-core` has 88% test file density (22 test files for 25 source files), so the existing `pytest` suite must pass before and after each decomposition PR. PRs without green test runs must not be merged.

### 6.3 `registry.ts` (2975 LOC) — Tool Registration Monolith

All 71-83 MCP tools are registered in a single file with inline Zod schemas and handler references.

**Recommendation**: NEW-R11 — Split tool registry into domain-specific registration files:
- `tools/registry/inspire.ts`
- `tools/registry/zotero.ts`
- `tools/registry/pdg.ts`
- `tools/registry/writing.ts`
- `tools/registry/project.ts`
- `tools/registry/index.ts` — aggregation only

Already partially covered by H-16a (tool consolidation), but the file splitting is not explicitly planned.

## 7. Cross-Cutting Concerns

### 7.1 No Shared Error Types Across TS Packages

`packages/shared/src/errors.ts` is only 63 LOC with basic `invalidParams()` / `notFound()` helpers. No structured error hierarchy.

**Status**: Covered by ERR-01 (AutoresearchError). No new item needed.

### 7.2 idea-runs: Separate Git Repo for Run Data

`idea-runs/` is a separate git repo containing research run artifacts, schemas, and evidence. This is research data, not code — it should remain separate from the monorepo but needs clear integration contract.

**Recommendation**: NEW-R12 — Define `idea-runs` integration contract: schema validation, artifact naming compliance, cross-reference format. This is a **Phase-3 prerequisite deliverable** for EVO-05 (Domain Pack, Phase 5 in the REDESIGN_PLAN tracker): the integration contract must be defined and validated before EVO-05 can consume `idea-runs` artifacts. Tracked under Analysis Phase 3; included in EVO-05's dependency list but not deferred to Phase 5.

## 8. Summary of New Recommendations

> **Classification**: Items below are either **standalone new items** (not covered by any existing plan item) or **plan amendments** (scope expansions / design constraints for existing items, explicitly marked). Plan amendments should be integrated into existing tracker entries rather than creating new ones. See §9 for the full overlap mapping.

| ID | Title | Priority | Blocked By | Estimated Scope |
|---|---|---|---|---|
| **NEW-R01** | God-file splitting (umbrella) | — (tracking) | — | 9 files >2000 raw LOC + 7 in 1200–2000 band (R09/R10/R11 are sub-items); end-state ≤200 eLOC. This is a tracking umbrella, not a concrete work item — actual work is done through sub-items. R09/R10 are **conditional** (decision-gated, not hard prerequisites for TS migration). |
| **NEW-R02** | TS `as any` elimination (254 instances) | P1 | NEW-R02a | **Two-workstream item**: (a) **CI gate wiring** (P1, Phase 0–1): implement diff-scoped grep heuristic for `as any` + `.catch(() => {})` in CI — prevents new debt; (b) **legacy burn-down** (P2, Phase 2/H-16b): systematic per-directory reduction of existing 254 casts tracked in `TYPE_SAFETY_BURNDOWN.md`. These are independent workstreams; (a) is higher priority. |
| **NEW-R02a** | CODE-01 CI gate scripts implementation | **P0** | — | **Standalone P0 deliverable**: implement the missing CI gate scripts specified in `ECOSYSTEM_DEV_CONTRACT.md` but not present at pinned commits: `autoresearch-meta/scripts/check_loc.py` (CODE-01.1 LOC check), `autoresearch-meta/scripts/check_entry_files.py` (CODE-01.2 filename check), and hardened grep patterns for CODE-01.4 (`as any`) and CODE-01.5 (silent swallows, including `.catch(() => {})`). Without these scripts, NEW-R01 (god-file splitting), NEW-R02 (as any prevention), and NEW-R03 (swallow prevention) are not enforceable via CI. This is an infrastructure prerequisite, not a refactoring item. **CI wiring plan**: entry command `make code-health-check` (or `pnpm run code-health-check` in monorepo) in `.github/workflows/ci.yml` as a required check on all PRs; scripts run diff-scoped (files changed in the PR only, via `git diff --name-only origin/main...HEAD`); exit code 0 = pass, non-zero = fail with per-file violation report on stdout. **Golden tests**: `autoresearch-meta/tests/code-health/` containing (a) fixture files that deliberately violate each CODE-01 subrule (>200 eLOC, banned filename, `as any`, silent swallow), (b) fixture files that pass, (c) test runner that invokes `check_loc.py`/`check_entry_files.py` on fixtures and asserts expected pass/fail — ensures "fail-closed" gates do not regress silently. |
| **NEW-R03** | Python bare exception remediation | **P0 (phase a)** / P1 (phase b) | H-01 (phase b only) | **Plan amendment to H-01**: 281 total broad handlers (163 `except Exception:` + 118 `except Exception as e:`); **phase (a)** P0: 35 silent swallows (CODE-01.5 fail-closed risk) + 108 semi-silent/captured-return handlers requiring audit; phase (b) P1: `AutoresearchError` subtype migration pending H-01. |
| **NEW-R04** | Zotero tools consolidation | P1 | — | ~2300 LOC dedup |
| **NEW-R05** | Evidence abstraction layer | P2 | NEW-01 (codegen; **proposes amending** NEW-01 Python target from dataclasses to Pydantic v2 — same `datamodel-code-generator` tool, `--output-model-type pydantic_v2.BaseModel` flag), H-18 (ArtifactRef V1) | 8 files; SSOT schema in `autoresearch-meta/schemas/` (requires codegen pipeline + ArtifactRefV1 composition) |
| **NEW-R06** | Analysis type schema consolidation | P2 | NEW-01 (codegen) | 7 versioned files → SSOT schema (requires codegen pipeline) |
| **NEW-R07** | hep-autoresearch test presence gate | P2 | — | CI rule |
| **NEW-R08** | Skills LOC budget | P2 | — | 6 scripts; end-state ≤200 eLOC (CONTRACT-EXEMPT intermediate ≤500) |
| **NEW-R09** | `orchestrator_cli.py` decomposition | P1 (conditional) | — | 6041 → ~13 modules; end-state ≤200 eLOC; decision gate at Phase 1 kickoff (sub-item of R01). **Deprecation trigger**: auto-downgrade to P3 or cancel if NEW-05a proceeds as rewrite-from-scratch (no incremental Python port). |
| **NEW-R10** | `service.py` decomposition | P1 (conditional) | — | 3165 → ~8 modules; end-state ≤200 eLOC; decision gate at Phase 3 kickoff (sub-item of R01) |
| **NEW-R11** | `registry.ts` domain splitting | P3 | — | **Plan amendment to M-13**: 2975 → 6 files (scope expansion; sub-item of R01). P3 aligns with M-13's Phase 3 placement. |
| **NEW-R12** | `idea-runs` integration contract | P3 | — | Schema + naming. Phase-3 prerequisite deliverable for EVO-05 (not deferred to Phase 5). |
| **NEW-R13** | Package rename `hep-research-mcp` → `hep-mcp` | P3 (default) | H-16a, M-02, H-21 | ~206 refs + alias layer. **Default P3**: only pursue if H-16a demonstrably fails to resolve tool-name ergonomics. **Concrete decision gate**: after H-16a implementation, run `grep -oP 'name:\s*"\K[^"]+' src/tools/registry.ts | awk '{print length, $0}' | sort -rn | head -20` to list the 20 longest tool names. **Measurable criterion**: escalate to P1 only if >5 tool names still exceed 40 chars after H-16a shortening AND user confusion is demonstrated via telemetry/feedback. Evaluate rename ROI on three factors: (1) redundancy/UX — do FQ names like `mcp__hep-research__hep_*` contain double-prefix redundancy that causes user confusion? (2) config migration cost — how many client configs, prompts, and skill references must change? (3) alias-hit telemetry — if M-02 deprecated alias mapping is active, what is the alias-hit rate? If kept as an option, must explicitly map interactions with H-16a/H-17/M-02 (catalog hash, aliases, compatibility matrix) to avoid double-migration. |
| **NEW-R14** | `hep-mcp` internal package splitting | **P2 (late) / P3** | NEW-05 | 98K → 3 packages + core. **Demoted from P2 to late P2/P3**: package splitting during active NEW-06/H-16a work creates unnecessary churn (import path changes conflict with tool consolidation PRs). Execute after H-16a and NEW-06 stabilize. **Dependency direction constraint**: `@autoresearch/writing` depends on `@autoresearch/corpora`; `@autoresearch/corpora` remains a pure data/config package with no upstream dependencies (no imports from `writing` or `orchestrator`). Validate with `madge --circular` or equivalent to prevent circularity during the split. |
| **NEW-R15** | Orchestrator as MCP tools (design input for NEW-05a) | P0 (constraint) / **P2 (impl)** | Design constraint: — / Implementation: H-03, H-02, H-01, H-05, H-07, H-11a, H-16a, H-20, H-21, NEW-02 | **Plan amendment to NEW-05a/EVO-13**: Phase-0 deliverable is the architecture spec (tool surface, boundary rules, threat model) — a design document, no code, no blocking dependencies. **Phase-2 deliverable** is the implementation of orchestrator MCP tools, blocked by H-03/H-02/H-01/H-05/H-07/H-11a/H-16a/H-20/H-21/NEW-02 (approval packet persistence). **Rationale for Phase 2**: H-21 (HEP_DATA_DIR storage unification) is Phase 2 in the tracker; implementing the run-store CRUD tools before storage paths are unified risks inconsistent state between CLI and MCP server. |

### Phase Mapping (Analysis Phases, aligned with but not identical to REDESIGN_PLAN phases)

- **Analysis Phase 0** (tracking + design constraints + critical safety + CI infrastructure): NEW-R01 (umbrella — no concrete Phase-0 deliverable; sub-items execute in Phase 1–3), NEW-R02a (CODE-01 CI gate scripts — infrastructure prerequisite for NEW-R01/R02/R03 enforcement), NEW-R03 phase (a) (silent/semi-silent exception remediation — CODE-01.5 fail-closed risk), NEW-R15 design constraint (architecture spec only — tool surface, boundary rules, threat model; no code, no blocking dependencies)
- **Analysis Phase 1** (type safety + dedup): NEW-R02, NEW-R03 phase (b), NEW-R04, NEW-R09 (conditional — decision gate)
- **Analysis Phase 2** (abstractions + quality gates + packages + orchestrator impl): NEW-R05, NEW-R06, NEW-R07, NEW-R08, NEW-R10 (conditional — decision gate), NEW-R15 implementation (orchestrator MCP tools; blocked by H-03/H-02/H-01/H-05/H-07/H-11a/H-16a/H-20/H-21/NEW-02 — H-21 is Phase 2, so implementation cannot begin before Phase 2)
- **Analysis Phase 2–3** (packages + integration contracts + conditional rename): NEW-R14 (late P2/P3 — after H-16a/NEW-06 stabilize), NEW-R11 (M-13 scope), NEW-R12, NEW-R13 (complementary to H-16a; evaluate only after H-16a; demote to P3 if FQ names already within limits)

**Analysis Phase → REDESIGN_PLAN Phase cross-reference** (to prevent scheduling forks):

| Analysis Phase | REDESIGN_PLAN Phase | Items | Rationale |
|---|---|---|---|
| 0 | Phase 0 (止血) | NEW-R02a, NEW-R03(a), NEW-R15 spec | CI infra + fail-closed safety + design constraints |
| 1 | Phase 1 (基础抽象) | NEW-R02, NEW-R03(b), NEW-R04, NEW-R09 (cond.) | Type safety + dedup; aligns with Phase 1 abstractions |
| 2 | Phase 2 (集成测试 + 工具整合) | NEW-R05, NEW-R06, NEW-R07, NEW-R08, NEW-R10 (cond.), NEW-R15 impl | Abstractions + quality gates; H-21 dependency gates Phase 2 |
| 2–3 | Phase 3 (契约稳定化) | NEW-R11, NEW-R12, NEW-R13, NEW-R14 | Package splitting + contracts; after H-16a/NEW-06 stabilize |

## 9. Relationship to Existing Plan Items

> **Note**: Items below that overlap existing REDESIGN_PLAN.md work are framed as **plan edits** (amendments to existing items) rather than independent new items. This avoids scope duplication.

| New Item | Overlaps With | Relationship | Action |
|---|---|---|---|
| NEW-R01 | NEW-05a (TS migration) | **Umbrella** — R09/R10/R11 are sub-items | Track as a parallel umbrella; R09/R10 are **optional investigations** that do NOT block NEW-05a (see §6.1/§6.2 decision gates). R11 is a Phase 3 sub-item under M-13. Do NOT add R01 or its sub-items as prerequisites of NEW-05a. |
| NEW-R02 | — | **Standalone** — type safety enables better tests | New item |
| NEW-R03 | H-01 (AutoresearchError) | **Extension** — H-01 defines error types, R03 enforces usage | Amend H-01 scope |
| NEW-R04 | — (no existing plan item) | **Standalone** — Zotero implementation dedup not covered by any current plan item (H-16a is tool-name constantization, not implementation consolidation) | New item |
| NEW-R08 | CODE-01 (module size) | **Standalone** — CODE-01.1 enforcement for skills scripts (EVO-12 is lifecycle automation, not CI governance) | New item under CODE-01 |
| NEW-R09 | NEW-R01, NEW-05a | **Conditional sub-item of R01** — aids comprehension for TS migration but **not a hard prerequisite**: NEW-05a can proceed without Python decomposition (see §6.1 decision gate). Tracker action: add as **optional investigation** under NEW-05a with decision gate; do NOT encode as a blocking dependency |
| NEW-R10 | NEW-R01, Phase 3 (idea-engine) | **Conditional sub-item of R01** — aids comprehension for idea-engine TS migration but **not a hard prerequisite**: Phase 3 TS rewrite can proceed from scratch without Python decomposition (see §6.2 decision gate). Tracker action: add as **optional investigation** under idea-engine migration; do NOT encode as a blocking dependency |
| NEW-R11 | NEW-R01, M-13 (MCP 逻辑模块化) | **Scope expansion of M-13** | Amend M-13 |
| NEW-R13 | H-16a + M-02 + H-21 | **Alternative approach** — see §10 tradeoff analysis | Propose as H-16a amendment (requires evaluation) |
| NEW-R14 | NEW-05 (monorepo) | **Extension** — internal splitting after monorepo established (independent of rename) | New item, Phase 2 |
| NEW-R15 | NEW-05a + EVO-13 | **Design input** — see §13.5 reconciliation with NEW-05a | Phase 0: add architecture spec as NEW-05a design constraint (unblocked); Phase 1: implement orchestrator MCP tools (blocked by H-03/H-02/H-01/H-11a/H-16a) |

## 10. Package Rename: `hep-research-mcp` → `hep-mcp` (Tradeoff Analysis)

> **Status**: This section presents a tradeoff analysis between the rename approach and the existing H-16a/M-02 approach. It is NOT a foregone conclusion — the rename is one option that must be evaluated against H-16a's constantization + catalog strategy.

### 10.1 Current State

- Directory: `hep-research-mcp-main/` (GitHub download artifact suffix)
- npm package: `@hep-research/hep-research-mcp` (scoped)
- MCP config name: `hep-research` (hardcoded in `orchestrator_cli.py:3864,3969,4660,5299`)
- Tool prefix: `mcp__hep-research__` (19 chars)
- Data directory: **current default** is project-local `.hep-research-mcp` (resolved relative to CWD); **H-21 proposes** `~/.hep-research-mcp` (global home directory). These are different defaults — do not conflate current behavior with planned behavior.

### 10.2 Proposed Rename

| Current | Proposed | Savings |
|---|---|---|
| `hep-research-mcp-main/` | monorepo `packages/hep-mcp/` | N/A (monorepo) |
| `hep-research-mcp` (npm) | `@autoresearch/hep-mcp` | Scoped naming |
| `hep-research` (MCP config) | `hep` | 9 chars per tool |
| `mcp__hep-research__` (prefix) | `mcp__hep__` (10 chars) | 9 chars saved |

### 10.3 Tool Name De-duplication (Double `hep` Fix)

Current tool names all carry a `hep_` prefix (e.g. `hep_run_writing_...`, `hep_project_...`, `hep_inspire_...`). When the MCP config name is also `hep`, the fully qualified name becomes `mcp__hep__hep_...` — redundant double prefix.

**Fix**: Strip the `hep_` prefix (4 chars) from tool names; the server namespace already provides it.

| Current Tool Name | chars | Proposed (strip `hep_`) | chars | FQ with `mcp__hep__` (10 chars) | FQ chars | ≤40 tool? | ≤64 FQ? |
|---|---|---|---|---|---|---|---|
| `hep_run_writing_create_section_write_packet_v1` | 47 | `run_writing_create_section_write_packet_v1` | 43 | `mcp__hep__run_writing_create_section_write_packet_v1` | 53 | **No (43)** | Yes |
| `hep_project_build_evidence` | 26 | `project_build_evidence` | 22 | `mcp__hep__project_build_evidence` | 32 | Yes | Yes |
| `hep_inspire_search_export` | 25 | `inspire_search_export` | 21 | `mcp__hep__inspire_search_export` | 31 | Yes | Yes |

**Note**: Stripping `hep_` alone does NOT bring all tool names below the ≤40 tool-name limit. The longest tool names (writing pipeline with versioned suffixes) remain 40–47 chars after prefix removal. A full audit of the 70+ tool names is required to identify which FQNs still exceed limits. **Measured evidence needed**: after H-16a constantization, run `grep -oP 'name:\s*"\K[^"]+' src/tools/registry.ts | awk '{print length, $0}' | sort -rn | head -20` to list the 20 longest tool names and check each against both limits. Only if >5 tools exceed limits after H-16a shortening should the rename be escalated from P3.

All FQ names drop below the ≤64 FQ limit. The ≤40 tool-name limit is the binding constraint for the longest names. **Note**: removing the `hep_` tool-name prefix is **orthogonal** to renaming the server namespace (`hep-research` → `hep`). The prefix removal can be evaluated independently as part of H-16a's tool-name shortening work, without requiring the server rename. The server rename (§10.2) addresses client-side namespace ergonomics; the prefix removal (§10.3) addresses tool-name length. These are separable decisions.

### 10.4 Impact

- ~206 cross-ecosystem references (85 meta, 89 hepar, 25 skills, 7 market)
- Combined with tool name de-duplication, addresses the **name-length** dimension of H-16a (tool name ≤40, FQ name ≤64). However, this does **not** replace H-16a's other deliverables: constantization (generated `ToolName` enum/consts replacing hardcoded strings), catalog lint (CI check that tool names match the catalog), and runtime handshake (client capability negotiation). H-16a remains required regardless of whether the rename proceeds.
- Should be executed as part of NEW-05 (monorepo migration) to avoid double rename

**Migration safety**: Stripping the `hep_` prefix from 70+ tools will break all existing prompts, system instructions, and skills that hardcode the full tool names. Implement a **tool alias mapping layer** in the MCP server that accepts both old (`hep_project_build_evidence`) and new (`project_build_evidence`) names during a deprecation period (Phase 0–1). Log alias hits to track migration progress; remove aliases in Phase 2. Note: server-side tool aliases only solve tool-name resolution — they do NOT address client-side namespace migration (`mcp__hep-research__` → `mcp__hep__` in agent configs, skills, and prompts). A **client-side dual-namespace migration plan** is required: (1) written deprecation horizon (e.g., "old names removed in Phase 2 GA"); (2) compatibility matrix listing all artifacts/configs/env vars requiring update (`HEP_DATA_DIR`, MCP client configs, skill scripts, system prompts); (3) hepar CLI alias support (accept both `hep-research` and `hep` as server names during deprecation window); (4) **prompt/docs migration task**: `grep` and update all `AGENTS.md`, `system_prompts/`, and `skills/` documentation to reflect the new `hep_`-less tool names — agents may hallucinate old names based on stale context files, so documentation must be updated before alias removal.

**Server namespace limitation**: The alias layer can only remap **tool names** within the server. The **server namespace** (`mcp__hep-research__` vs `mcp__hep__`) is a client-side config concern — changing it requires either (a) dual MCP config entries during deprecation (both `hep-research` and `hep` pointing to the same server binary), or (b) a coordinated one-shot migration of all client configs. This is a significant operational cost not present in the H-16a approach.

**Comparison with H-16a approach**: H-16a already defines tool name constantization + catalog + handshake, which addresses length limits without renaming the server. The rename approach offers additional benefits (cleaner naming, reduced redundancy) but at higher migration cost. **Decision**: Defer to H-16a evaluation; if H-16a resolves length limits sufficiently, the rename becomes P3 cosmetic cleanup rather than P1 necessity.

**Recommendation**: NEW-R13 — Package rename `hep-research-mcp` → `hep-mcp` as a **complementary measure to H-16a** for tool name ergonomics (NOT an alternative — H-16a is required regardless). H-16a addresses **tool-name** length (constantization + catalog lint + runtime handshake); NEW-R13 addresses **FQ-prefix** length (shortening `mcp__hep-research__` → `mcp__hep__`). These are orthogonal: H-16a shortens the part after the prefix, NEW-R13 shortens the prefix itself. **Decision gate**: evaluate NEW-R13 only after H-16a implementation; if FQ names are within limits after H-16a, demote NEW-R13 to P3 cosmetic cleanup. Blocked by H-16a evaluation + M-02 + H-21. If the rename option is pursued, it must integrate with M-02's existing **deprecated alias mapping** mechanism: old tool names are registered as deprecated aliases in the tool catalog with `deprecated_since` timestamps; the deprecation window is 2 major release cycles (or 6 months, whichever is longer); alias-hit telemetry tracks usage of deprecated names; removal is gated on alias-hit rate dropping below 5% for 30 consecutive days. Migration checkpoints: (1) all `AGENTS.md` / `system_prompts` / `skills/` docs updated, (2) all client configs migrated or dual-config deployed, (3) `HEP_DATA_DIR` environment variable updated (H-21).

## 11. hep-mcp Internal Package Splitting

### 11.1 Current State

The main `hep-research-mcp` package contains **269 source files / 98,625 LOC** — 90% of all code in the monorepo. The three satellite packages (zotero-mcp 4,541 LOC, pdg-mcp 3,885 LOC, shared 2,087 LOC) are well-scoped.

### 11.2 Domain Breakdown

| Domain | Files | LOC | % of total |
|---|---|---|---|
| `tools/research/` | 97 | 38,443 | 39% |
| `vnext/` | 66 | 30,232 | 31% |
| `tools/writing/` | 69 | 16,470 | 17% |
| `corpora/` | 16 | 6,031 | 6% |
| `api/` + `utils/` + other | 21 | 7,449 | 7% |

### 11.3 Recommended Extractions

**1. `@autoresearch/latex-parser` (~12,200 LOC)**
- `tools/research/latex/` (18 files, 11,220 LOC) + `tools/research/preprocess/` (6 files, 992 LOC)
- Self-contained parser with own AST, extractors for equations/figures/tables/sections/theorems/citations/bibliography. Zero business logic coupling.

**2. `@autoresearch/writing` (~34,700 LOC)**
- `tools/writing/` (69 files, 16,470 LOC) + `vnext/writing/` (37 files, 18,258 LOC)
- Has own LLM client abstraction, RAG pipeline, state machine, template system — a fully independent subsystem.

**3. `@autoresearch/corpora` (~6,000 LOC)**
- `corpora/style/` (12 files, 5,923 LOC) + `corpora/profiles/` (4 files, 108 LOC)
- Pure data/configuration package consumed by writing tools.

### 11.4 Impact

These three extractions reduce `hep-mcp` from **98,625 → ~45,700 LOC** (54% reduction). Each extracted package has a clear, cohesive responsibility. The remaining `research-tools` + `vnext-core` stay in the slimmed-down `hep-mcp`.

**Recommendation**: NEW-R14 — Split `hep-mcp` into 3 additional packages: `@autoresearch/latex-parser`, `@autoresearch/writing`, `@autoresearch/corpora`. Execute during Phase 2 (after monorepo established via NEW-05).

## 12. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| God-file splitting introduces regressions | High | Require test coverage before splitting; split is pure refactor (no behavior change) |
| `as any` elimination changes runtime behavior | Medium | Each cast removal must preserve existing tests; add tests where missing |
| Zotero consolidation breaks aggregated MCP server | High | Run full tool contract tests after consolidation |
| `orchestrator_cli.py` decomposition breaks `hepar` CLI | High | Regression runner script exists (`orchestrator_regression.py`, 1377 LOC) but is not CI-enforced; run `python -m pytest tests/ && python orchestrator_regression.py` before/after each decomposition PR |
| `hep-mcp` package splitting breaks import paths | Medium | Monorepo workspace aliases; update all internal imports in single PR |
| Tool rename breaks existing prompts/skills | High | Tool alias mapping layer with deprecation logging (NEW-R13) |
| Orchestrator MCP exposure creates security surface | Medium | Approval gates preserved as MCP tool parameters; sandbox-aware design |

## 13. Agent Shell Architecture Absorption

### 13.1 Context

Autoresearch users interact with the system through general-purpose agent shells (Claude Code CLI, Codex CLI, OpenCode). The MCP server is the integration point. Analysis of these agent shells reveals patterns worth absorbing.

> **Sourcing caveat**: The patterns listed in §13.2–13.4 are derived from publicly observable behavior and documentation of these tools as of 2026-02. They are **hypotheses about useful absorption targets**, not verified architectural claims. Before implementing any absorption item, a validation task must confirm the pattern exists in the target tool's current version. All patterns are hypotheses pending validation — no confidence markers are assigned until evidence notes are attached.
>
> **Validation tasks** (must be completed before absorbing each pattern):
> - Claude Code CLI: Confirm sub-agent dispatch, compaction, hooks system, permission tiers in current release docs (`claude.ai/docs` or `github.com/anthropics/claude-code`) — produce evidence note (version, URL, date checked)
> - Codex CLI: Confirm crate structure, AGENTS.md convention, sandbox mechanism in `github.com/openai/codex` at a specific tag/commit — produce evidence note
> - OpenCode: Confirm provider-agnostic loop, SQLite sessions, plugin architecture in `github.com/opencode-ai/opencode` at a specific tag/commit — produce evidence note
>
> **Plan alignment**: This section maps to existing plan items: **EVO-13** (agent-shell adoption patterns), **EVO-12** (skills lifecycle automation). Absorption bullets below reference these items to avoid creating a parallel architecture track. **Note**: EVO-13 maintains its own adoption document (`autoresearch-meta/docs/2026-02-19-opencode-openclaw-design-adoption.md`) with validated patterns and implementation status — the tables in §13.2–13.4 below are **preliminary survey observations only** and must be migrated to the EVO-13 adoption doc (with evidence notes: tool version/commit/date checked + observed feature) once validated. After migration, remove the tables from this analysis to avoid maintaining a second, drifting "canonical" record. Do not duplicate validated findings between this analysis and EVO-13; this section serves as an initial survey, not the canonical record.
>
> **REP protocol alignment**: The orchestrator w1→w2→w3 workflow phases and the Research Evolution Protocol (EVO-17) operate at different abstraction levels. REP governs *strategy evolution across runs*; w1/w2/w3 govern *execution within a single run*. These are complementary, not mappable 1:1. REP integration is scoped to EVO-17/EVO-18, not this analysis. No w1↔REP mapping is proposed here. **Terminology** (aligned with EVO-17 canonical types): `ResearchEvent` — atomic event emitted by workflow phases (w1/w2/w3 completions, state transitions); `ResearchOutcome` — run-level evaluation aggregating events into a strategy-relevant result; `IntegrityReport` — reproducibility/audit artifact produced by EVO-06 (not a direct w3 output). **Touchpoints** (where w1/w2/w3 artifacts/events feed REP envelopes): (1) w1 completion emits a `ResearchEvent` with ingested evidence summary → feeds `ResearchOutcome` evaluation; (2) w2 completion emits a `ResearchEvent` with computation results + artifact URIs → feeds `ResearchOutcome` with quantitative metrics; (3) w3 completion emits a `ResearchEvent` with writing artifacts → referenced by EVO-06 `IntegrityReport` production (w3 does not directly produce the report; EVO-06 consumes w3 events); (4) run-level `RunState` transitions feed the REP `ResearchEvent` stream for cross-run strategy adaptation. These touchpoints are specified here for downstream clarity; implementation is deferred to EVO-17/EVO-18.

### 13.2 Candidate Patterns from Claude Code CLI

| Pattern | Observed Behavior (unverified — validate before adoption) | Autoresearch Absorption |
|---|---|---|
| **Sub-agent dispatch** | `Task` tool spawns specialized agents (Explore, Plan, Bash) with isolated tool sets | Expose orchestrator workflows as composable MCP tools that agent shells can chain |
| **Automatic compaction** | Context window management via summarization | Add `run_get_summary` MCP tool returning compacted run state for long sessions |
| **Hooks system** | Pre/post tool-call hooks for validation | Support `pre_approve` / `post_write` hooks in orchestrator MCP tools |
| **Permission tiers** | suggest / auto-edit / full-auto | Map to orchestrator approval modes: manual / semi-auto / full-auto |

### 13.3 Candidate Patterns from Codex CLI

| Pattern | Observed Behavior (unverified — validate before adoption) | Autoresearch Absorption |
|---|---|---|
| **Rust crate separation** | 30+ crates: core, tui, exec, hooks, mcp-server, sandbox | Model for NEW-R14 package splitting — each domain is an independent package |
| **AGENTS.md convention** | Project-level instructions read by any agent | Strengthen our AGENTS.md with research-domain conventions |
| **Sandbox isolation** | Seatbelt (macOS) / Landlock (Linux) per tool call | Consider sandboxed evidence-building (no network during grading) |
| **Skills system** | Directory-based skills with AGENTS.md discovery | Already implemented; align naming with Codex conventions for portability |
| **App-server protocol** | Typed RPC (v2) for IDE integration | Future: expose hep-mcp via app-server protocol for IDE research panels |

### 13.4 Candidate Patterns from OpenCode / oh-my-opencode

| Pattern | Observed Behavior (unverified — validate before adoption) | Autoresearch Absorption |
|---|---|---|
| **Provider-agnostic agent loop** | Supports OpenAI, Anthropic, local models | MCP tools already provider-agnostic; ensure no Claude-specific assumptions |
| **Session persistence + compaction** | SQLite-backed sessions with automatic compaction | Align with orchestrator run artifact store; consider compaction for long research sessions |
| **Plugin architecture** | Go plugin system for extensions | MCP is our plugin system; no separate mechanism needed |

### 13.5 NEW-R15: Orchestrator as MCP Tools (Design Input for NEW-05a)

> **Reconciliation with NEW-05a/EVO-13**: REDESIGN_PLAN establishes `packages/orchestrator/` as an MCP **client** + unified engine (NEW-05a), with EVO-13 adopting agent-shell patterns. NEW-R15 is NOT a competing architecture — it is a **design constraint** for NEW-05a: the TS orchestrator should expose its capabilities as MCP tools in addition to being an MCP client. This enables agent shells to drive orchestration without the `hepar` CLI wrapper.
>
> **Reconciliation with NEW-06 principle**: REDESIGN_PLAN line 995 states `refinement_orchestrator_v1` should be "内化为 agent 编排逻辑，不暴露为 MCP 工具" (internalized as agent orchestration logic, not exposed as MCP tools). NEW-R15 proposes the opposite for *run management* tools. The distinction: **run infrastructure** (create/status/approve/export) is stateless CRUD on persisted artifacts — appropriate for MCP tools. **Strategy orchestration** (which workflow to run, how to sequence steps, when to retry) remains agent-layer logic per NEW-06. This boundary must be enforced: orchestrator MCP tools expose only run lifecycle, never strategy decisions.

**Current architecture** (two entry points, duplicated logic):
```
User → Codex/Claude Code → MCP tools (hep-research)     [research only]
User → hepar CLI → MCP client → MCP tools (hep-research) [orchestration]
```

**Proposed architecture** (single entry point, orchestrator as both client and tool provider):
```
User → Any agent shell → MCP tools (hep-research)
                           ├── research/ (inspire, pdg, latex...)
                           ├── orchestrator/ (run_create, run_approve, run_status, run_export...)
                           └── writing/ (evidence, sections, outline...)
```

**Key design decisions**:
1. Orchestrator state machine exposed as stateful MCP tools (`orch_run_create` → `orch_run_status` → `orch_run_approve`). **Namespace strategy**: NEW-R15 orchestrator tools use the `orch_run_*` prefix to avoid collision with existing `hep_run_*` writing-pipeline tools (e.g., `hep_run_create` creates a vNext project run for evidence/writing, while `orch_run_create` creates an orchestrator-level research run managing the w1→w2→w3 lifecycle). These operate at different abstraction levels: orchestrator runs contain workflow steps, each of which may invoke writing-pipeline tools that create their own `hep_run_*` sub-runs. **URI strategy**: orchestrator runs use `orch://runs/<run_id>` (distinct from `hep://runs/<project_run_id>` used by the writing pipeline). **URI scheme rationale**: `orch://` is used instead of extending `hep://` because orchestrator runs and writing-pipeline runs are different resource types at different abstraction levels — an `orch://` run contains workflow steps that may reference multiple `hep://` sub-runs; reusing `hep://` would create ambiguity in resource resolution. However, `orch://` resources compose with H-18 `ArtifactRefV1` (the `uri` field accepts any scheme; the `sha256`/`size_bytes` fields provide scheme-agnostic integrity). If a future unified resolver makes `hep://` extensible enough to disambiguate run types (e.g., `hep://orch-runs/` vs `hep://runs/`), the `orch://` scheme can be aliased to `hep://` without breaking existing references. Under Option A (single server), both `orch_run_*` and `hep_run_*` tools are registered in the same MCP server with distinct prefixes; under Option B (separate server), `orch_run_*` tools are in `hep-orchestrator` server and collision is impossible. **Alias plan**: if NEW-R13 renames the server to `hep-mcp`, the existing `hep_run_*` tools are unaffected (prefix doesn't change); `orch_run_*` tools are new and have no migration burden. Note: MCP is stateless per-call; state is persisted in the run artifact store, not in-memory. All states use the canonical **H-03 RunState v1 enum**: `pending|running|paused|awaiting_approval|completed|failed|needs_recovery`.
2. Approval gates preserved: `run_approve` requires explicit user confirmation via H-11a `destructive` risk level + `_confirm` mechanism (not a separate risk category)
3. `hepar` CLI retains its own workflow orchestration logic (step sequencing, strategy decisions, retry) but calls the same CRUD MCP tools for state management. This is backwards-compatible: existing `hepar run/status/approve/export` commands map 1:1 to the CRUD tools (`orch_run_*`), while workflow execution logic remains in the CLI. The CLI is a "client with built-in strategy," not a "thin wrapper" — it composes CRUD tools + research tools into workflows, just as an agent shell or skill would.
4. Skills compose MCP tools into workflows (e.g., `research-team` skill calls `orch_run_create` + `orch_run_approve` in sequence)
5. Orchestrator tools in the run-CRUD surface do **not** invoke other MCP tools — they are pure state-management operations (create/read/update artifact store). Workflow execution (e.g., calling `inspire_search` during w1) is agent-layer logic, not part of the CRUD tool surface. Under Option A (single server), orchestrator tool handlers and research tool handlers share a process but do not call each other; under Option B (separate server), they run in separate processes. In either case, inter-tool composition is done by the agent (or skill) calling tools in sequence, not by tools calling other tools internally. C-02 shell isolation applies: any tool that executes shell commands must run within the same sandbox constraints as direct tool calls.

**Precise tool surface** (run-CRUD only; strategy tools are explicitly excluded):

| Tool | Category | Mutates State? | Requires `_confirm`? | Invariant |
|---|---|---|---|---|
| `orch_run_create` | CRUD | Yes (creates run) | No | Returns `RunState.pending`; no side effects beyond artifact store write. **Idempotency**: accepts an optional `idempotency_key` (client-generated UUID); if a run with the same key already exists, returns the existing run instead of creating a duplicate. This prevents double-creation from retried tool calls or network timeouts. |
| `orch_run_status` | CRUD | No (read-only) | No | Returns current `RunState` + artifact manifest |
| `orch_run_list` | CRUD | No (read-only) | No | Lists runs with filter/pagination |
| `orch_run_approve` | CRUD | Yes (state transition) | **Yes** | Transitions `awaiting_approval` → `running`. **Required parameters**: `_confirm: true` + `approval_id` (stable human-readable ID, e.g., `appr_A3-0042`, per ecosystem ID conventions; **migration note**: existing codebase uses `A1-0001` format via `next_approval_id()` — during migration, both `A{N}-{NNNN}` legacy format and `appr_{gate}_{seq}` new format are accepted; the server normalizes to the new format on write) + `approval_packet_sha256` (SHA-256 digest of the persisted approval packet — prevents agent self-approval by blindly sending `_confirm: true` without referencing a specific packet; the digest is computed over the JSON-canonicalized per RFC 8785 approval packet bytes). **Field separation**: `approval_id` and `approval_packet_sha256` are distinct fields — the ID is a stable locator for the persisted packet (matches NEW-02's `approval_id` field and the existing `appr_*` convention in `orchestrator_cli.py`); the SHA-256 digest is a content-integrity check ensuring the agent has seen the actual packet contents (not just guessed or replayed an ID). Both must be provided; the server loads the packet by `approval_id`, computes its digest, and rejects if the client-provided `approval_packet_sha256` does not match. **Enforcement**: uses H-11a `destructive` risk level. The approval gate relies on **shell-mediated confirmation**: agent shells with approval UX (Claude Code allowlists, Codex approval prompts) surface the `_confirm` requirement as a user-facing confirmation dialog before executing the tool. **Server-side enforcement**: the MCP server validates `_confirm`, `approval_id`, and `approval_packet_sha256` at the server level. When `_confirm` is absent/false, `approval_id` doesn't match a pending packet, or `approval_packet_sha256` doesn't match the server-computed digest, the server rejects the call with an MCP error response that includes a descriptive prompt (approval packet summary + run_id + what will happen) — this serves dual purpose: (a) shells that support confirmation UX can display the prompt and re-call with correct parameters after user consent; (b) headless clients that cannot prompt the user receive a clear rejection rather than a silent pass-through. **Semantics**: `run_approve` is a pure state transition — it does NOT trigger workflow execution. After approval, the run enters `running` state; the agent/CLI is responsible for polling `run_status` and invoking subsequent workflow steps. **Note**: `_confirm` is UX-level confirmation only — the full approval mechanism includes the A1–A5 gate model (approval packet generation, persistence, audit trail) as specified in NEW-02. **Headless/CI environments**: the `hepar approve <run_id>` CLI command provides a separate out-of-band approval path that does not go through the LLM. Integration tests can invoke `hepar approve` programmatically. |
| `orch_run_export` | CRUD | Yes (writes export files) | **Conditional** | Exports run artifacts to specified format/path. **Risk level**: `write` when writing within the run store root (`$HEP_DATA_DIR/runs/<run_id>/export/`); **`destructive`** when writing to a user-specified path outside the run store root OR when overwriting an existing file. **Path safety**: the export path must be resolved and validated against an allowlist (run store root + explicitly configured export directories per C-02/H-08); paths containing `..` or symlinks pointing outside the allowlist are rejected. When `destructive`, requires `_confirm: true`. |
| `orch_run_pause` / `orch_run_resume` | CRUD | Yes (state transition) | No | Transitions `running` ↔ `paused` |
| `orch_run_reject` | CRUD | Yes (state transition) | **Yes** | Transitions `awaiting_approval` → `failed` (irreversible). Records rejection reason in audit trail. **Risk level**: `destructive` (irreversible state transition, same as `run_approve`). Requires `_confirm: true` + `approval_id` + `approval_packet_sha256` (same field separation and server-side validation as `run_approve`). |
| `orch_run_approvals_list` | CRUD | No (read-only) | No | Lists pending approval packets across runs (filter by status/run_id). Maps to existing `hepar approvals show`. |

**Concurrency invariants**: The run artifact store uses **file-level locking** (`flock`/`lockfile` or equivalent) on the run manifest to prevent concurrent state transitions from corrupting run state. **Minimal viable locking**: all tools (both read and write) acquire an **exclusive lock** on the target run's manifest — shared locks are not used because cross-platform shared locking in Node.js/TS is not reliably portable (Windows `flock` semantics differ from POSIX). This sacrifices read concurrency for simplicity and correctness. Lock timeout: 5 seconds (configurable); on timeout, return a retriable MCP error. **Implementation prerequisites**: locking + atomic state persistence depend on (a) H-07 (`atomicWriteFile` — the plan already defines atomic write utilities for `hep-research-mcp`; the orchestrator run-store must use the same primitive or an equivalent TS implementation) and (b) a cross-platform lock utility (e.g., `proper-lockfile` npm package or equivalent — not currently in the dependency tree; add as an explicit Phase-2 implementation prerequisite). **Config path resolution**: the run artifact store root is resolved via `HEP_DATA_DIR` (H-21) through the canonical config loader (H-20) → `$HEP_DATA_DIR/runs/`; the implementation must resolve this path once at server startup (not per-call) to avoid TOCTOU races.

**Excluded from MCP tool surface** (agent-layer only per NEW-06):
- Workflow selection (which w1/w2/w3 to run)
- Step sequencing and retry logic
- Strategy adaptation based on intermediate results
- `refinement_orchestrator_v1` logic

**Risk-level tagging**: Each tool must carry the **H-11a `risk_level`** field (`read` | `write` | `destructive`) — not a separate taxonomy. `orch_run_approve` and `orch_run_reject` are `destructive` (irreversible state transitions, require `_confirm: true` + `approval_id` + `approval_packet_sha256`); `orch_run_export` is `write` within the run store root, `destructive` when targeting external paths or overwriting (requires `_confirm: true`); `orch_run_create`, `orch_run_pause/resume` are `write`; `orch_run_status`, `orch_run_list`, `orch_run_approvals_list` are `read`. This reuses the existing H-11a `_confirm` mechanism for `destructive` tools, ensuring consistency across the entire MCP tool surface without inventing a parallel risk classification.
6. **Server boundary decision** (single-server vs separate orchestrator MCP server):

   REDESIGN_PLAN establishes `packages/orchestrator/` as a separate TS package (NEW-05a/EVO-13). This is a **code packaging** boundary, not necessarily a **server process** boundary. Two deployment options:

   - **Option A (single server)**: Orchestrator tools registered in the same `hep-mcp` MCP server process. `packages/orchestrator/` exports tool handlers that `hep-mcp` imports and registers. Pros: single MCP connection per agent shell session; no multi-server coordination; simpler client config. Cons: orchestrator code shares process with research tools; no privilege separation.
   - **Option B (separate server)**: `packages/orchestrator/` runs as its own MCP server (`hep-orchestrator`). Agent shells connect to both `hep-mcp` and `hep-orchestrator`. Pros: privilege separation (orchestrator can run with restricted permissions); independent scaling; clearer failure isolation. Cons: agent shells must manage two MCP connections; cross-server tool composition requires client-side chaining.

   **Recommendation**: Start with Option A (single server) for Phase 1–2 simplicity. **Exception**: if `latex-parser` (which processes untrusted external input) is bundled in the same server process as orchestrator tools (which hold `destructive` permissions), subprocess isolation or Option B becomes mandatory immediately — do not wait for Phase 3 security audit. Evaluate Option B at Phase 3 for all other privilege-separation requirements. The `packages/orchestrator/` code boundary supports either option without refactoring — only the server registration entry point changes.

**Prerequisite contracts** (must be available before NEW-R15 **implementation** — the Phase-0 design constraint is a spec document with no code dependencies):
- H-03 `RunState` enum — orchestrator tools return/transition `RunState` values (canonical enum: `pending|running|paused|awaiting_approval|completed|failed|needs_recovery`)
- H-02 `trace_id` — every orchestrator tool call carries `trace_id` for audit correlation
- H-01 `AutoresearchError` envelope — orchestrator errors use structured error types (tracker ID: H-01; contract rule: ERR-01)
- H-11a tool risk classification — orchestrator tools tagged with `risk_level` (`read|write|destructive`) per H-11a; `run_approve` uses `destructive` + `_confirm` gating (depends on C-02 shell isolation)
- H-16a tool name constants — orchestrator tool names follow length constraints
- H-07 `atomicWriteFile` — atomic file write primitive for safe run-store persistence (or equivalent TS implementation); provides the write-safety guarantee underlying the locking invariants
- H-05 cross-platform file locking — H-05 defines the `AdvisoryLock(path, owner, ttl)` abstraction with `filelock` (Python); the TS orchestrator's manifest locking must use the same locking semantics (or a TS equivalent like `proper-lockfile` that is compatible with H-05's lock file format) to prevent split-brain between Python CLI and TS MCP server during the migration period. If H-05's lock format is adopted as the cross-language standard, the TS implementation must read/write compatible lock files.
- NEW-02 approval packet persistence — `orch_run_approve`/`orch_run_reject` require `approval_id` (stable locator, `appr_*` convention) + `approval_packet_sha256` (content-integrity digest); the approval packet SSOT (schema, persistence location, lifecycle) must be defined before these tools can be implemented. **Canonicalization rule**: the SHA-256 digest (`approval_packet_sha256`) is computed over the JSON-canonicalized (`json-canonicalize` / RFC 8785) approval packet bytes, ensuring deterministic hashes regardless of key ordering or whitespace. Without canonicalization, different serialization implementations may produce different digests for the same logical packet, breaking the anti-self-approval property.
- H-20 config loader — run artifact store root resolved via the canonical config loader (avoids bespoke `HEP_DATA_DIR` resolution diverging from CLI semantics)
- H-21 `HEP_DATA_DIR` — defines the storage root (`$HEP_DATA_DIR/runs/`) shared between CLI and MCP server; both implementations must resolve to the same physical path to avoid split-brain state

**Recommendation**: NEW-R15 — **Two-phase deliverable**. Phase 0: architecture spec (design constraint for NEW-05a) defining the tool surface, run-infra vs strategy boundary, threat model, and H-11a integration — this is a document, not code, and has no blocking dependencies. Phase 2: implementation of orchestrator MCP tools per the Phase-0 spec, blocked by H-03 (RunState), H-02 (trace_id), H-01 (AutoresearchError), H-05 (cross-platform file locking), H-07 (atomicWriteFile), H-11a (risk classification), H-16a (tool naming), H-20 (config loader), H-21 (HEP_DATA_DIR — Phase 2 in tracker, so implementation cannot begin in Phase 1), NEW-02 (approval packet persistence). The TS orchestrator must expose run lifecycle (`orch_run_create`/`orch_run_status`/`orch_run_approve`/`orch_run_export`) as MCP tools, while keeping strategy orchestration in the agent layer per NEW-06. **`hepar approve` compatibility note**: current `hepar approve <run_id>` both flips persisted state AND resumes workflow execution in the same command invocation. Under the CRUD decomposition, `orch_run_approve` is a pure state transition (state flip only); workflow resumption becomes a separate agent/CLI-driven step (poll `orch_run_status` → invoke next workflow tool). This is a behavioral change for `hepar` CLI users: `hepar approve` will need to be updated to call `run_approve` followed by workflow resumption logic. Document this migration in the `hepar` CLI changelog.

---

> **CONVERGENCE ACHIEVED** (2026-02-21). **Gemini R2/R3/R4: READY** (three consecutive passes). **Codex R23: READY** (zero blocking issues, 5 non-blocking amendments). Both reviewers now agree the analysis is acceptable for implementation.
>
> **Codex R23 non-blocking amendments** (post-convergence cleanup):
> 1. §10.1 `HEP_DATA_DIR` default: clarify current (project-local `.hep-research-mcp`) vs planned (H-21 proposes `~/.hep-research-mcp`) in baseline table
> 2. NEW-R15 `approval_id` format: align examples with existing `A1-0001` (`next_approval_id()`) and/or H-15a EcosystemID; state accepted formats during migration
> 3. NEW-R15 URI scheme: prefer reusing `hep://` + `ArtifactRefV1` unless `orch://` has a concrete resolver/interop requirement
> 4. NEW-R02a: add explicit CI wiring plan (entry command + where it runs) and minimal golden tests for `check_loc.py`/`check_entry_files.py`
> 5. NEW-R05: Pydantic v2 already isolated as NEW-R05a (done)
>
> **Codex review trajectory**: R16 (4 blocking) → R17 (3) → R18 (2) → R19 (3) → R20 (2) → R21 (4) → R22 (2) → R23 (0 blocking, **READY**). Total: 8 rounds in this analysis, ~20 blocking issues resolved.
>
> **Next step**: Update REDESIGN_PLAN.md and remediation_tracker_v1.json with NEW-R01~R15 + NEW-R02a items. Draft governance proposal for ECOSYSTEM_DEV_CONTRACT.md CONTRACT-EXEMPT amendment.

## Appendix A: Metric Methodology

**Pinned commits**: hep-autoresearch `c149965`, hep-research-mcp `d33b869`, idea-core `e27d526`.

**Scope**: All metrics are scoped to source directories only (excluding tests, scripts, node_modules, dist, build artifacts).

**Commands used**:

```bash
# File LOC (raw — includes blanks, comments, docstrings)
# NOTE: All LOC figures in §1 are raw wc -l counts, NOT effective LOC.
# Effective LOC (eLOC) will be lower; violation factors are still severe.
wc -l <file>

# TypeScript as any total (hep-research-mcp src/ only)
rg -c "as any" hep-research-mcp-main/packages/hep-research-mcp/src/ --type ts \
  | awk -F: '{s+=$2} END {print s}'
# Result: 254

# TypeScript as any per-file top 10
rg -c "as any" hep-research-mcp-main/packages/hep-research-mcp/src/ --type ts \
  | sort -t: -k2,2nr | head -10

# Python except Exception total (hep-autoresearch src/ only)
rg -c "except Exception:" hep-autoresearch/src/hep_autoresearch/ \
  | awk -F: '{s+=$2} END {print s}'
# Result: 163

# Python silent swallows (except Exception: pass — both multiline and same-line)
rg -U -c "except Exception:(\n\s*pass| pass)" hep-autoresearch/src/hep_autoresearch/ \
  | awk -F: '{s+=$2} END {print s}'
# Result: 35

# Python semi-silent: continue (except Exception: continue)
rg -U -c "except Exception:(\n\s*continue| continue)" hep-autoresearch/src/hep_autoresearch/ \
  | awk -F: '{s+=$2} END {print s}'
# Result: 17

# Python semi-silent: bare return (except Exception: return ...)
rg -U -c "except Exception:(\n\s*return| return)" hep-autoresearch/src/hep_autoresearch/ \
  | awk -F: '{s+=$2} END {print s}'
# Result: 46

# Python except Exception as e: total (captured variable)
rg -c "except Exception as" hep-autoresearch/src/hep_autoresearch/ \
  | awk -F: '{s+=$2} END {print s}'
# Result: 118

# Python except Exception as e: return (captured but potentially discarding)
rg -U -c "except Exception as \w+:(\n\s*return| return)" hep-autoresearch/src/hep_autoresearch/ \
  | awk -F: '{s+=$2} END {print s}'
# Result: 45

# Source/test file counts
find hep-autoresearch/src/hep_autoresearch -type f -name '*.py' ! -path '*/test*' ! -name 'test_*' | wc -l  # 46
find hep-autoresearch -type f \( -name 'test_*.py' -o -name '*_test.py' \) | wc -l  # 16

# idea-core source/test file counts
find idea-core/src/idea_core -type f -name '*.py' ! -path '*/test*' ! -name 'test_*' ! -name 'conftest.py' | wc -l  # 25
find idea-core -type f \( -name 'test_*.py' -o -name '*_test.py' -o -name 'conftest.py' \) | wc -l  # 22

# TS source/test file counts
find hep-research-mcp-main/packages/hep-research-mcp/src -type f -name '*.ts' | wc -l  # 269
find hep-research-mcp-main/packages/hep-research-mcp/tests -type f -name '*.ts' | wc -l  # 102

# Package LOC totals
find hep-research-mcp-main/packages/hep-research-mcp/src -type f '(' -name '*.ts' -o -name '*.tsx' ')' -print0 | xargs -0 wc -l | tail -1  # 98625
```

## Appendix B: P0 Silent Swallow Sites (`except Exception: pass`)

35 sites (CODE-01.5 violations, P0 remediation scope). Listed as `file:line` at pinned commit `c149965`.

| # | File | Line | Context |
|---|---|---|---|
| 1 | `toolkit/kb_profile.py` | 220 | |
| 2 | `toolkit/w3_paper_reviser.py` | 365 | |
| 3 | `toolkit/ecosystem_bundle.py` | 618 | |
| 4 | `toolkit/ecosystem_bundle.py` | 672 | |
| 5 | `toolkit/ecosystem_bundle.py` | 709 | |
| 6 | `toolkit/orchestrator_regression.py` | 682 | |
| 7 | `toolkit/orchestrator_regression.py` | 728 | |
| 8 | `toolkit/orchestrator_regression.py` | 816 | |
| 9 | `toolkit/mcp_stdio_client.py` | 128 | |
| 10 | `toolkit/mcp_stdio_client.py` | 143 | |
| 11 | `toolkit/mcp_stdio_client.py` | 149 | |
| 12 | `toolkit/mcp_stdio_client.py` | 192 | |
| 13 | `toolkit/w1_ingest.py` | 458 | |
| 14 | `toolkit/method_design.py` | 538 | |
| 15 | `toolkit/method_design.py` | 590 | |
| 16 | `orchestrator_cli.py` | 3653 | |
| 17 | `toolkit/w_compute.py` | 192 | |
| 18 | `toolkit/w_compute.py` | 199 | |
| 19 | `toolkit/w_compute.py` | 267 | |
| 20 | `toolkit/w_compute.py` | 273 | |
| 21 | `toolkit/w3_paper_reviser_evidence.py` | 34 | |
| 22 | `toolkit/w3_paper_reviser_evidence.py` | 46 | |
| 23 | `toolkit/w3_paper_reviser_evidence.py` | 58 | |
| 24 | `toolkit/w2_reproduce.py` | 150 | |
| 25 | `toolkit/w2_reproduce.py` | 156 | |
| 26 | `toolkit/adapters/shell.py` | 72 | |
| 27 | `toolkit/adapters/shell.py` | 82 | |
| 28 | `toolkit/adapters/shell.py` | 91 | |
| 29 | `toolkit/adapters/shell.py` | 111 | |
| 30 | `toolkit/adapters/shell.py` | 120 | |
| 31 | `toolkit/adapters/shell.py` | 129 | |
| 32 | `toolkit/adapters/shell.py` | 204 | |
| 33 | `toolkit/orchestrator_state.py` | 95 | |
| 34 | `toolkit/orchestrator_state.py` | 489 | |
| 35 | `toolkit/orchestrator_state.py` | 592 | |

All paths relative to `hep-autoresearch/src/hep_autoresearch/`. Reproduce: `rg -U -n "except Exception:(\n\s*pass| pass)" hep-autoresearch/src/hep_autoresearch/`
