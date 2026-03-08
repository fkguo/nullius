## Cross-Component Architecture Decisions

### [2026-03-02] RT-05: Semi-permeable Clean Room + Information Membrane

**Context**: research-team multi-agent verification architecture
**Decision**: Reject both MAD (Multi-Agent Debate) and full isolation. Adopt a third path: Semi-permeable Clean Room with Information Membrane.
**Core idea**: Filter inter-member communication by semantic content type (HOW vs WHAT), not by source role. Methods/references PASS through; results/conclusions BLOCK.
**SOTA basis**: 7 prior art works analyzed ([PA-1] through [PA-7]); 5 genuinely novel elements (N1-N5).
**Design doc**: `meta/docs/sota-multi-agent-verification-2026.md` §第五-七部分
**REDESIGN_PLAN item**: RT-05
**Impact**: Affects all RT-01 workflow modes; asymmetric mode's redaction is a V0 prototype of membrane filtering.

### [2026-03-02] Batch 4 Scope: 改動 1-4

**Context**: System prompt improvements for research-team
**Decision**:
- 改動 1 (role specialization A=algebra, B=numerics): **Batch 4** — zero cost, integrated into RT-01 mode-specific prompts
- 改動 2 (force different verification targets): **Batch 4** — zero cost, one-line per B prompt
- 改動 3 (blind numerics): **Batch 4** — merged into RT-01 asymmetric mode + `--blind-numerics` shorthand
- 改動 4 (N-version programming): **Deferred** to RT-06/Batch 5+ — needs multi-phase execution infra
- Member C sidecar auto-trigger: **Batch 4** — low cost, artifact auto-detection
**Reason**: Ship role specialization + verification diversity first (zero cost, immediate value). Layer N-version programming on mature RT-01 + RT-05 foundation later.
**Impl prompt**: `meta/docs/prompts/prompt-phase3-impl-batch4.md`

### [2026-03-02] Publication Strategy: Paper A + Paper B

**Context**: Semi-permeable Clean Room novelty warrants publication
**Decision**: Two papers. Paper A (method paper, NLP/AI venue: ACL/EMNLP/NeurIPS) focuses on Information Membrane architecture + ablation. Paper B (HEP application, ML4PS/NeurIPS) demonstrates domain-specific value.
**Dependency**: Paper A requires RT-05 implementation + experiments (7 configurations × 30 tasks). Paper B requires Paper A results + real HEP project data.
**Timeline**: Design complete (2026-03). Implementation (2026-04). Experiments (2026-05-06). Paper A submission (2026-07). Paper B submission (2026-09).
**Design doc**: `meta/docs/sota-multi-agent-verification-2026.md` §第六部分

### [2026-03-03] RT-05: Information Membrane V1→V2 (Regex→LLM)

**Context**: Information Membrane V1 (regex-based) failed convergence after 5 rounds of review-swarm — reviewers found 30 total BLOCKING issues across R1–R5, all natural language bypass vectors (e.g., "forty-two", "a value in the low forties", "I can confirm your approach works").
**Root cause**: Semantic content classification is fundamentally unsolvable by pattern matching because natural language expression space is unbounded.
**Decision**: Completely remove all regex classification (~150 lines of `_BLOCK_RULES` + `_PASS_RULES`). Rebuild with pure LLM classification via OpenAI-compatible API (default: DeepSeek `deepseek-chat`).
**Key design**:
- Three-tier fallback: Tier 1 (json_schema structured output) → Tier 2 (json_object) → Tier 3 (prompt-only JSON)
- Fail-closed: any LLM failure → BLOCK ALL segments
- Indirect API key: `MEMBRANE_API_KEY_ENV` names the env var holding the key (key never in CLI args)
- Reused all infrastructure: `split_into_segments()`, data classes, audit logging
- 50 golden test examples for real-API regression testing
**Lesson**: Review-swarm must evaluate METHODOLOGY first before implementation details. This was a methodology failure (regex can't solve semantic classification) caught only after 5 rounds of detail-level review. Added `## Methodology` as optional review contract header to support methodology-first evaluation.
**V2 Review convergence (2026-03-04)**:
- R1-R2: Initial V2 implementation reviewed (both READY)
- R3: Codex found HTTPS bypass via `http://localhost.evil.com` (startswith → urlparse hostname fix)
- R4: Codex found duplicate segment_index fail-open (PASS overrides BLOCK via last-write-wins → detect duplicates, force BLOCK)
- R5: Both Codex + Gemini READY. 61 membrane tests, 184 total research-team tests.
**Files**: `skills/research-team/scripts/lib/information_membrane.py`, `skills/research-team/assets/system_membrane_v2.txt`, callers, tests

### [2026-03-04] SEM Track: Batch Split + Quality Gates (Phase 3 Batch 8~16)

**Context**: semantic-understanding-heuristics-audit identified 13 items (NEW-SEM-01~13) where enum/regex/keyword heuristics serve as semantic judgment authority. Originally placed as single "Batch 8" — violates 1-3 items/batch convention.
**Decision**: 10-batch split (Batch 8~16) with 5 quality gate checkpoints (G1-G5). Original Batch 8 (M-04, M-07, NEW-SKILL-01) deferred to Batch 17 because M-04's schema fidelity test triggered the audit — testing a flawed semantic layer would be misleading.
**Batch assignment**:
- B8: NEW-RT-05 (eval framework, P0)
- B9: NEW-SEM-07 (structured gates, 3-phase migration)
- B10: NEW-SEM-01 + NEW-SEM-06 (quantity adjudicator + retrieval)
- B11: NEW-SEM-02 (grading, gate: G3 SEM-01 eval pass)
- B12: NEW-SEM-03 + NEW-SEM-04 (stance + conflict)
- B13: NEW-SEM-05 + NEW-SEM-09 (classifier + section role)
- B14: NEW-SEM-10 + NEW-SEM-13 (grouping + challenge)
- B15: NEW-SEM-08 (packet curation, Python-side)
- B16: NEW-SEM-11 + NEW-SEM-12 (equations + provenance)
- B17: M-04 + M-07 + NEW-SKILL-01 (deferred original B8)
**Quality gates**: G1 (RT-05 eval framework ready), G2 (SEM-07 JSON SoT migration), G3 (SEM-01 quantity eval target met), G4 (SEM-02 schema stable), G5 (SEM-05 unified classifier ready)
**Review convergence**: Codex gpt-5.2 + GLM-5 (opencode). R1: both NEEDS_REVISION. R2: GLM-5 PASS, Codex trivial-only. Applied to REDESIGN_PLAN.md + tracker.
**Key principle**: LLM-first pattern [Lexical prefilter] -> [LLM adjudication] -> [Deterministic post-guards] with fail-closed gates, eval-first approach (n>=50-200 examples + baseline before implementation).
**Files**: `meta/REDESIGN_PLAN.md` (SEM section), `meta/remediation_tracker_v1.json`, `~/.autoresearch-lab-dev/batch-reviews/sem-track-plan-proposal-v2.md`

### [2026-03-05] SEM-01/SEM-06 (Batch 10): SOTA-aligned minimal multi-stage semantics

**Context**: Phase 3 Batch 10 implementation in `packages/hep-mcp/` (NEW-SEM-01 quantity semantics adjudicator + NEW-SEM-06 evidence retrieval upgrade).
**Decision**: Adopt SOTA-shaped pipelines with a conservative, local-first footprint:
- SEM-01: ER-style semantic adjudication with explicit abstention (`match|split|uncertain`) via MCP sampling (`ctx.createMessage`) + deterministic post-guards (units/schema) and cost control via caching + clustering budget.
- SEM-06: semantic-first candidate generation (embeddings) → deterministic rerank (semantic + token overlap + importance) → policy-driven lexical fallback (only on explicit trigger).
**Aligned with SOTA**:
- Multi-stage retrieval (candidate gen → rerank → fallback), but with a deterministic rerank baseline.
- ER framing for quantity alignment with explicit abstention; deterministic features as post-guards, not semantic authority.
- Global consistency/cost control by clustering + bounded pairwise comparisons.
**Intentional deviations / gaps vs 2024–2026 SOTA**:
- No cross-encoder / interaction reranker; no late-interaction multi-vector retriever; no query reformulation step (kept out for latency/cost + local-only evidence-first constraints).
- “Semantic retrieval” is implemented as **deterministic feature hashing** sparse vectors (`hashing_fnv1a32_dim*_v1` in `packages/hep-mcp/src/core/writing/evidence.ts`) + dot-product scoring; this is closer to robust lexical similarity than to pretrained dense semantic embeddings.
- “Hybrid” lexical+dense is not blended at retrieval time; lexical is fallback only (lexical signal appears as token-overlap inside rerank).
- Quantity adjudication uses a single structured prompt (not explicit multi-step decomposition/debate); escalate only if eval shows OOD brittleness.
**Reference note**: `meta/docs/sota-sem-batch10-2026-03-05.md`
**REDESIGN_PLAN items**: NEW-SEM-01, NEW-SEM-06

### [2026-03-06] SOTA Monorepo Architecture: Retrieval / Discovery / Routing 提升为一级架构关注点

**Context**: Batch 10 已交付 `NEW-SEM-06` 的质量优先 baseline，但对 monorepo 做诚实 SOTA 评估后，主要差距转移到了 federated discovery、multi-stage retrieval、以及 provider-agnostic routing，而不是“是否继续多加一点 LLM”。
**Decision**: 保留当前 redesign 主体，不做 destructive reset；新增 3 条 follow-up 主线：
- **Federated Scholar Discovery**: v1 作为 shared TS library 落在 `packages/shared/src/discovery/`，后续仅在需要时再提炼成 `packages/scholar-broker/`；`hep-mcp` 继续聚合 provider tools，broker 负责 query planning / fanout / dedup / canonicalization。
- **SEM-06 umbrella**: 将 Batch 10 的 `NEW-SEM-06` 重新表述为 `SEM-06a` baseline；后续显式增加 `NEW-SEM-06-INFRA` → `NEW-SEM-06b` (hybrid recall + strong reranker) → `NEW-SEM-06d` (triggered reformulation/QPP) → `NEW-SEM-06e` (structure-aware localization)。
- **Routing split by plane**: `NEW-RT-06` 仅负责 orchestrator / agent runtime routing（`ChatBackend` + backend factory + JSON registry）；`NEW-RT-07` 负责 host-side MCP sampling routing。MCP servers 只发 metadata，不自选模型。
**Hard prerequisites / boundaries**:
- `NEW-RT-01` 保持 done，不回写历史；后续 routing 是 additive follow-up。
- shared paper identifiers 必须先加 `openalex_id`，否则 federated canonical identity 不完整。
- 当前 `hashing_fnv1a32` 是明确 baseline；`SEM-06b` 必须以此为被替代对象做 eval。
- `agent-arxiv` 不应发展独立检索栈；等 federated discovery + `SEM-06e` 之后再做 search-heavy feature。
**Review status**: `meta/docs/sota-monorepo-architecture-2026-03-06.md` 已由 `Opus + Kimi K2.5` 完成外部双审核；两者均 `CONVERGED_WITH_AMENDMENTS`，`0 blocking`，已吸收依赖/REP 作用域澄清。
**Tracker / plan linkage**: `meta/REDESIGN_PLAN.md` 升级到 `v1.9.2-draft`; `meta/remediation_tracker_v1.json` 新增 `NEW-RT-06/07`, `NEW-DISC-01`, `NEW-SEM-06-INFRA/b/d/e`, `NEW-LOOP-01` 并同步 review 状态。

### [2026-03-06] SOTA follow-up sequencing: 保持现有 SEM lane，不做大重排

**Context**: 在将 7 个 SOTA follow-up 项登记进 `REDESIGN_PLAN` / tracker 后，需要决定它们是全部推迟到 Batch 16 之后，还是从 Batch 11 开始并行推进。
**Decision**: 采用 **双 lane 排期**，不打乱既有 Batch 11–16 语义质量轨：
- **现有 SEM lane 保持不变**: Batch 11=`NEW-SEM-02`, 12=`NEW-SEM-03/04`, 13=`NEW-SEM-05/09`, 14=`NEW-SEM-10/13`, 15=`NEW-SEM-08`, 16=`NEW-SEM-11/12`。
- **parallel infra lane**: Batch 11=`NEW-DISC-01` kickoff + `NEW-RT-06`; Batch 12=`NEW-SEM-06-INFRA`; Batch 13–14=`NEW-RT-07` + `NEW-DISC-01` closeout。
- **retrieval lane after infra closes**: Batch 17=`NEW-SEM-06b`; Batch 18=`NEW-SEM-06d`; Batch 19=`NEW-SEM-06e`。
**Why**:
- 不让 `NEW-DISC-01` / `NEW-SEM-06-INFRA` 无谓拖到 Batch 16 之后，否则真正的 SOTA retrieval 会被晚启动。
- 也不把 `NEW-RT-07` 变成当前 SEM lane 的硬 blocker；除非 host-side routing 真的成为评测/运维瓶颈。
- 把 critical path 明确为：`NEW-DISC-01` + `NEW-SEM-06-INFRA` → `NEW-SEM-06b` → `NEW-SEM-06d/e`。
**Artifacts**: `meta/docs/sota-monorepo-architecture-2026-03-06.md` 增加 Batch 11+ map + dependency graph；`meta/REDESIGN_PLAN.md` 与 `meta/remediation_tracker_v1.json` 同步排期窗口。

### [2026-03-06] Batch 11 scope split: `NEW-RT-06` 完整做，`NEW-DISC-01` 只做 kickoff

**Context**: 需要把 `NEW-DISC-01` / `NEW-RT-06` 进一步细化成可执行子任务，并产出 Batch 11 implementation prompt。
**Decision**:
- `NEW-RT-06` 定位为 Batch 11 可完整收口项：`ChatBackend` interface → Anthropic adapter → routing registry schema/loader → AgentRunner migration → regression tests。
- `NEW-DISC-01` 定位为 Batch 11 kickoff only：D1=`openalex_id` schema foundation，D2=provider capability schema，D3=discovery scaffold；D4/D5（canonicalization/dedup artifacts + eval closeout）延后到 Batch 13–14。
- 因此 Batch 11 prompt 采用 **3 工作面**：`NEW-SEM-02`（主 gate item）+ `NEW-RT-06`（本批完成）+ `NEW-DISC-01 kickoff`（本批进入 in_progress，不关闭总 item）。
**Artifacts**: `meta/REDESIGN_PLAN.md` 新增 subtasks + acceptance checklist；新增 `meta/docs/prompts/prompt-phase3-impl-batch11.md`。

### [2026-03-06] Monorepo 主干重心重释：single-user research loop first，Agent-arXiv/REP later

**Context**: 在重新审视 `packages/hep-autoresearch/docs/VISION.zh.md`、`meta/REDESIGN_PLAN.md` 与 `meta/docs/track-a-evo17-rep-sdk-design.md` 后，明确了当前近中期主产品并不是 Agent-arXiv 社区，而是“给单个研究者使用、可交互或接收初始指令后继续自治”的自动研究系统。真实研究过程天然是非线性的：文献搜索、idea 生成/筛选、计算、写作、审稿修订之间允许频繁回跳和分叉。
**Decision**:
- monorepo 近中期主干改为 **single-user nonlinear research loop**；`idea/literature/derivation/writing/revision` 只是 UX 导航标签，不是执行内核的强状态机。
- 新增 `NEW-LOOP-01`（Phase 3 precursor），在 `orchestrator` 中先建立 `ResearchWorkspace` / event-task graph / shared interactive-autonomous substrate，再让 `EVO-01/02/03` 在其上接入 compute / feedback / writing automation。
- `Agent-arxiv` 与 `REP` 维持长期愿景与后期 outer-layer 定位：前者负责社区化发布/引用/演化，后者负责 evolution/publication protocol；二者不得反向定义近中期 v1 单研究者运行时。
- 现有 SOTA retrieval/discovery/routing follow-up（`NEW-DISC-01`, `NEW-RT-06/07`, `NEW-SEM-06-INFRA/b/d/e`）保持不变，但其价值现在明确服务于 single-user research loop 主产品，而不是提前服务社区化层。
**Artifacts / linkage**:
- `meta/docs/sota-monorepo-architecture-2026-03-06.md` 追加 single-user loop first 架构主线与 REP/Agent-arXiv 边界说明。
- `meta/REDESIGN_PLAN.md` 升级到 `v1.9.2-draft`，新增 `NEW-LOOP-01`，并把 `EVO-01/02/03` 改写为建立在该 precursor 之上。
- `meta/remediation_tracker_v1.json` 同步登记 `NEW-LOOP-01`；`AGENTS.md` 当前进度同步为 Phase 3 `16/49`。

### [2026-03-06] Batch 11 implementation closeout: `NEW-SEM-02` done, `NEW-RT-06` done, `NEW-DISC-01` kickoff only

**Context**: Executed `meta/docs/prompts/prompt-phase3-impl-batch11.md` on top of the clarified v1.9.2 Phase 3 plan. The batch had to close `NEW-SEM-02` and `NEW-RT-06` without pulling `NEW-RT-07` / `NEW-SEM-06-INFRA` forward, while only kicking off `NEW-DISC-01` D1/D2/D3.
**Decision**:
- `NEW-SEM-02` now lands as a structured claim→evidence→stance SoT in `packages/hep-mcp/`: claim extraction and external evidence assessment are LLM-first via MCP sampling/`ctx.createMessage`, while deterministic heuristics stay as guard/fallback only. Legacy evidence-grading output remains supported for downstream callers.
- `NEW-RT-06` closes as **orchestrator-plane-only** routing: `AgentRunner` depends on `ChatBackend` + backend factory + JSON-validated routing registry; provider SDK imports are isolated in the Anthropic adapter; `model` now means requested route/use-case key; default single-route config preserves prior behavior. `NEW-RT-07` remains the separate host-side MCP sampling router.
- `NEW-DISC-01` remains **kickoff only** in Batch 11: D1=`openalex_id` shared identifier foundation, D2=shared provider capability schema, D3=discovery planner scaffold. Canonicalization/dedup/search-log/eval closeout (D4/D5) stay deferred to Batch 13–14, and no discovery MCP server is introduced in this batch.
**Amendments adopted**:
- Keep discovery library-first / shared-contract-first rather than introducing a new broker server early.
- Keep routing split by plane: orchestrator runtime now, host-side MCP sampling later.
- Keep `NEW-SEM-02` LLM-first with conservative fallback + backward-compatible output shape.
**Amendments not adopted (deferred by design)**:
- No `packages/scholar-broker/` extraction yet; the shared-library scaffold is sufficient for D1/D2/D3.
- No `NEW-RT-07` implementation in this batch; host-side MCP sampling routing remains a separate follow-up.
- No `NEW-SEM-06-INFRA` / retrieval-lane work in this batch; Batch 11 remains scoped to SEM-02 + RT-06 + DISC-01 kickoff.
**Validation**:
- `pnpm --filter @autoresearch/shared test`
- `pnpm --filter @autoresearch/shared build`
- `pnpm --filter @autoresearch/orchestrator test`
- `pnpm --filter @autoresearch/orchestrator build`
- `pnpm --filter @autoresearch/hep-mcp test:eval`
- `pnpm --filter @autoresearch/hep-mcp test`
- `pnpm --filter @autoresearch/hep-mcp build`
**Artifacts / linkage**: Tracker updated so `NEW-SEM-02` and `NEW-RT-06` are `done`, while `NEW-DISC-01` stays `in_progress` with D1/D2/D3 recorded as complete. The locked eval baseline is `packages/hep-mcp/tests/eval/baselines/sem_02_evidence_claim_grading.baseline.json`.

### [2026-03-06] Batch 11 implementation formal review: Opus + K2.5 converged, 0 blocking

**Context**: After Batch 11 implementation landed, the code itself (not just the architecture prompt) was formally reviewed via `review-swarm` using `claude/opus` + `kimi-for-coding/k2p5`. The review packet covered the Batch 11 diff, prompt constraints, and acceptance results.
**Decision**:
- Treat the batch as implementation-review converged with no blocking issues.
- Adopt the high-value amendments that are clearly low-risk and scoped: `SEM-02` parser guardrails for malformed sigma values, cache-mode clarifying comments in claim extraction, baseline-note clarification for mock-response eval metrics, and the orchestrator default max-token constant correction from `8096` to `8192`.
- Keep larger token budgets as a routing-config concern rather than changing the unconfigured fallback into an aggressive global default; `max_tokens` remains overridable per route/use case.
**Adopted amendments**:
- `extractSigmaLevel` now parses optional negative forms and rejects non-finite / non-positive / absurdly large sigma values as input-hygiene guardrails only, not as a semantic classifier.
- `hasNegationBefore` reverts to the previous 15-character local window to avoid an undocumented semantic drift in heuristic fallback behavior.
- `claimExtraction` now documents why heuristic and MCP-sampling caches are separated and why empty/invalid MCP results are not cached under the sampling namespace.
- `DEFAULT_CHAT_MAX_TOKENS=8192` is shared between route defaulting and `AgentRunner` fallback.
**Deferred / not adopted**:
- No broader retuning of negation heuristics beyond restoring the pre-refactor local window.
- No global increase of default `max_tokens`; larger budgets should be explicit in routing config so provider/model limits remain caller-controlled.
**Artifacts**: Formal review artifacts live in `.review/batch11-impl-review-2026-03-06/` (gitignored), with normalized summary in `normalized_review_summary.json`.

### [2026-03-06] Batch 12 implementation closeout: `NEW-SEM-03` done, `NEW-SEM-04` done, `NEW-SEM-06-INFRA` done

**Context**: Executed `meta/docs/prompts/prompt-phase3-impl-batch12.md` after Batch 11 had already stabilized `NEW-SEM-02` + `NEW-RT-06` and kicked off `NEW-DISC-01` D1/D2/D3. This batch had to keep the SEM lane intact while closing the next semantics pair and the retrieval substrate/eval freeze, without pulling `NEW-SEM-06b`, `NEW-RT-07`, or `NEW-DISC-01` D4/D5 forward.
**Decision**:
- `NEW-SEM-03` now adds **bundle-level LLM-first stance adjudication** on top of the Batch 11 claim→evidence→stance SoT. `packages/hep-mcp/src/core/semantics/claimBundleSampling.ts` + `claimBundleAdjudicator.ts` introduce a second-stage MCP-sampling authority only for ambiguous / multi-evidence bundles, while `packages/hep-mcp/src/core/semantics/evidenceClaimGrading.ts` continues to reuse the existing `ClaimStanceV1` / `ClaimReasonCodeV1` / `ClaimSemanticGradeV1` schema rather than forking it.
- `NEW-SEM-04` now upgrades theoretical conflict adjudication to **structured rationale v2**. `packages/hep-mcp/src/tools/research/theoreticalConflict/adjudication.ts` parses rationale objects with `summary`, `assumption_differences`, `observable_differences`, and `scope_notes`; `different_scope` is now surfaced explicitly as `adjudication_category: not_comparable` while legacy edge-relation strings remain compatible for existing consumers.
- `NEW-SEM-06-INFRA` closes as a **substrate/eval decision freeze only**. `packages/hep-mcp/src/core/evidenceRetrievalSubstrate.ts` records the baseline lock (`SEM-06a` / `hashing_fnv1a32`), the `NEW-DISC-01` dependency, and the comparison rule (`absolute_delta_and_relative_gain`); `packages/hep-mcp/src/core/evidenceSemantic.ts` only exposes that snapshot in artifacts. No hybrid recall, strong reranker, or late-interaction implementation is introduced here.
**Amendments adopted**:
- Keep `NEW-SEM-03` LLM-first at the bundle adjudication level while leaving heuristics as explicit fallback/diagnostic signals only.
- Keep `NEW-SEM-04` conservative by separating `not_comparable` from real contradiction and by requiring structured rationale instead of prose-only notes.
- After formal review, absorb the low-risk cleanup to reuse the shared `EdgeRelation` guard and remove the redundant double JSON parse path in `theoreticalConflicts.ts`.
**Deferred / not adopted**:
- No schema fork or new stance ontology for `NEW-SEM-03`; Batch 11's claim/evidence/stance SoT remains the single semantic contract.
- No refactor-only dedup of `ClaimAssessmentContext` or the repeated JSON-payload parser yet; these are low-priority cleanup follow-ups, not Batch 12 blockers.
- No behavior change to `relativeGain()` edge handling yet; the current `0` return for zero-baseline/non-positive-improvement remains documented by test usage and is acceptable for the locked eval protocol.
- No `NEW-SEM-06b`, `NEW-RT-07`, or `NEW-DISC-01` D4/D5 work in this batch.
**Validation**:
- `pnpm --filter @autoresearch/hep-mcp test:eval`
- `pnpm --filter @autoresearch/hep-mcp test`
- `pnpm --filter @autoresearch/hep-mcp build`
**Artifacts / linkage**: Tracker updated so `NEW-SEM-03`, `NEW-SEM-04`, and `NEW-SEM-06-INFRA` are `done`; `NEW-DISC-01` remains `in_progress`. GitNexus `detect_changes` reported medium overall worktree risk due mixed local edits, but the indexed affected flow for this batch stayed limited to `queryProjectEvidenceSemantic`. The formal review artifacts live in `.review/batch12-impl-review-2026-03-06/` with normalized summary in `normalized_review_summary.json`.

### [2026-03-06] Batch 12 implementation formal review: Opus + K2.5 converged, 0 blocking

**Context**: After Batch 12 implementation and acceptance passed, the code itself was formally reviewed via `review-swarm` using `claude/opus` + `kimi-for-coding/k2p5` against the implementation prompt, diff, governance constraints, and acceptance commands.
**Decision**:
- Treat Batch 12 as implementation-review converged with no blocking issues.
- Adopt only the clearly low-risk cleanup amendments from review: share the exported `EdgeRelation` guard across prompt/adjudication modules and remove the redundant outer JSON parse before `parseAdjudication()`.
- Defer broader refactor-only amendments (shared `ClaimAssessmentContext`, deduplicated generic JSON-payload parser, and `relativeGain()` edge-case redesign) because they do not affect correctness and would add unrelated churn to a closed batch.
**Artifacts**: Formal review artifacts live in `.review/batch12-impl-review-2026-03-06/` (gitignored), with normalized summary in `normalized_review_summary.json`.



### [2026-03-06] Batch 13 implementation closeout: `NEW-SEM-05` done, `NEW-SEM-09` done

**Context**: Executed `meta/docs/prompts/prompt-phase3-impl-batch13.md` after Batch 12 had already closed `NEW-SEM-03` + `NEW-SEM-04` + `NEW-SEM-06-INFRA`, while `NEW-DISC-01` remained only kickoff/in-progress (D1/D2/D3 complete). This batch had to land the next SEM pair without pulling `NEW-RT-07`, `NEW-DISC-01` D4/D5, or `NEW-SEM-06b` forward.
**Decision**:
- `NEW-SEM-05` now uses **one LLM-first paper/review/content authority**: `packages/hep-mcp/src/core/semantics/paperSemanticClassifier.ts` + `paperSemanticPriors.ts` + `paperSemanticSampling.ts` + `paperSemanticTypes.ts`. `paperClassifier.ts`, `reviewClassifier.ts`, and `criticalQuestions.ts` no longer own independent paper-type/review-type authority; they map from the shared `UnifiedPaperClassification` result instead.
- `NEW-SEM-05` preserves deterministic logic only as priors / routing hints / fallback diagnostics. MCP sampling (`ctx.createMessage`) is threaded through `criticalResearch.ts`, `criticalAnalysis.ts`, `deepResearch.ts`, `synthesizeReview.ts`, and the `inspireResearch.ts` handlers so semantic authority stays host-routed and provider-agnostic.
- `NEW-SEM-09` now uses **LLM-first section-role labeling**: `packages/hep-mcp/src/core/semantics/sectionRoleClassifier.ts` + `sectionRoleSampling.ts` + `sectionRoleTypes.ts`. `deepAnalyze.ts` consumes semantic role labels and maps them back into the legacy `introduction` / `methodology` / `results` / `discussion` / `conclusions` slots through `buildSectionRoleSlots(...)`.
- Combined-role sections (for example `Results and Discussion`) are handled explicitly; `other` and `uncertain` remain first-class outcomes. The fallback path now scores heading + content together rather than letting heading keywords remain authority.
- Stable reuse anchor for later `NEW-SEM-12`: `classifyUnifiedPaperSemantics(...)` + `UnifiedPaperClassification` in `packages/hep-mcp/src/core/semantics/`.
**Amendments adopted**:
- After formal review, `synthesizeReview.ts` now forwards `params._mcp` into the internal `performCriticalAnalysis(...)` calls used during synthesize mode, and `packages/hep-mcp/tests/research/synthesizeReview.test.ts` locks that path.
- `docs/ARCHITECTURE.md` now indexes the new `core/semantics/paperSemantic*.ts` and `core/semantics/sectionRole*.ts` modules so the architecture map matches the codebase.
**Deferred / not adopted**:
- No shared `parseJsonPayload` extraction yet; the duplication across sampling helpers is real but purely refactor-level and not a Batch 13 blocker.
- No extra fallback logging / provenance error-kind enrichment yet; current `used_fallback` + `reason_code` coverage is sufficient for this batch’s acceptance plane.
- No baseline-process README or `referenceYear` injection for priors yet; both are documentation/testability follow-ups rather than correctness gaps.
- No `NEW-RT-07`, `NEW-DISC-01` D4/D5, or `NEW-SEM-06b` work in this batch.
**Validation**:
- `pnpm --filter @autoresearch/hep-mcp test:eval`
- `pnpm --filter @autoresearch/hep-mcp test`
- `pnpm --filter @autoresearch/hep-mcp build`
**Artifacts / linkage**: Tracker updated so `NEW-SEM-05` and `NEW-SEM-09` are `done`. Locked eval artifacts are `tests/eval/evalSem05UnifiedClassifier.test.ts`, `tests/eval/fixtures/sem05/`, `tests/eval/baselines/sem05_unified_classifier.baseline.json`, `tests/eval/evalSem09SectionRoleClassifier.test.ts`, `tests/eval/fixtures/sem09/`, and `tests/eval/baselines/sem09_section_role_classifier.baseline.json`. `NEW-DISC-01` remains `in_progress`; `NEW-RT-07` and `NEW-SEM-06b` remain untouched.

### [2026-03-06] Batch 13 implementation formal review: Opus + K2.5 converged, 0 blocking

**Context**: After Batch 13 implementation and acceptance passed, the code itself was formally reviewed via `review-swarm` using `claude/opus` + `kimi-for-coding/k2p5` against the implementation prompt, changed files, scope constraints, and acceptance evidence.
**Decision**:
- Treat Batch 13 as implementation-review converged with zero blocking issues.
- Adopt only the clearly low-risk amendments that closed a real correctness/threading gap or improved the architecture map: `_mcp` propagation in `synthesizeReview.ts` plus `docs/ARCHITECTURE.md` module indexing.
- Defer refactor/documentation amendments (`parseJsonPayload` dedup, fallback logging, baseline README, deterministic prior year injection) because they do not change Batch 13 correctness and would add unrelated churn to a closed semantic batch.
**Artifacts**: Formal review artifacts live in `.review/batch13-impl-review-2026-03-06/` (gitignored), with normalized summary in `normalized_review_summary.json`.



### [2026-03-07] EVO-13 formal implementation prompt should wait for NEW-LOOP-01 stabilization

**Context**: After clarifying the three-layer architecture (`NEW-LOOP-01` substrate → `EVO-13` team runtime → `EVO-15/16` community), the next risk is procedural: drafting an `EVO-13` implementation prompt too early would force the team runtime to target unstable substrate contracts, while waiting too long could cause the design memo to be forgotten.
**Decision**:
- Keep `meta/docs/2026-03-07-evo13-single-project-multi-agent-runtime-memo.md` as the design SSOT for future `EVO-13` prompt authoring.
- Do **not** draft the full `EVO-13` implementation prompt until `NEW-LOOP-01` has passed full closeout (acceptance + review-swarm + self-review + sync) and its substrate contract is stable enough for team-runtime consumption.
- Treat the following as the minimum prompt-activation trigger: stable `ResearchWorkspace` / `ResearchTask` / `ResearchEvent` / `ResearchCheckpoint`, plus finalized `source` / `actor_id`, typed handoff stubs, and task injection seam.
- Future `NEW-LOOP-01` closeout and future `EVO-13` prompt must both backlink this memo so the design is not lost across sessions.
**Design linkage**: `meta/docs/2026-03-07-evo13-single-project-multi-agent-runtime-memo.md`; `meta/docs/2026-03-07-openclaw-loop01-research-outline.md`; `meta/docs/2026-03-07-single-user-multi-agent-runtime-sota.md`.

### [2026-03-07] `single-user` means single governing user, not single agent

**Context**: Follow-up clarification while deepening the `NEW-LOOP-01` OpenClaw runtime research outline. The phrase `single-user research loop first` was at risk of being misread as “the system should stay single-agent until community-scale Agent-arXiv arrives”. That reading is too restrictive and conflicts with both the existing `research-team` capability and the intended Phase 5 evolution toward team execution.
**Decision**:
- Interpret `single-user` as **single human owner / principal investigator / governing control plane**, not “exactly one active agent”.
- Keep `NEW-LOOP-01` focused on the **single-user, single-project runtime substrate**: `ResearchWorkspace`, task/event graph, checkpoint, intervention, and shared interactive/autonomous loop semantics.
- Treat **multi-agent collaboration inside one research project** as the next layer up, not as a distant community-only concern. A single project may later host multiple collaborating agents (for example literature scout, compute delegate, reviewer, draft improver) under one user’s governance.
- Reserve the **full team-execution runtime**—nested delegation, A2A/session messaging, team checkpoints, cascade stop, structured delegation—for `EVO-13` rather than pulling it into `NEW-LOOP-01`.
- Reserve **community-scale multi-team infrastructure**—Agent-arXiv, registry/reputation/publication/evolution layers—for `EVO-15/16`.
**Implication**:
- Architecture should now be read as a three-layer progression: `NEW-LOOP-01` (single-user project substrate) → `EVO-13` (multi-agent team execution inside a project) → `EVO-15/16` (community of multiple agent research teams).
- Future prompts and reviews must not conflate `single-user` with `single-agent`, but they also must not use that clarification to smuggle `EVO-13` runtime scope into `NEW-LOOP-01`.
**Design linkage**: `meta/docs/2026-03-07-openclaw-loop01-research-outline.md` §13–§15; `meta/REDESIGN_PLAN.md` `NEW-LOOP-01`, `EVO-13`, `EVO-15`, `EVO-16`.

### [2026-03-06] Implementation prompts inherit hard gates: GitNexus freshness first, deep review-swarm required

**Context**: Batch 14 prompt tightening exposed a recurring failure mode: implementation prompts and follow-up sessions could mention GitNexus and review-swarm, but the requirements were not yet institutionalized as project-wide default gates. That forced repeated human reminders about when to refresh GitNexus, how deep final review must be, and when version-control finalization is allowed.
**Decision**:
- All future implementation prompts (`meta/docs/prompts/prompt-*-impl-*.md`) inherit a shared checklist in `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md`.
- **GitNexus freshness is a pre-implementation gate**, not a post-hoc review nicety: read `gitnexus://repo/{name}/context` first, and if the index is stale run `npx gitnexus analyze` before editing.
- **GitNexus refresh becomes a conditional pre-review gate** whenever implementation changes make the current index unrepresentative of the working tree; post-change `detect_changes` / `impact` / `context` evidence should feed the final review packet.
- Formal implementation `review-swarm` is now the default closeout gate for implementation prompts. The review must inspect concrete code paths, call chains, tests, eval fixtures/baselines, and scope boundaries; superficial diff-only review is not acceptable.
- Implementation items cannot be marked `done` until acceptance commands pass, review-swarm converges with dual-review `0 blocking`, and tracker / memory / `AGENTS.md` sync is complete.
- `git commit` / `git push` remain human-authorized actions only, but once explicitly authorized they are allowed **after** the full closeout gate above; `.review/` artifacts remain gitignored and out of commits.
**Artifacts / linkage**: `AGENTS.md` now records the hard-gate policy; `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md` becomes the reusable prompt authoring baseline; `prompt-phase3-impl-batch14.md` explicitly inherits that checklist.


### [2026-03-07] Batch 14: shared semantic grouping + structured challenge extraction

**Context**: Phase 3 Batch 14 closes `NEW-SEM-10` and `NEW-SEM-13`, both of which audited as keyword / threshold heuristics acting as semantic authority in `hep-mcp` synthesis flows.
**Decision**:
- `NEW-SEM-10` consolidates topic + methodology grouping into one shared semantic authority: `packages/hep-mcp/src/tools/research/synthesis/collectionSemanticLexicon.ts` + `collectionSemanticGrouping.ts`. `analyzePapers.ts::extractTopics` and `grouping.ts::{groupByMethodology,groupForComparison}` now consume the same grouping result instead of drifting independently.
- `CollectionAnalysis.topics` keeps the legacy outward shape (`keywords`, `paper_count`, `representative_papers`) even though the underlying authority is now semantic clustering; consumer compatibility is preserved while the semantic SoT moves under the hood.
- `NEW-SEM-13` introduces structured challenge authority in `challengeLexicon.ts` + `challengeExtraction.ts`. `narrative.ts` only renders the extracted result; it no longer owns challenge semantics via ad-hoc `includes()` checks.
- Challenge extraction consumes both paper text and critical-analysis signals (`integrated_assessment.key_concerns`, `recommendations`, `questions.red_flags`) and preserves explicit `detected | no_challenge_detected | uncertain` statuses.
**Validation**: locked eval + baseline + holdout coverage for SEM-10 / SEM-13, targeted regressions, `pnpm --filter @autoresearch/hep-mcp test:eval`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp build`, `pnpm -r build`, plus formal `review-swarm` (Opus + OpenCode kimi-for-coding/k2p5) and final self-review all with `0 blocking`.
**Scope guard**: `NEW-RT-07`, `NEW-DISC-01` D4/D5, `NEW-LOOP-01`, and `NEW-SEM-06b` remain untouched.

### [2026-03-07] Implementation closeout now requires formal self-review in addition to review-swarm

**Context**: External dual review catches many issues, but final delivery still depended on the executing agent informally deciding whether review evidence, GitNexus traces, and acceptance gates were sufficient. The user explicitly requested that agent self-review become a fixed project hard requirement rather than an ad-hoc extra step.
**Decision**:
- All implementation work now requires a formal `self-review` gate **after** external `review-swarm` convergence and **before** tracker/done/commit finalization.
- Self-review must inspect actual code, key callers / flows, post-change GitNexus evidence (`detect_changes`, plus `impact` / `context` when relevant), tests / eval / holdout / baseline coverage, and scope discipline.
- If self-review finds a blocking issue, it must be fixed before completion; external review convergence alone is not enough to declare done.
- Project-level governance is recorded in both `AGENTS.md` and `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md` so future implementation prompts inherit the rule automatically.


### [2026-03-07] NEW-WF-01 retro-closeout: workflow schema is a real substrate prerequisite

**Context**: `NEW-LOOP-01` hard-gate investigation found that `meta/remediation_tracker_v1.json` still marked `NEW-WF-01` as `pending`, which blocked legal start of the single-user loop runtime. However, Batch 10 had already landed `meta/schemas/research_workflow_v1.schema.json` plus the three workflow templates in commit `c63697d`.
**Decision**:
- Treat `NEW-WF-01` as a legitimate completed prerequisite after backfilling dedicated regression coverage instead of re-implementing the item.
- Add `packages/hep-mcp/tests/core/researchWorkflowSchema.test.ts` to lock the draft-2020 schema, the three shipped workflow templates, all four documented entry-point variants, and graph-reference integrity.
- Record the tracker state as a retro-closeout on 2026-03-07 rather than leaving `NEW-LOOP-01` blocked on stale bookkeeping.
**Implication**:
- Future `NEW-LOOP-01` work can rely on `research_workflow_v1` / workflow-template artifacts as an already-landed prerequisite.
- Do not reopen `NEW-WF-01` unless the workflow schema contract itself changes; the follow-up work belongs in the runtime substrate (`NEW-LOOP-01`), not in re-litigating the schema baseline.


### [2026-03-07] NEW-LOOP-01 closeout: single-user research substrate lands before EVO-13

**Context**: `NEW-LOOP-01` was promoted as the near-term execution kernel for the product, but the branch still lacked a concrete workspace/task/event substrate in `packages/orchestrator/`. The implementation prompt also required a strict boundary: land a reusable single-user / single-project substrate now, but do **not** prematurely pull in `EVO-13` multi-agent runtime scope.
**Decision**:
- Land `packages/orchestrator/src/research-loop/` as the substrate authority with explicit `ResearchWorkspace`, `ResearchNode`, `ResearchEdge`, `ResearchTask`, `ResearchEvent`, `ResearchCheckpoint`, `LoopIntervention`, and typed `ResearchHandoff` abstractions.
- Use one in-memory `ResearchLoopRuntime` for both interactive and autonomous modes; mode differences are policy-only (`ResearchLoopPolicy`), not a forked state model.
- Make nonlinear loop semantics first-class via explicit allowed follow-ups/backtracks (`compute -> literature|idea`, `review -> evidence_search`, `finding -> draft_update`) rather than mutating a stage enum.
- Leave future extension seams in place (`appendDelegatedTask`, typed handoffs for compute/feedback/literature/review/writing) without implementing `EVO-13` session lifecycle, multi-agent coordination, or A2A execution.
- Keep `UX-06` stage labels as UX taxonomy only; execution truth now lives in workspace/task/event state.
**Validation / governance**:
- Acceptance passed: `pnpm --filter @autoresearch/hep-mcp test -- tests/core/researchWorkflowSchema.test.ts`, `pnpm --filter @autoresearch/orchestrator test`, `pnpm --filter @autoresearch/orchestrator build`, `pnpm -r test`, `pnpm -r build`.
- GitNexus post-change gate was executed (`npx gitnexus analyze --force`, `detect_changes`, `context`, Cypher spot checks). The graph still failed to surface newly added unstaged `research-loop/*` files, so closeout relied on both GitNexus evidence for the tracked entry surface and direct source inspection for the new substrate files.
- Formal external review used the user-fixed pair `Opus` + `OpenCode(kimi-for-coding/k2p5)` and converged in two rounds (`R1 CONVERGED_WITH_AMENDMENTS`, `R2 CONVERGED`, both 0 blocking). The low-risk API-contract amendments from R1 were integrated before the final rerun.
- Formal self-review also passed with 0 blocking.
**Scope guard**:
- `NEW-RT-07`, `NEW-DISC-01` D4/D5, `NEW-SEM-06b/d/e`, and `EVO-13` remain out of scope.
- The substrate is now stable enough for future consumers (`EVO-01/02/03`, eventually `EVO-13`) to extend it instead of inventing a parallel project-state model.

### [2026-03-07] Root instruction consolidation: AGENTS is SSOT, root CLAUDE is shim, Serena project config is local-only

**Context**: Root `CLAUDE.md` and `.serena/project.yml` were producing repeated worktree noise. `CLAUDE.md` must stay a compatibility shim rather than a second root rulebook, while `.serena/project.yml` is inherently machine/worktree-specific Serena state rather than shared product code. GitNexus also currently upserts generated appendix blocks into root instruction files, so the repository needs an explicit policy for those markers instead of relitigating them in every batch.
**Decision**:
- `AGENTS.md` remains the only root-level SSOT for repository-wide human-authored agent rules.
- Root `CLAUDE.md` is reduced to a stable compatibility shim for older prompts / Claude-oriented discovery; it does not own a second human-maintained root rulebook.
- `.serena/project.yml` is treated as local-only configuration and removed from Git tracking; the tracked template is `.serena/project.example.yml`.
- GitNexus-generated appendix blocks in root `AGENTS.md` / `CLAUDE.md` are accepted into the commit surface, but they are tool-generated non-SSOT context rather than authoritative governance text. Human-authored root policy should live outside those generated marker blocks.
**Implication**:
- Future sessions should stop debating `CLAUDE.md` and `.serena/project.yml` as routine dirty-state noise, and should not treat generated appendix content as the authoritative rule source.
- If Serena setup changes are desired, update `.serena/project.example.yml` and let each worktree keep its own `.serena/project.yml`.
- If an old prompt says “read root `CLAUDE.md`”, interpret that as “read `AGENTS.md` first”, then use the shim only as a redirect.

### [2026-03-07] Worktree cleanup requires Serena memory migration before removal

**Context**: `gitignore` only controls Git tracking; it does not protect local Serena memories from being lost when an implementation worktree is deleted. Batch worktrees often accumulate useful `.serena/memories/*` context that is not yet promoted into tracked governance artifacts, so direct `git worktree remove` would silently discard it.
**Decision**:
- Before removing any non-main worktree, audit that worktree’s `.serena/memories/` contents explicitly.
- Durable governance conclusions must be promoted into `.serena/memories/architecture-decisions.md` and committed as part of closeout.
- Reusable but local-only memories that should remain available for future development must be copied into the surviving target worktree’s `.serena/memories/`.
- Only scratch notes, cache-like artifacts, and one-off thoughts with no expected reuse may be discarded with the removed worktree.
**Implication**:
- Worktree cleanup checklists must treat Serena memory migration as a real closeout gate, not an optional courtesy.
- The real risk is deleting the worktree directory, not `.gitignore`; memory preservation must therefore happen before merge cleanup.


### [2026-03-07] NEW-RT-07 closeout: host-side MCP sampling routing stays on the host

**Context**: `NEW-MCP-SAMPLING` had already landed the server-side `ctx.createMessage` foundation in `hep-mcp`, but host-side routing governance was still missing. The standalone `NEW-RT-07` prompt explicitly required finishing Plane 2 without reopening `NEW-RT-06`, pulling in `NEW-LOOP-01`, or starting the discovery / retrieval follow-up lanes.
**Decision**:
- Plane 2 routing authority now lives on the MCP host (`packages/orchestrator/src/mcp-client.ts`, `mcp-jsonrpc.ts`, `mcp-server-request-handler.ts`, `sampling-handler.ts`, `routing/sampling-{types,schema,loader}.ts`). MCP servers still emit only stable metadata; they do not read routing config and do not self-select models.
- The shared metadata contract is centralized in `packages/shared/src/sampling-metadata.ts` with strict validation over `module`, `tool`, `prompt_version`, `risk_level`, and `cost_class`, and it explicitly rejects route/model/backend hints in metadata context.
- `hep-mcp` consumers now use `packages/hep-mcp/src/core/sampling-metadata.ts::buildToolSamplingMetadata(...)` so claim extraction, evidence grading, bundle adjudication, quantity adjudication, and theoretical conflicts all emit the same host-routable metadata shape.
- Route resolution, chosen route, fallback attempts, and terminal failure are part of the structured audit surface through `mcp_client.sampling_*` ledger events.
**Validation / governance**:
- Acceptance passed: `pnpm --filter @autoresearch/shared test`, `pnpm --filter @autoresearch/shared build`, `pnpm --filter @autoresearch/orchestrator test`, `pnpm --filter @autoresearch/orchestrator build`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp build`, `pnpm lint`, `pnpm -r test`, `pnpm -r build`.
- GitNexus post-change gate was refreshed with `npx gitnexus analyze --force`; `detect_changes` reported low risk, and `context`/`impact` checks on `McpClient`, `extractClaimsFromAbstract`, `gradeClaimAgainstEvidenceBundle`, and `performTheoreticalConflicts` matched the intended call graph with no unexpected upstream blast radius.
- Formal external review used the required pair `Opus` + `OpenCode(kimi-for-coding/k2p5)` and converged in one round with 0 blocking. Formal self-review also passed with 0 blocking. Deferred non-blocking amendments: extra negative-path JSON-RPC handler tests, broader forbidden-context-key coverage, and future metadata size/redaction hardening.
**Scope guard**:
- `NEW-DISC-01` D4/D5, `NEW-SEM-06b/d/e`, `NEW-LOOP-01`, and `EVO-13` remain untouched in this closeout.

### [2026-03-07] NEW-DISC-01 closeout: exact-ID-first canonical discovery substrate lands before `NEW-SEM-06b`

**Context**: Batch 11 only shipped the `NEW-DISC-01` kickoff scaffold (`openalex_id`, provider capability SoT, planner/candidate scaffold). Before `NEW-SEM-06b` could legally start, the project still needed a real canonical identity / dedup / search-log contract plus broker-level eval slices that live in the existing shared-library + hep-mcp broker architecture.
**Decision**:
- Keep `NEW-DISC-01` library-first / broker-first: all discovery authority stays under `packages/shared/src/discovery/`, while hep-mcp only adds the consumer `packages/hep-mcp/src/tools/research/federatedDiscovery.ts`; no discovery MCP server is introduced.
- Canonicalization follows an exact-ID-first fail-closed ladder: only shared `doi` / `arxiv_id` / `recid` / `openalex_id` evidence produces `confident_match`; normalized title + author/year agreement only produces `uncertain_match`; insufficient evidence stays unmerged.
- Provenance is mandatory substrate, not optional metadata: canonical papers and dedup artifacts must preserve `source_candidates`, `match_reasons`, `provider_sources`, `merge_state`, and `uncertain_group_key`; search logs remain append-only with artifact locators.
- D5 extends the existing `NEW-RT-05` eval plane rather than creating a parallel harness: deterministic fixtures + locked baseline + optional holdout guard canonicalization/dedup/provider-routing behavior.
**Validation / governance**:
- Acceptance passed on the final state: the full standalone prompt acceptance ladder (`pnpm --filter @autoresearch/shared test/build`, `pnpm --filter @autoresearch/openalex-mcp test/build`, `pnpm --filter @autoresearch/arxiv-mcp test/build`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp test:eval`, `pnpm --filter @autoresearch/hep-mcp build`, `pnpm lint`, `pnpm -r test`, `pnpm -r build`) plus explicit holdout verification with `EVAL_INCLUDE_HOLDOUT=1 pnpm --filter @autoresearch/hep-mcp test -- evalDisc01BrokerCloseout`.
- GitNexus post-change evidence stayed low risk (`detect_changes` low risk, no affected processes; `context`/`impact` on `runFederatedDiscovery`, `canonicalizeDiscoveryCandidates`, `appendDiscoverySearchLogEntries`, `planDiscoveryProviders` all matched the intended narrow blast radius).
- Formal external review used the required pair `Opus` + `OpenCode(kimi-for-coding/k2p5)` and converged in R2 with 0 blocking after fixing the holdout fixture and refreshing the INSPIRE descriptor note. Formal self-review also passed with 0 blocking.
**Scope guard**:
- `NEW-SEM-06b/d/e`, `NEW-RT-06/07`, `NEW-LOOP-01`, and `EVO-13` were not reopened; the closeout only delivers the canonical/discovery substrate those future items depend on.
