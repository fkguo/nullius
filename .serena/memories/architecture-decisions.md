## Cross-Component Architecture Decisions

### [2026-03-13] EVO-01-A bridge invariant: execution plans are audited IR, manifests are materialized execution surfaces

**Context**: `meta/docs/prompts/prompt-2026-03-13-evo01a-compute-bridge.md` closeout (`EVO-01-A` bounded bridge inside `EVO-01`)
**Decision**:
- Staged idea surfaces (`outline_seed_v1.json` plus optional handoff/method hints) must compile first into checked-in `execution_plan_v1`, a provider-neutral audited IR with provenance, task-level capability needs, and expected artifacts.
- `computation_manifest_v1` remains the materialized execution surface. Materializers must consume a validated `execution_plan_v1`; they must not restage `IdeaHandoffC2` / `outline_seed_v1.json` as parallel authority.
- Pre-approval bridge surfaces may write audited plan artifacts, materialized manifests, and non-executable workspace stubs, but they must remain validation-only: completion stops at `dry_run` or `requires_approval`, never at real provider execution, and must fail closed even if A3 is already satisfied.
- Host/provider packages may expose thin bridge adapters, but compiler/materializer authority belongs in the generic orchestrator computation core.
**Why**: This locks the compute lane seam before provider execution lanes land. The stable substrate boundary is staged idea -> audited plan -> materialized manifest -> approval gate, which keeps provider routing out of generic plan authority while preserving future extensibility.
**Files**: `meta/schemas/execution_plan_v1.schema.json`, `packages/orchestrator/src/computation/execution-plan.ts`, `packages/orchestrator/src/computation/materialize-execution-plan.ts`, `packages/orchestrator/src/computation/bridge.ts`, `packages/orchestrator/src/computation/approval.ts`, `packages/hep-mcp/src/tools/plan-computation.ts`

### [2026-03-10] Formalism boundary invariant: formalism is optional run-local metadata, not core contract authority

**Context**: `meta/docs/prompts/prompt-2026-03-10-formalism-contract-boundary.md` closeout (`NEW-05a-formalism-contract-boundary`)
**Decision**:
- Repo-level public schemas and generic runtime must not require a canonical formalism registry, formalism membership gate, or formalism-check handoff field.
- `candidate_formalisms[]` may remain only as optional user/project/run-local method metadata; unknown values must not block `campaign.init`, `search.step`, `node.promote`, or downstream idea handoff consumption.
- Built-in domain packs/provider seams may expose provider-local compilers or execution helpers, but must not ship concrete worldview catalogs such as `hep/toy`, `hep/eft`, or `hep/lattice` as generic authority.
- Public graph/tooling surfaces should not elevate formalism into default first-class nodes/edges or mandatory public contract fields.
**Why**: The substrate’s stable core is question/evidence/artifact/approval/runtime semantics. Method choice is real research content, but it belongs in run-local/provider-local layers rather than repo-wide mandatory authority.
**Files**: `packages/idea-generator/schemas/idea_card_v1.schema.json`, `packages/idea-generator/schemas/idea_handoff_c2_v1.schema.json`, `packages/idea-generator/schemas/promotion_result_v1.schema.json`, `packages/idea-generator/schemas/idea_core_rpc_v1.openrpc.json`, `packages/idea-core/src/idea_core/engine/coordinator.py`, `packages/idea-core/src/idea_core/engine/operators.py`, `packages/idea-core/src/idea_core/engine/retrieval.py`, `packages/idea-core/src/idea_core/engine/hep_builtin_domain_packs.json`, `packages/shared/src/graph-viz/adapters/idea-map.ts`

### [2026-03-10] Shared boundary invariant: shared keeps seams, providers keep concrete authority

**Context**: `meta/docs/prompts/prompt-2026-03-09-batch1-shared-boundary.md` closeout (`NEW-05a-shared-boundary`)
**Decision**:
- `packages/shared/` should keep only provider-agnostic typed seams and cross-package contract helpers.
- Concrete provider-owned authority must live in the owning leaf provider or aggregator package.
- For the HEP lane, this means concrete `HEP_*` tool names, concrete HEP risk maps, and `hep://runs/...` artifact URI wrappers belong in `packages/hep-mcp/`, not in `packages/shared/`.
- Shared may still keep sibling-provider constants when they are used as cross-package contract seams rather than as concrete HEP authority.
**Why**: This keeps the substrate/domain-neutral core from drifting back into HEP authority ownership while still allowing shared contracts that multiple packages compose.
**Files**: `packages/shared/src/tool-names.ts`, `packages/shared/src/tool-risk.ts`, `packages/shared/src/artifact-ref.ts`, `packages/hep-mcp/src/tool-names.ts`, `packages/hep-mcp/src/tool-risk.ts`, `packages/hep-mcp/src/core/runArtifactUri.ts`

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

### [2026-03-09] Root ecosystem boundary: root ≠ product agent

**Context**: After repo-wide de-instancing cleanup and a fresh architecture pass, the monorepo was still root-occupied by `hep-mcp` language while `packages/orchestrator/` had already become the runtime/control-plane nucleus. The key open question was whether the monorepo itself should be turned into a single “true agent” product now.
**Decision**:
- The repo root remains the **ecosystem/workbench/governance** entrypoint, not the product agent.
- `packages/orchestrator/` remains the **runtime/control-plane nucleus**.
- `packages/*-mcp` remain **independent capability providers**; do not build a root super-MCP.
- A future single packaged end-user agent, if needed, must be introduced as a **leaf package** after `P5A` closure and stable provider boundaries; do **not** create that package yet.
- `EVO-13` is runtime unification for a single project / team-local scope, **not** the packaged end-user agent.
**Why**:
- Current biggest risk is boundary drift (`shared` / core / provider path leakage), not missing top-level product packaging.
- Premature root-level agentization would freeze HEP-first residue into long-lived generic abstractions.
- Heavy registry/materializer work is also premature before `P5A` semantics and provider classes stabilize.
**SSOT linkage**:
- ADR: `meta/docs/2026-03-09-root-ecosystem-boundary-adr.md`
- `NEW-05a` constraint: `meta/REDESIGN_PLAN.md`
- `P5A/P5B` productization constraint: `meta/REDESIGN_PLAN.md`
- `EVO-13` non-product-agent constraint: `meta/REDESIGN_PLAN.md`
- `EVO-13` runtime memo: `meta/docs/2026-03-07-evo13-single-project-multi-agent-runtime-memo.md`
**Immediate sequencing**:
1. Re-baseline `shared` boundary (`tool-names`, `tool-risk`, `artifact-ref`)
2. Re-baseline `idea-core` HEP compute/domain leakage before `NEW-05a Stage 3`
3. Re-baseline runtime/provider/root HEP occupancy (env/path/root docs)
4. Execution prompt pack: `meta/docs/prompts/prompt-2026-03-09-rebaseline-batches.md`

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


### [2026-03-08] NEW-SEM-06b closeout: Hybrid candidate generation + canonical-paper reranker

**Context**: After `NEW-DISC-01` D4/D5 closed canonical paper / query-plan / dedup / search-log substrate and `NEW-SEM-06-INFRA` froze the retrieval baseline/eval protocol, Batch 17 had to land the first real retrieval-backbone upgrade without pulling `NEW-SEM-06d` (query reformulation) or `NEW-SEM-06e` (structure-aware localization) forward.
**Decision**:
- Extend shared discovery authority with three new contracts: `DiscoveryCandidateChannel`, `DiscoveryCandidateGenerationArtifact`, and `DiscoveryRerankArtifact`.
- Keep provider-local retrieval as **evidence only**. `packages/hep-mcp/src/tools/research/discovery/candidateAdapters.ts` converts INSPIRE / OpenAlex / arXiv results into `CanonicalCandidate`, and all downstream ranking authority stays in canonical paper space.
- `runFederatedDiscovery(...)` now writes five audited discovery artifacts per request (`query_plan`, `candidate_generation`, `canonical_papers`, `dedup`, `rerank`) plus append-only search log, all via atomic writes under `HEP_DATA_DIR/cache/discovery/`.
- Candidate generation is exact-ID-first, then keyword search, plus optional provider-native semantic search only where the provider actually supports it (currently OpenAlex, gated by `OPENALEX_API_KEY` and suppressed for structured-ID queries).
- Strong reranking is a bounded two-stage path: deterministic canonical-paper prerank followed by top-k MCP-sampling listwise rerank; when reranking cannot run, the artifact must say `unavailable` or `insufficient_candidates` rather than pretending a strong rerank happened.
- `packages/hep-mcp/src/core/evidenceRetrievalSubstrate.ts` now records `strong_reranker_path = canonical_paper_llm_listwise_v1` while leaving `late_interaction_path` explicitly deferred.
**Validation**:
- Acceptance: `pnpm --filter @autoresearch/shared test/build`, `pnpm --filter @autoresearch/openalex-mcp test/build`, `pnpm --filter @autoresearch/arxiv-mcp test/build`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp test:eval`, `pnpm --filter @autoresearch/hep-mcp build`, `pnpm lint`, `pnpm -r test`, `pnpm -r build`.
- Eval lock: `packages/hep-mcp/tests/eval/evalSem06bHybridDiscovery.test.ts` + fixtures/baseline/holdout.
- Formal review: `Opus` + `OpenCode(kimi-for-coding/k2p5)` converged with 0 blocking; self-review also found 0 blocking.
**Deferred / out of scope**:
- No query reformulation / QPP trigger policy yet (`NEW-SEM-06d`).
- No structure-aware evidence localization yet (`NEW-SEM-06e`).
- No new discovery MCP server.
- No follow-up cleanup for generic `precisionAtK()` semantics or provider-error neutral channel labels in this batch.

### [2026-03-08] Governance closeout: high-value non-blocking amendments default to same-batch adoption

**Context**: During `NEW-SEM-06b` closeout, external review surfaced several non-blocking amendments. Human feedback highlighted a governance gap: when high-value non-blocking findings are deferred without a strong rule, they are easy to forget across sessions, especially if they live only in temporary review/self-review artifacts.
**Decision**:
- For implementation closeout, any non-blocking amendment that is **current-batch related, high-value, low-risk, independently verifiable, and does not depend on later phase / lane work** now defaults to **same-batch adoption**.
- `deferred` is now restricted to a narrow set of legal reasons: lane-external work, dependency on later phase / lane (or any later work outside the current batch), pre-existing unrelated debt, required human architecture arbitration, or cases where fix risk clearly outweighs benefit.
- Only deferred items that still have future value may remain deferred, and they must be synced into a **persistent SSOT** (`meta/remediation_tracker_v1.json` entry or checked-in follow-up prompt file). Temporary chat prompts, review/self-review outputs, and scratch notes do **not** count as SSOT.
- Low-value or explicitly rejected non-blocking amendments should be recorded as `declined/closed`, not `deferred`, so backlog hygiene is preserved.
- Self-review recording obligations now explicitly cover all three dispositions: `adopted`, `deferred`, and `declined/closed`.
**Validation / governance**:
- Governance text updated in `AGENTS.md` and `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md`.
- Final wording was re-reviewed with the required owner-approved trio `Opus` + `Gemini` + `OpenCode(kimi-for-coding/k2p5)` and all three returned `CONVERGED` with 0 blocking in the final round.
- This rule intentionally tightens closeout discipline without weakening scope control: low-value nits are not forced into backlog, and only high-value, in-scope, cheap-to-verify amendments are made mandatory in-batch.

### [2026-03-08] Serena memory hygiene: only tracked architectural decisions stay in Git

**Context**: The main worktree accumulated a backlog of local Serena memory files (project overview, style notes, historical review protocol notes, batch handoffs, and operator checklists). They were useful as local session aids, but only `architecture-decisions.md` had durable repo-wide value; the rest created persistent `git status` noise and some files were already stale after governance changes such as the move from dual-review to formal three-model review.
**Decision**:
- `.serena/memories/architecture-decisions.md` remains the **only tracked Serena memory file** in this repository.
- Other Serena memory files under `.serena/memories/` are treated as **local-only working notes** by default and should be ignored by Git.
- Before removing a non-main worktree, any durable/reusable conclusion must still be distilled into `architecture-decisions.md`; raw handoff notes, duplicated command checklists, stale model-protocol notes, and session-specific scratch files should not be promoted automatically.
- When a local Serena memory becomes stale because repo governance changed, the correct action is to delete or rewrite the local note rather than relying on it as policy.
**Validation**:
- `.gitignore` now ignores local Serena memory files while keeping `architecture-decisions.md` tracked.
- The main worktree cleanup removed obsolete local-only memory notes after their durable policy implication was recorded here.


### [2026-03-08] NEW-SEM-06d closeout: Triggered reformulation stays an explicit fail-closed planner layer

**Context**: After `NEW-DISC-01` D4/D5 landed canonical paper / query-plan / dedup / search-log substrate and `NEW-SEM-06b` landed hybrid candidate generation + strong reranker, Batch 18 had to add query reformulation / QPP without skipping ahead to `NEW-SEM-06e` structure-aware localization.
**Decision**:
- Keep `NEW-SEM-06d` library-first / broker-first: no new discovery MCP server, and no retrieval-unit change beyond the existing canonical-paper backbone.
- Discovery now runs an explicit, auditable sequence: probe round -> QPP assessment -> optional single-turn reformulation -> optional second retrieval round -> rerank.
- QPP is policy-only and fail-closed. Exact/structured identifier queries stay on the baseline path by default; unavailable/invalid QPP, unavailable/invalid/abstained reformulation, and budget exhaustion all preserve the original query with explicit typed status + reason codes.
- Shared discovery authority now includes `provider-result-counts` and `query-reformulation-artifact`; append-only search-log entries capture `qpp_status`, `trigger_decision`, `reformulation_status`, `reformulation_sampling_calls`, and `reformulation_count`.
- Eval authority stays inside the existing hep-mcp eval plane: `evalSem06dTriggeredReformulation` plus fixtures/baseline/holdout now lock exact-ID/easy no-trigger, hard-query uplift, QPP unavailable, budget exhausted, invalid reformulation, and abstained reformulation failure paths.
**Validation / governance**:
- Acceptance passed on the final state: `pnpm --filter @autoresearch/shared test/build`, `pnpm --filter @autoresearch/openalex-mcp test/build`, `pnpm --filter @autoresearch/arxiv-mcp test/build`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp test:eval`, `pnpm --filter @autoresearch/hep-mcp build`, `EVAL_INCLUDE_HOLDOUT=1 pnpm --filter @autoresearch/hep-mcp test -- tests/eval/evalSem06dTriggeredReformulation.test.ts`, `pnpm lint`, `pnpm -r test`, `pnpm -r build`.
- GitNexus post-change evidence stayed low risk (`detect_changes` LOW risk; `context`/`impact` on `runFederatedDiscovery` matched the intended narrow blast radius).
- Formal external review converged with `Opus` + `OpenCode(kimi-for-coding/k2p5)` at 0 blocking after the user explicitly approved fallback from a hanging local Gemini agentic review. Formal self-review also passed with 0 blocking, and the adopted low-risk amendments were absorbed in-batch.
**Scope guard**:
- `NEW-SEM-06d` does not introduce page/chunk/table/figure/equation/citation-context localization (`NEW-SEM-06e`), late-interaction substrate migration, or unconditional multi-query expansion.

### [2026-03-08] NEW-SEM-06e closeout: structure-aware evidence localization stays layered on the retrieval backbone

**Context**: After `NEW-DISC-01` D4/D5 landed canonical paper / query-plan / dedup / search-log substrate, `NEW-SEM-06b` landed hybrid candidate generation + strong reranker, and `NEW-SEM-06d` added QPP / triggered reformulation, Batch 19 had to upgrade retrieval from document/chunk hits to within-document typed localization without reopening discovery-server or runtime-substrate scope.
**Decision**:
- `NEW-SEM-06e` remains a typed localization layer on top of existing retrieval. It does not replace canonical-paper discovery, reranking, or QPP infrastructure.
- Shared authority now includes `EvidenceLocalization{Unit,Status,Surface,CrossSurfaceStatus,ReasonCode,Hit,Telemetry,Artifact}` in `packages/shared/src/discovery/evidence-localization.ts`, and hep-mcp `QueryEvidenceHit` now carries optional localization metadata.
- `queryProjectEvidenceSemantic` now loads both LaTeX and PDF writing-evidence surfaces, merges them into one semantic candidate pool, and records typed localization artifacts with strict `localized` / `fallback_available` / `unavailable` / `abstained` semantics.
- Localization prioritizes exact requested units over coarse fallbacks, uses paper-aware PDF support matching (`paper_id` filter when available), and keeps missing/ambiguous cross-surface support fail-closed instead of fabricating precision.
- Named localization policy constants now live in `packages/hep-mcp/src/core/evidence-localization/scoring.ts`; end-to-end failure-path coverage now includes `evalSem06eFailureModes.test.ts` for the unavailable-without-PDF-page path in addition to the main eval baseline + holdout.
**Validation / governance**:
- Acceptance passed: `pnpm --filter @autoresearch/shared test/build`, `pnpm --filter @autoresearch/openalex-mcp test/build`, `pnpm --filter @autoresearch/arxiv-mcp test/build`, `pnpm --filter @autoresearch/hep-mcp test -- tests/research/latex/locator.test.ts`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp test:eval`, `pnpm --filter @autoresearch/hep-mcp build`, `pnpm lint`, `pnpm -r test`, `pnpm -r build`, plus targeted SEM-06e revalidation and holdout reruns after adopted review amendments.
- GitNexus post-change evidence stayed narrow: `detect_changes` highlighted `queryProjectEvidenceSemantic`; `context(queryProjectEvidenceSemantic)` confirmed the intended projectCore entrypoint and semantic-query dependencies; upstream `impact(queryProjectEvidenceSemantic)` stayed `LOW`.
- Formal external review used the required trio `Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(kimi-for-coding/k2p5)` and returned 0 blocking (`CONVERGED` / `CONVERGED_WITH_AMENDMENTS`). Adopted low-risk amendments: named scoring constants, `paper_id`-aware PDF support filtering, typed reason-code union, clarified `unavailable_hits` semantics, and explicit end-to-end unavailable-path coverage. Formal self-review also passed with 0 blocking.
**Scope guard**:
- `NEW-SEM-06e` still does not introduce a new discovery MCP server, late-interaction substrate, runtime productization, or `agent-arxiv` search-heavy behavior.

### [2026-03-08] NEW-SEM-06f closeout: multimodal retrieval must stay a bounded page-native fusion layer

**Context**: After `NEW-SEM-06e` landed typed structure-aware localization, the optional `NEW-SEM-06f` follow-up was only justified if it could add real page-native uplift without reopening discovery substrate, parser/OCR, or runtime scope.
**Decision**:
- `NEW-SEM-06f` closes as a **query-triggered multimodal fusion layer** over existing `pdf_page` / `pdf_region` writing-evidence artifacts, not as a new multimodal index or discovery substrate.
- Shared authority now includes `packages/shared/src/discovery/evidence-multimodal.ts` with typed `applied` / `skipped` / `unsupported` / `disabled` / `abstained` artifact semantics and auditable telemetry.
- hep-mcp keeps multimodal routing bounded: `packages/hep-mcp/src/core/evidence-multimodal/policy.ts` gates on page-native query intent + `HEP_ENABLE_MULTIMODAL_RETRIEVAL`; `fusion.ts` supplements/boosts only exact requested visual units and uses `preferred_unit` only for explicitly promoted candidates.
- We explicitly rejected a broader design where every `pdf_region` would be globally reinterpreted as `figure/table/equation` based on metadata label. That would have bypassed the capability gate and would have leaked `06f` semantics into the base `06e` localization layer.
- The honest `SEM-06f` eval fixture must remain **page-native**. The final fixture removes unrelated exact-unit LaTeX structures so unavailable/disabled paths are tested against the intended PDF-native benchmark rather than passing because of generic LaTeX figure/table/equation environments.
**Validation / governance**:
- Acceptance passed: `pnpm --filter @autoresearch/shared test/build`, `pnpm --filter @autoresearch/openalex-mcp test/build`, `pnpm --filter @autoresearch/arxiv-mcp test/build`, `pnpm --filter @autoresearch/hep-mcp test -- tests/core/pdfEvidence.test.ts`, `pnpm --filter @autoresearch/hep-mcp test`, `pnpm --filter @autoresearch/hep-mcp test:eval`, `EVAL_INCLUDE_HOLDOUT=1 pnpm --filter @autoresearch/hep-mcp test -- tests/eval/evalSem06fMultimodalScientificRetrieval.test.ts`, `pnpm --filter @autoresearch/hep-mcp build`, `pnpm lint`, `pnpm -r test`, `pnpm -r build`.
- GitNexus post-change evidence stayed narrow: `detect_changes` on repo `autoresearch-lab-sem06f` returned LOW risk; `context(queryProjectEvidenceSemantic)` preserved the existing semantic-query entrypoint/call graph; upstream `impact(queryProjectEvidenceSemantic)` stayed LOW.
- Formal external review via `Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(kimi-for-coding/k2p5)` returned 0 blocking. One low-value non-blocking amendment (export/unit-test `parseEnabledFlag`) was declined/closed because disabled-path behavior is already covered end-to-end and exporting the helper would widen internal API surface without changing correctness. Formal self-review also passed with 0 blocking.
**Scope guard**:
- `NEW-SEM-06f` does not create a new multimodal retrieval substrate, new parser/OCR/indexing stack, or search-heavy `agent-arxiv` lane. Future work should only revisit heavier multimodal retrieval if a later prompt explicitly reopens that scope.

### [2026-03-10] Formalism is not core authority: treat it as optional run-local method metadata

**Context**: During the standalone `NEW-05a-idea-core-domain-boundary` batch, the local code cleanup successfully pushed some HEP default-worldview logic behind the domain-pack seam, but a deeper repo-level contract problem remained: public schemas and runtime gates still required `candidate_formalisms[]`, `formalism_registry`, and `formalism_check`, and the HEP built-in pack still shipped concrete ids like `hep/toy`, `hep/eft`, and `hep/lattice` as if they were canonical authority. A 2026-03-10 SOTA/code review across `AI-Scientist-v2`, `PiFlow`, `Agent Laboratory`, and `AIDE` confirmed a different pattern: the core substrate centers on problem/task/evidence/runtime, while method/formalism choices stay task-local or runtime-local rather than becoming preinstalled worldview catalogs.
**Decision**:
- Core/public contracts must not require `candidate_formalisms[]`, `formalism_registry`, or `formalism_check` as mandatory mainline gates.
- `formalism`-like method information may exist only as optional, non-gating, project/run-local metadata until a future explicit `method_spec -> execution_plan` contract is introduced.
- Domain packs/providers expose capabilities, data/tool connectivity, and execution/evidence seams; they do not own canonical shipped concrete formalism-instance authority.
- Stable `domain_pack_id` remains acceptable as an audit/replay/explicit-selection reference key, but it must not imply a pack-bundled worldview catalog.
- Concrete approach/formalism names should live only in user input, project/run context, demo/test fixtures, or clearly provider-local non-authoritative templates.
**Impact**:
- `NEW-05a-idea-core-domain-boundary` closeout stays blocked until the follow-up prompt `meta/docs/prompts/prompt-2026-03-10-formalism-contract-boundary.md` removes the repo-level contract leakage.
- `batch3` runtime/root/provider de-HEP cleanup should happen only after this formalism-contract follow-up, because batch3 alone cannot clean the user-facing tool ecology.

### [2026-03-11] NEW-SEM-08 packet curation invariant: auditable candidates first, semantic authority second, deterministic guards last

**Context**: `meta/docs/prompts/prompt-2026-03-11-batch15-sem08-packet-curation.md` closeout (`NEW-SEM-08`) across `skills/research-team` and `skills/research-writer`
**Decision**:
- Python-side packet curation must use a three-layer contract: deterministic expansion/ranking over auditable candidate units -> semantic adjudication over those candidates -> deterministic replay/fail-closed render plan.
- Headings, keyword hits, section order, and similar lexical signals may remain only as candidate hints/provenance; they must not be the final authority for which section/paragraph is treated as critical.
- The stable public artifact is the structured selection record (`selection_kind`, adjudicator state, per-candidate `selected|rejected|uncertain|abstained`, semantic tags, rationale, failure state, render plan), not free-text model commentary.
- Failures must stay explicit and fail-closed: unavailable/invalid adjudication yields labeled fallback or `none`, never a fabricated semantic hit.
**Why**: SOTA review for packet/paragraph selection supported LLM adjudication for semantic criticality, while JSON/schema/replay literature supported keeping determinism at the artifact-contract layer rather than at the semantic-authority layer.
**Files**: `skills/research-team/scripts/lib/semantic_packet_curator.py`, `skills/research-team/scripts/bin/build_draft_packet.py`, `skills/research-writer/scripts/bin/research_writer_learn_discussion_logic.py`, `skills/research-team/tests/test_semantic_packet_curator.py`, `skills/research-team/tests/test_build_draft_packet_semantic_selection.py`, `skills/research-team/tests/test_discussion_logic_semantic_selection.py`

### [2026-03-14] Scaffold naming invariant: project-root entry surfaces use direct role names, not legacy process names

**Context**: Rewriting the `UX-01` + `UX-05` implementation prompt for the host-agnostic single-user entry layer. The user explicitly required plain-language wording such as `新建项目规则` and clarified that the repo is in a refactor-only phase with no short-term compatibility burden.
**Decision**:
- Project-root / scaffold / user-facing entry names should describe role directly rather than historical workflow lineage or template history.
- During the current refactor, obviously wrong scaffold-surface names should be **directly renamed without compatibility aliases** unless there is concrete evidence that direct rename would materially reduce execution quality.
- Human primary file = `research_notebook.md`; machine-stable project contract = `research_contract.md`.
- Legacy scaffold names such as `Draft_Derivation.md`, `PROJECT_CHARTER.md`, `PROJECT_MAP.md`, `PREWORK.md`, `INITIAL_INSTRUCTION.md`, and `INNOVATION_LOG.md` should be treated as rename targets rather than preserved surfaces.
- Prompt wording for this lane should prefer plain-language Chinese when precision is unchanged; `新建项目规则` is preferred over `project bootstrap semantics`.
- Naming audits for this lane are **bounded**: scan the scaffold/project-root surface and the files users are directly told to touch, not the entire repository.
**Why**: The product has not been released, so preserving legacy scaffold names adds long-term architecture drag without offsetting user-compatibility value. Direct role-based names reduce future drift across hosts and make later TS control-plane work cleaner. Plain-language prompt wording lowers execution ambiguity without changing scope.
**Files**: `meta/docs/prompts/prompt-2026-03-14-ux01-ux05-host-agnostic-bootstrap.md`, `meta/REDESIGN_PLAN.md`, `meta/remediation_tracker_v1.json`
