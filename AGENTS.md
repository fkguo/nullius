# Autoresearch Ecosystem — Agent Context

> 本文件为 AI agent 提供跨会话持久上下文。修改本文件需经 autoresearch-meta 治理流程。

## 根级入口与本地工具文件

- `AGENTS.md` 是仓库级 agent 规则的唯一 SSOT；这里的人类编写治理规则仍是根级唯一权威来源。
- 根目录 `CLAUDE.md` 仍是兼容旧 prompt / 旧工具发现逻辑的稳定 shim；根级不在其中维护第二套人类编写规则。
- GitNexus generated appendix 允许进入根 `AGENTS.md` 与根 `CLAUDE.md` 的提交面；该 appendix 属于工具生成上下文而非根级治理 SSOT，可随 `npx gitnexus analyze` 漂移并与业务改动一同提交。
- `.serena/project.yml` 是单机 / 单 worktree 的本地 Serena 配置，故意不纳入 Git 跟踪；仓库模板固定为 `.serena/project.example.yml`。
- `.serena/memories/architecture-decisions.md` 是仓库内唯一允许纳入 Git 跟踪的 Serena memory；其余 `.serena/memories/**` 默认视为本地工作笔记，不得作为治理 SSOT。
- 需要跨会话/跨 worktree 保留的 Serena 结论，必须先提炼并写入 `.serena/memories/architecture-decisions.md`（或其他已跟踪 SSOT）后，才可依赖；未提炼的本地 memory 只可作为临时参考。
- 若旧文档要求“读取根 `CLAUDE.md`”，应解释为：先读 `AGENTS.md`，再读根 `CLAUDE.md` shim，最后按作用域读更具体的 `packages/*/CLAUDE.md` / `AGENTS.md`。

## 根工作区附加规则

- **无向后兼容负担**：生态圈尚未正式发布、无外部用户；默认允许直接 breaking change，不需要为旧 API / 旧 schema / 旧数据保留 shim、迁移脚本或兼容矩阵。
- **禁止临时性/阶段性命名**：不要引入 `vNext`、`v2`、`new_`、`legacy_`、`old_` 等过渡性命名；直接使用面向功能的永久命名。
- **禁止不透明历史前缀命名进入新抽象**：`W1/W2/W3/W4/W_*` 这类依赖历史上下文才能理解的阶段号/工作流前缀，不应继续进入新的 root governance、shared contracts、user-facing workflow ids 或长期保留的核心抽象；新命名应直接表达语义（如 `ingest`、`reproduce`、`revision`、`computation`）。
- **Commit 消息不加 AI co-author**：若未来得到人类授权执行 `git commit`，不要在提交消息中写 `Co-Authored-By: Claude ...` 或类似 AI 标注。
- **SOTA 原则**：凡涉及架构选择、LLM 能力判断、retrieval/reranking/evidence 策略或“某功能是否仍有价值”的判断，应优先基于最新论文、benchmark、最佳实践和竞品动态，而不是仅凭过期记忆。

## 理论研究通用内核约束

- **Core 必须 domain-neutral**：`autoresearch` 的目标是面向理论研究的通用 substrate / control plane，而非任何单一学科、单一子领域或单一工具链的专用自动化器。当前以高能物理（尤其 hep-th）为首个高优先级落地方向，但这不是 scope 上限；后续应可扩展到其他理论物理方向及数学等理论研究方向。
- **HEP-first 不等于 HEP-locked**：HEP 特定的 prompts、heuristics、package/tool mappings、工作流偏好与数据源假设，必须下沉到对应 domain pack / provider；禁止把这些假设固化进 root governance、shared contracts、orchestrator 内核或跨领域共享抽象。
- **领域分类必须准确**：shared/generic 层可使用真实 domain/category 标签（如 `hep-th`、`cond-mat`、`mathematics`）作为示例或 pack 标识，但不得误写其学科归属，也不得把任何单一 domain 表述为 core 的默认推荐值。
- **Compute 按 task/capability-first 建模**：计算/推导/验证运行时应优先表达研究任务类型、能力需求、artifact/evidence/provenance 契约与审批边界；package 名称、后端名称与现有工具链只可作为开放示例或 provider 实现，不得成为封闭枚举、唯一执行路径或 scope 边界。
- **项目定边界，LLM 填内容**：仓库负责 typed contracts、approval/policy、artifact/evidence/provenance 语义、审计与可复现边界；具体问题的 decomposition、方法选择、backend 组合、参数化与 fallback 默认由 runtime LLM / agent 在这些治理边界内决定。
- **只把稳定不变量写入 SSOT**：根级治理文本、长期 schema 与 tracker note 只应固定长期稳定的架构不变量；会随具体课题变化的 planning heuristics、prompt tactics、临时工具清单或局部最优策略，不应上升为根级治理规则。

## 生态圈概览

Autoresearch 是一个 evidence-first 自动化研究平台，目标是构建面向理论研究的通用 autoresearch substrate。当前以高能物理（尤其理论高能物理）作为首个高优先级 domain pack / provider 落地方向，但不以此作为长期 scope 边界。系统由 7 个组件组成，通过 MCP (Model Context Protocol) stdio 传输和 JSON-RPC 2.0 协议互联。

## 组件清单

| 组件 | 语言 | 行数 | 角色 |
|---|---|---|---|
| `hep-research-mcp` (目录: `hep-research-mcp-main/`) | TypeScript | ~130K | MCP server，71 工具 (standard) / 83 工具 (full)，写作流水线，PDG/Zotero/INSPIRE 集成 |
| `hep-autoresearch` | Python | ~29K | Orchestrator + CLI (`hepar`)，审批 gate，ledger，MCP client |
| `idea-core` | Python | ~11K | Idea 评估引擎，JSON-RPC 2.0 server |
| `idea-generator` | Python | ~370 | Idea 生成，schema SSOT (vendored 到 idea-core) |
| `skills/` | Python | — | 技能脚本集合 (hep-calc, research-team, etc.) |
| `skills-market` | Python | — | 技能市场 |
| `autoresearch-meta` | Mixed | — | 治理仓库：schemas, scripts, contract, remediation plan, audit |

## 关键架构决策

1. **双语言架构 (TS + Python) → 全面迁移至 TS**: 原设计理由"Python 用于科学计算生态"经审计不成立——orchestrator、idea-core、idea-generator 均无科学计算依赖 (零 numpy/scipy/sympy)；idea-core 仅用 jsonschema/jcs/filelock 做 JSON 验证和搜索；HEP 计算工具以 Mathematica 为主 (8/12)，通过 wolframscript 子进程调用，与编排/评估语言无关。**迁移策略**: 分 5 阶段增量迁移——阶段 1: TS orchestrator 骨架；阶段 2: 接管 hep-autoresearch 功能；阶段 3: idea-core → TS idea-engine；阶段 4: idea-generator 验证脚本 → TS；阶段 5: Python 组件退役。新组件 (统一编排器、Agent-arXiv、并行调度) 直接用 TypeScript 编写。详见 REDESIGN_PLAN.md NEW-05a。
2. **Evidence-First I/O**: artifact 写入磁盘，MCP tool result 仅返回 URI + 摘要。大载荷 (>100KB) 自动溢出。
3. **Contract-First**: idea-generator schemas 为 SSOT，idea-core 通过 vendored snapshot + SHA256 门禁消费。
4. **JSON Schema 唯一 SSOT**: 所有跨组件共享类型定义在 `autoresearch-meta/schemas/`，TS 组件直接 import，Python 组件用 `datamodel-code-generator` 生成。全面迁移至 TS 后，跨语言代码生成完全消除，NEW-01 基础设施仅在过渡期需要。
5. **审批 Gate 体系**: 5 个 gate (A1-A5)，fail-closed，支持超时策略 (block/reject/escalate) 和预算强制。

## 治理文档 (autoresearch-meta/)

| 文件 | 用途 | 当前版本 |
|---|---|---|
| `.review/ARCHITECTURE_AUDIT.md` | 基线审计，~49 缺陷 (4C/21H/17M/7L) | v1.2 Final (冻结) |
| `REDESIGN_PLAN.md` | 分阶段重构方案 (P0→P5)，85 项 (tracker 口径) | v1.3.0-draft (evomap) |
| `ECOSYSTEM_DEV_CONTRACT.md` | 42 条强制规则，35 fail-closed / 7 fail-open | v1.2.0-draft (R5+LANG+PLUG) |

## 长期愿景

多 Agent 自主研究社区 (Agent-arXiv)：从 hep-th arXiv 文献池出发，多 Agent 自主选题、并行研究、发布结果、迭代积累。详见 `hep-autoresearch/docs/VISION.zh.md` §长期愿景 + `autoresearch-meta/docs/2026-02-19-opencode-openclaw-design-adoption.md` §5。

> **近中期澄清 (2026-03-07)**: `single-user research loop` 中的 `single-user` 指单一人类 owner / principal investigator / 治理控制面单一，**不等于** `single-agent`。正确的三层演进为：`NEW-LOOP-01` = 单用户/单项目 substrate，`EVO-13` = 单项目内多 Agent 团队执行 runtime，`EVO-15/16` = 社区级多团队基础设施与自治实验。
> **设计追踪**: `EVO-13` 的前置设计 memo 固定为 `meta/docs/2026-03-07-evo13-single-project-multi-agent-runtime-memo.md`；runtime governance / control-plane amendment 固定为 `meta/docs/2026-03-08-evo13-runtime-governance-control-plane-amendment.md`；仅当 `NEW-LOOP-01` 完成 closeout 且 substrate 稳定后，才应升格为完整 implementation prompt。

## Phase 结构

- **Phase 0 (止血)**: 9 项。Monorepo 迁移 + TS 编排层增量迁移 + 安全漏洞 + 治理绕过。NEW-05 最先执行，NEW-05a 紧随。
- **Phase 1 (统一抽象)**: 17 项。AutoresearchError, RunState, GateSpec, ArtifactRef, trace_id, risk_level 等共享抽象 + 代码生成基础设施。
- **Phase 2 (深度集成)**: 19 项。原子写入, 文件锁, 幂等性, JSONL 日志, 审批 UX 三件套, 报告生成。
- **Phase 3 (扩展性)**: 21 项（原 13 + 7 个 SOTA retrieval/discovery/runtime follow-up + `NEW-LOOP-01`）。Schema 扩展, 凭据管理, 网络治理, AST lint 升级, MCP 工具整合 + federated discovery / retrieval backbone / routing registry + 单研究者非线性 research loop 前置运行时。
- **Phase 4 (长期演进)**: 8 项。文档, 低优先级缺陷, 发布冻结产物, A2A 适配层。
- **Phase 5 (端到端闭环、统一执行与研究生态外层（P5A/P5B）)**: 19 项。`P5A` = 单用户 / 单项目端到端闭环与统一执行收束；`P5B` = 社区 / 发布 / 跨实例 / 研究进化外层。条目包括理论计算执行闭环, 结果反馈循环, 统一编排引擎 (TS), 跨 Run 并行调度, Agent 注册表, Domain Pack, 科学诚信, 可复现性验证, 跨实例同步, 失败库生成时查询, 进化提案自动闭环, Bandit 分发策略运行时接入, 技能生命周期自动化, Agent-arXiv 基础设施, Agent 社区自主运行实验, REP 协议核心 (Track A), REP 信号引擎 (Track A), GEP/Evolver Track B 集成。

## Contract 规则域

ERR (4), ID (3), SYNC (6), CFG (4), GATE (5), LOG (4), ART (5), SEC (3), NET (1), RES (1), MIG (1), REL (2), CODE (1), LANG (1), PLUG (1)

## 三模型审核流程

自 2026-03-08 起，所有重大文档变更与实现 closeout 默认采用三模型独立审核：`Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(kimi-for-coding/k2p5)`。若其中任一模型本地不可用，必须记录失败原因并由人类明确确认 fallback reviewer；禁止静默降级。审核产物存放在 `autoresearch-meta/.review/`（已 gitignore）。

### 触发条件

- 跨组件架构变更（影响 ≥2 个组件的接口/契约）
- Contract 规则新增或修改
- REDESIGN_PLAN Phase 级别变更（项移动、新增、删除）
- 不可逆操作方案（monorepo 迁移、schema 破坏性变更）

单组件内部修改、bug fix、文档 typo 等**不需要**正式三模型审核。

### 收敛判定规则

1. 三个模型独立审核，输出 strict JSON（含 `verdict`, `blocking_issues`, `amendments`）
2. **CONVERGED**: 三个模型均 0 blocking issues → 方案通过
3. **CONVERGED_WITH_AMENDMENTS**: 0 blocking + 非阻塞修正建议 → 方案通过；凡当前 batch 直接相关、高价值、低风险、可独立验证且不依赖后续 phase / lane 的 amendments，默认必须本轮吸收。仅当 amendment 属于 lane 外工作、依赖后续 phase / lane（或当前 batch 之外的后续工作）、属于 pre-existing unrelated debt、需要人类架构裁决、或修复风险明显大于收益时，才允许 deferred；仅仍有后续价值的 deferred 项必须同步到持久 SSOT（至少 `meta/remediation_tracker_v1.json` 条目或 checked-in 的后续 prompt 文件），临时 chat prompt、review/self-review 输出与 scratch notes 不算 SSOT，禁止只留在这些临时产物中。低价值或已判定不值得跟进的 non-blocking amendments 应记录为 declined/closed，而非 deferred。
4. **NOT_CONVERGED**: 任一模型有 blocking issue → 必须修正后重新提交下一轮 (R+1)
5. **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入决策
6. 每轮 prompt 必须包含：上一轮三模型的完整输出 + 已采纳/未采纳修正及理由

### 审核输出 JSON schema

```json
{
  "verdict": "CONVERGED | CONVERGED_WITH_AMENDMENTS | NOT_CONVERGED",
  "blocking_issues": ["..."],
  "amendments": [{"target": "...", "section": "...", "change": "..."}],
  "positive_findings": ["..."]
}
```

### 执行方式

使用 `claude-cli-runner`、`gemini-cli-runner` 与 `opencode-cli-runner` skills 并行执行。默认 reviewer 固定为 `Opus`、`Gemini-3.1-Pro-Preview` 与 `OpenCode(kimi-for-coding/k2p5)`；prompt 文件存放在 `.review/` 目录。

## Superpowers 使用约定

- **默认不使用 `superpowers` 通用 skills 作为执行依据**。本仓库的权威执行依据始终是：`AGENTS.md`、batch prompt、`meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md`、GitNexus 证据、`review-swarm` 与 `self-review` 门禁。
- **worktree 默认使用与主仓平行的本地路径**，例如主仓为 `/home/user/Coding/Agents/autoresearch-lab` 时，优先使用 `/home/user/Coding/Agents/autoresearch-lab-<branch-or-batch>`；除非人类明确要求，否则不默认使用 `~/.config/superpowers/worktrees/...`。
- **通用 skill 不得覆盖项目级硬门禁**：不得覆盖实现 prompt、GitNexus freshness / post-change evidence、正式 `review-swarm`、正式 `self-review`、tracker / memory / `AGENTS.md` 同步、以及版本控制门禁。
- 若某个通用 skill 与本仓库规则冲突，**一律以本仓库规则为准**；必要时直接忽略该 skill 的默认建议。

## Agent 执行纪律

### 全盘思考要求

执行任何修复项前，agent 必须：

1. **读取 AGENTS.md + tracker JSON** — 了解全局进度和依赖关系
2. **读取目标项在 REDESIGN_PLAN.md 中的完整描述** — 包括修改文件、验收检查点、依赖项
3. **检查 ECOSYSTEM_DEV_CONTRACT.md 中相关规则** — 确保修改不违反 fail-closed 规则
4. **检查是否有下游依赖项会受影响** — 在 tracker 中查看 blocked-by 关系

禁止"只看当前文件就动手改"的行为。

### 深度验证要求

- 每次修改后必须运行该项的验收检查点命令（PLAN 中列出的 pytest/lint/CI 命令）
- 如果验收命令不存在（尚未创建），必须先创建再验证
- 禁止仅凭"看起来对了"就标记完成
- 网络搜索：如果 WebFetch 失败，使用 `curl --proxy` 或直接 `curl` 重试

### 语义/领域清理硬要求

- 删除、降级或上提 `domain heuristics`、`taxonomy`、`classifier`、`lexicon`、`validator` 前，必须先追踪其完整调用链到 registry / schema / public output / tests / eval fixtures / baseline / docs 与 plan 叙事；禁止仅凭命名、局部 grep 或少量代码片段判断其应删/应留。
- 必须区分 `provider-local fail-open prior` 与 `active authority`：前者只能是带 provenance 的 fallback / diagnostic，后者一旦仍在决定 public output、grouping、scoring、gating 或默认 worldview，就必须按 authority 泄漏处理。
- 真正的问题不是出现 HEP/domain 术语本身，而是让不完整的闭合枚举或 keyword buckets 充当 authority；禁止把这类实现仅做改名后继续留在 generic/shared/core，也禁止把它们只改称 `diagnostic` / `fallback` 却仍保留同一 authority call-path。
- 凡涉及质量/架构取舍，必须做 SOTA preflight 并记录 primary-source 依据；禁止因为历史包袱保留已知会限制质量的 heuristic authority。

### Implementation Prompt 硬门禁

> 适用于 `meta/docs/prompts/prompt-*-impl-*.md` 以及任何要求"按之前惯例执行"的实现任务。通用 checklist 见 `meta/docs/prompts/IMPLEMENTATION_PROMPT_CHECKLIST.md`。

- **GitNexus 开工前对齐是硬要求**：实现前必须先读 `gitnexus://repo/{name}/context`；若 index stale，先运行 `npx gitnexus analyze`，再继续。禁止带 stale index 开工。
- **本仓 GitNexus generated appendix 约束**：当前 GitNexus 版本会无条件向根 `AGENTS.md` / `CLAUDE.md` upsert 动态 marker；本仓接受这些 generated appendix 进入提交面，但应将其视为非 SSOT 的工具生成上下文，不在 marker block 内手写根级治理规则。
- **GitNexus 审核前再对齐是条件性硬要求**：若实现新增/重命名符号、改变关键调用链、或当前 index 已不反映工作树，必须在正式审核前再次刷新，并用 `detect_changes` / `impact` / `context` 形成 post-change 证据。
- **正式 `review-swarm` 为实现收尾必经步骤**：实现 prompt 默认必须在验收命令通过后执行正式三审（`Opus` + `Gemini-3.1-Pro-Preview` + `OpenCode(kimi-for-coding/k2p5)`）；审核必须深入代码、调用链、测试、eval fixture、baseline、scope boundary，禁止只看 diff 摘要做表面判断。
- **正式自审 (`self-review`) 也是实现收尾硬门禁**：外部三审收敛后，当前执行 agent 仍必须基于实际代码、调用链 / GitNexus 证据、tests / eval / holdout / baseline、scope boundary 再做一轮自审；blocking issue 必须先修复。自审结论与 adopted / deferred / declined/closed dispositions 必须记录，并明确哪些 amendment 因满足“当前 batch 直接相关 + 高价值 + 低风险 + 可独立验证 + 不依赖后续 phase / lane”而被本轮默认吸收；deferred 项必须给出合法理由，并把仍有后续价值的项同步到持久 SSOT；低价值或已判定不值得跟进的项应标记为 declined/closed，而非 deferred。
- **完成态门禁**：只有当验收命令通过、`review-swarm` 收敛且三审 `blocking_issues = 0`、`self-review` 通过、tracker / memory / `AGENTS.md` 已同步后，实施项才可标记 `done`。
- **版本控制门禁**：`git commit` / `git push` 仍需人类在当前任务中明确授权；若已授权，也只能在上述完成态门禁满足后执行，并在 push 前确认工作树只包含本批应交付内容。`.review/` 审核产物保持 gitignored，不进入提交。
- **worktree 清理前 Serena memory 迁移是硬门禁**：删除任何非主 `worktree`（含 `git worktree remove` 或等价目录清理）前，必须先盘点该 `worktree` 下的 `.serena/memories/`；可复用的长期结论迁入并提交 `.serena/memories/architecture-decisions.md`，仅本地保留但对后续开发仍有帮助的记忆复制到保留的目标 `worktree` 的 `.serena/memories/`，只有临时 scratch / cache / 不可复用思路才允许随 `worktree` 删除。未完成迁移前不得清理 `worktree`。
- **worktree 清理前 SOTA preflight 迁档也是硬门禁**：删除任何非主 `worktree` 前，必须盘点该 `worktree` 下本轮实现产出的 SOTA 调查材料（至少包括 `.tmp/*sota-preflight*`、`.tmp/**/*sota-preflight*` 与 prompt 明示要求的 preflight 文件）。有复用价值的原始调查必须迁入稳定本地 archive（默认 `~/.autoresearch-lab-dev/sota-preflight/<YYYY-MM-DD>/<item-id>/`），而不是随 `worktree` 一起删除；archive 至少应包含 `preflight.md`、`summary.md`、`manifest.json`（或等价元数据），记录 prompt 路径、来源 URL / 文献、批次 / item、以及已提炼到哪些 checked-in SSOT。该本地 archive 不是治理 SSOT；真正影响后续实现约束的稳定结论仍必须提炼并写入 `.serena/memories/architecture-decisions.md` 或其他已跟踪 SSOT。未完成迁档前不得清理 `worktree`。

### Tracker 更新协议

- 开始工作前：`status: "in_progress"`, `assignee: "opus-4.6"` (或实际模型)
- 完成并验证后：`status: "done"`, 附 commit hash
- 遇到阻塞：`status: "blocked"`, 附原因
- 每次更新 tracker 后同步更新 AGENTS.md 当前进度摘要

## 代码质量强制规则

> 借鉴 oh-my-opencode (Sisyphus/Prometheus) 模式，补充 CONTRACT 未覆盖的防屎山规则。

### 模块化强制 (Modular Code Enforcement)

1. **200 LOC 硬限制**: 单文件不得超过 200 行有效代码（不含空行和注释）。超过时必须拆分。
2. **单一职责 (SRP)**: 一个文件 = 一个职责。禁止在同一文件中混合不相关逻辑。
3. **禁止万能文件名**: 以下文件名禁止作为业务逻辑容器：`utils.ts`, `helpers.ts`, `common.ts`, `service.ts`, `misc.ts`, `utils.py`, `helpers.py`, `common.py`。如需工具函数，按功能域命名（如 `string-utils.ts`, `path-helpers.ts`）。
4. **入口文件仅做 re-export**: `index.ts` / `__init__.py` 仅用于 re-export，禁止包含业务逻辑。
5. **新增文件前先检查**: 创建新文件前必须确认没有已存在的文件可以承载该功能。

### 任务管理纪律 (Task Management Discipline)

- 多步骤任务（≥3 步）必须先创建 task list，逐项标记进度
- 禁止"一口气做完再汇报"——每完成一个子步骤立即更新状态
- 遇到阻塞时立即记录原因，不得静默跳过

### 规划先行 (Planning-Before-Implementation)

- 非平凡修改（影响 ≥2 文件或 ≥50 行变更）必须先输出修改计划，再动手
- 计划必须包含：影响文件列表、变更摘要、验收条件
- 禁止"边想边改"——计划确认后方可执行

### 硬性禁止 (Hard Blocks)

以下行为绝对禁止，无豁免：

- **类型安全逃逸**: `as any`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore` — 禁止
- **未读即改**: 对未读取的代码进行推测性修改 — 禁止
- **静默吞错**: 空 catch 块 `catch(e) {}` / `except: pass` — 禁止
- **删测试过关**: 删除失败测试以"通过"CI — 禁止
- **破窗离场**: 修改后留下编译错误或测试失败 — 禁止
- **未经请求提交**: 未经人类明确要求执行 `git commit` — 禁止

### 反模式检测 (Anti-Patterns)

Agent 在代码审查和自检时必须检测以下反模式：

- **过度工程**: 为假设性未来需求添加抽象层、配置项、feature flag
- **范围蔓延**: 修 bug 时顺手重构周边代码、添加不相关功能
- **元工作蔓延**: 主动新增治理层、模板层、流程层或额外 SSOT，除非其满足至少一项：直接 unblock 当前 batch；现有 SSOT 已被证明不足；已出现重复执行漂移且该补充能以最小成本稳定消除漂移。否则默认沿用现有 SSOT，不新增元工作
- **AI 注释泛滥**: 添加 `// This function does X` 等显而易见的注释
- **不必要的依赖**: 为可用 3 行代码解决的问题引入新库

### 意图分类 (Intent Classification)

> 借鉴 Metis agent。执行任何任务前先分类，决定投入深度。

| 意图类型 | 特征 | 策略 |
|---|---|---|
| 平凡 | 单文件, <10 行, 明显修复 | 快速确认→直接执行，不需规划 |
| 简单 | 1-2 文件, 明确范围 | 轻量问询→提出方案→执行 |
| 重构 | 改变结构但保持行为 | 安全优先：先映射引用→确认测试覆盖→逐步修改 |
| 新建 | 新功能/模块 | 发现优先：先探索现有模式→匹配约定→再动手 |
| 架构 | 跨组件设计决策 | 战略优先：全局影响评估→三模型审核→方可执行 |

### 代码质量标准

> 借鉴 ultrawork manifesto："agent 产出的代码应与资深工程师的代码不可区分"。

- 严格遵循现有代码库的模式和风格
- 错误处理不需要被要求就应正确实现
- 不产生 "AI slop"（过度工程、不必要抽象、范围蔓延）
- 注释仅在逻辑不自明时添加

### oh-my-opencode 能力覆盖分析

| oh-my-opencode 能力 | 本生态覆盖情况 | 差距 |
|---|---|---|
| Sisyphus 任务管理 | superpowers:executing-plans + tracker 协议 | ✅ 已覆盖 |
| Prometheus 规划纪律 | superpowers:writing-plans + brainstorming | ✅ 已覆盖 |
| Atlas 编排委派 | superpowers:dispatching-parallel-agents | ✅ 已覆盖 |
| Momus 审查循环 | 三模型审核流程 | ✅ 已覆盖（更强） |
| Metis 意图分类 | **无对应规则** | ⬆️ 本节补充 |
| Oracle 战略顾问 | superpowers:brainstorming + 三模型审核 | ✅ 部分覆盖 |
| Librarian 外部文档搜索 | sci-hub + zotero-import + INSPIRE 工具 | ✅ 已覆盖（HEP 专用） |
| Explore 代码搜索 | superpowers:dispatching-parallel-agents | ✅ 已覆盖 |
| Hephaestus 深度自治执行 | Codex CLI runner | ✅ 已覆盖 |
| 硬性禁止 + 反模式检测 | **无对应规则** | ⬆️ 本节补充 |
| 模块化代码强制 (200LOC/SRP) | **无对应规则** | ⬆️ 本节补充 |
| 代码质量标准 (indistinguishable code) | **无对应规则** | ⬆️ 本节补充 |

## 模型选择规则

> 模型选择由人类手动切换（`/model` 或 settings.json），agent 可在输出中建议切换。
> 本节基于 2026-02 评估，benchmark 数据需定期更新。

### Benchmark 基准 (SWE-bench Verified, 500 实例, 2026-02)

| 模型 | 得分 | 推理深度 | 备注 |
|---|---|---|---|
| Claude 4.5 Opus | 76.8% (384/500) | high | 当前 SWE-bench 最高分 |
| **MiniMax M2.5** | 75.8% (379/500) | high | 国产模型并列第二 |
| **Claude Opus 4.6** | 75.6% (378/500) | standard | 本生态主力模型 |
| **Gemini 3 Pro Preview** | 74.2% (371/500) | high | 超长上下文 (≥1M) |
| **GLM-5** | 72.8% (364/500) | high | 智谱旗舰 |
| **GPT-5.2** | 72.8% (364/500) | high (xhigh) | OpenAI 通用旗舰 |
| **Claude 4.5 Sonnet** | 71.4% (357/500) | high | Sonnet 4.6 参考基线 |
| **Kimi K2.5** | 70.8% (354/500) | high | 月之暗面旗舰 |
| GPT-5.2 | 69.0% (345/500) | standard | 不开推理时显著下降 |
| GPT-5.1-codex | 66.0% (330/500) | medium | GPT-5.3-Codex **无 SWE-bench 数据** |

> **注 1**: SWE-bench Verified 测量真实 GitHub issue 修复能力，是 agentic coding 最权威基准。
> **注 2**: GPT-5.3-Codex 尚未提交 SWE-bench 评测。上表 GPT-5.1-codex (66%) 仅供参考，不代表 5.3 性能。
> **注 3**: OpenAI `xhigh` = 最大推理 token 分配；Anthropic `extended thinking` = 类似机制。高推理深度显著提升得分但增加延迟和成本。

### 可用模型概览

| 模型 | 厂商 | 定位 | 上下文窗口 | 成本层级 | SWE-bench | 关键能力 |
|---|---|---|---|---|---|---|
| **Opus 4.6** | Anthropic | 旗舰推理 + agentic | 200K | 高 ($15/$75 per M) | 75.6% | 深度推理、MCP 原生、extended thinking、工具调用链 |
| **Sonnet 4.6** | Anthropic | 平衡性能/成本 | 200K | 中 ($3/$15 per M) | ~71%¹ | 编码、MCP 支持、速度快、日常开发首选 |
| **GPT-5.3-Codex (xhigh)** | OpenAI | 代码专精 | ≥128K | 高 | N/A² | 代码审查、结构化输出、Codex CLI 原生 |
| **GPT-5.2 (xhigh)** | OpenAI | 通用旗舰 | ≥128K | 高 | 72.8% | 通用推理、数学、科学分析 |
| **Gemini-3-Pro-Preview** | Google | 通用旗舰 | ≥1M | 中 | 74.2% | 超长上下文、多模态、科学推理 |
| **MiniMax M2.5** | MiniMax | 通用旗舰 | — | 低 | 75.8% | 高性价比、编码能力强 |
| **GLM-5** | 智谱 | 通用旗舰 | — | 低 | 72.8% | 中文优势、编码能力强 |
| **Kimi K2.5** | 月之暗面 | 通用旗舰 | 128K | 低 | 70.8% | 长上下文、中文优势 |

> ¹ Sonnet 4.6 无独立 SWE-bench 条目，基于 Claude 4.5 Sonnet (71.4% high / 70.6% standard) 估算。
> ² GPT-5.3-Codex 未提交 SWE-bench。前代 GPT-5.1-codex = 66% (medium reasoning)。

### 任务-模型匹配矩阵

| 任务类型 | 首选模型 | 备选模型 | 理由 |
|---|---|---|---|
| **Phase 0 全部项 + complexity=high** | Opus 4.6 | Gemini-3-Pro | 高风险/跨组件，Opus SWE-bench 75.6% + 200K 上下文 + MCP 原生 |
| **跨组件架构变更** | Opus 4.6 | GPT-5.2 (xhigh) | 需全局上下文理解 + agentic 工具调用链 |
| **TS 迁移 (NEW-05a)** | Opus 4.6 | MiniMax M2.5 | 大规模代码重写，Opus 75.6% / MiniMax 75.8% 均为顶级 |
| **单组件 complexity=low/medium** | Sonnet 4.6 | GLM-5, Kimi K2.5 | 成本效益，Sonnet ~71% 足够；国产模型成本更低 |
| **正式三模型审核 (治理文档)** | Opus 4.6 + Gemini-3.1-Pro-Preview + Kimi K2.5 | 若 `Gemini-3.1-Pro-Preview` 不可用，需人类确认 fallback | 三家厂商交叉，兼顾深度推理、长上下文与中文/工程视角 |
| **正式三模型审核 (代码/架构/实现)** | Opus 4.6 + Gemini-3.1-Pro-Preview + Kimi K2.5 | 若 `Gemini-3.1-Pro-Preview` 不可用，需人类确认 fallback | 统一实现收尾 reviewer trio，避免模型单点偏见 |
| **idea-engine 迁移 (阶段 3)** | Opus 4.6 | MiniMax M2.5 | ~6,800 行代码迁移，需顶级编码能力 |
| **Agent-arXiv 设计 (EVO-15/16)** | Opus 4.6 | GPT-5.2 (xhigh) | 复杂系统设计需深度推理 + 长上下文 |
| **科学诚信框架 (EVO-06)** | GPT-5.2 (xhigh) | Opus 4.6 | 科学推理 + 严谨性验证 |
| **文档/typo/格式修复** | Sonnet 4.6 | Kimi K2.5, GLM-5 | 简单任务，最小成本 |
| **Schema 设计/验证** | Sonnet 4.6 | — | 结构化任务，Sonnet 足够 |
| **超长上下文分析 (>200K)** | Gemini-3-Pro | — | 唯一 ≥1M 上下文模型，全代码库扫描 |

### 模型选择原则

1. **顶级编码 → Opus 4.6 (75.6%) 或 MiniMax M2.5 (75.8%)**: 大规模代码迁移、复杂 bug 修复。MiniMax 成本更低但工具调用生态不如 Anthropic
2. **深度推理 → Opus 4.6 或 GPT-5.2 (xhigh, 72.8%)**: 跨组件架构、科学推理。GPT-5.2 xhigh 延迟高但推理深度强
3. **代码审查 → GPT-5.3-Codex (xhigh)**: Codex CLI 原生集成，代码专精。注意：无 SWE-bench 数据，实际能力待验证
4. **独立审核 → 默认三家厂商交叉**: 避免同源偏见，正式审核默认使用 Anthropic (`Opus`) + Google (`Gemini-3.1-Pro-Preview`) + Moonshot/OpenCode (`Kimi K2.5`)。
5. **成本敏感 → Sonnet 4.6 (~71%)**: 单组件、低复杂度、日常开发。国产备选：GLM-5 (72.8%)、Kimi K2.5 (70.8%) 成本更低
6. **超长上下文 (>200K) → Gemini-3-Pro (74.2%)**: 全代码库扫描、大规模文档分析，唯一 ≥1M 上下文

### 国产模型使用策略

国产模型 (MiniMax M2.5, GLM-5, Kimi K2.5) 在 SWE-bench 上表现出色，成本显著低于 Anthropic/OpenAI。适用场景：

- **正式三模型审核中的国产视角**: `Kimi K2.5` 作为默认 reviewer trio 成员，提供中文/工程视角与第三厂商交叉验证，而非事后 tiebreaker。
- **低复杂度日常任务**: 替代 Sonnet 4.6 进一步降低成本
- **大规模代码迁移的并行验证**: MiniMax M2.5 (75.8%) 可与 Opus 4.6 并行执行同一迁移任务，交叉验证

**限制**: 国产模型的 MCP 工具调用、agentic 编排、CLI 集成成熟度不如 Anthropic/OpenAI，暂不作为主力 agentic 执行模型。

### 切换时机

- Agent 在开始工作前检查 tracker 中目标项的 `complexity` 字段
- 如果当前模型与推荐不匹配，在输出中提示：`⚠️ 建议切换至 {model}（原因: {reason}）`
- 人类决定是否切换，agent 不自动切换
- **高推理深度仅在以下场景使用**: 正式三模型审核、架构级决策、大规模代码迁移。日常任务使用默认推理深度以控制成本
- **Benchmark 数据时效**: 本节数据基于 2026-02 SWE-bench Verified。GPT-5.3-Codex 提交评测后需更新推荐

## 当前进度

> **SSOT**: `meta/remediation_tracker_v1.json`（机器可读，agent 执行时更新）

- **Phase 0**: 14/14 完成 ✅
- **Phase 1**: 20/23 完成
- **Standalone closeout**: `NEW-05a-shared-boundary` ✅（`packages/shared/` 不再持有具体 `HEP_*` tool-name authority / HEP risk map / `hep://runs` helper；`packages/hep-mcp/` 本地 authority + wrappers 已落地；formal review 经 `Opus` + 用户确认 fallback `GLM-5` + `K2.5` 收敛为 0 blocking；GitNexus 仍会漏报新文件/新 helper callsites，因此 post-change exact verification 继续以源码 grep 为准）
- **Standalone closeout**: `NEW-05a-formalism-contract-boundary` ✅（`formalism_registry_v1` / `formalism_check` 已从 source schemas、vendored snapshot、OpenRPC 与 idea-core runtime 主线移除；`candidate_formalisms[]` 降级为可选 run-local metadata；built-in HEP packs 不再 shipped concrete `hep/toy` / `hep/eft` / `hep/lattice` authority；graph-viz 不再提升 formalism 节点/边；formal review 经 `Opus + Gemini-3.1-Pro-Preview + OpenCode(kimi-for-coding/k2p5)` R1 收敛为 0 blocking，self-review 0 blocking）
- **Standalone closeout**: `NEW-05a-idea-core-domain-boundary` ✅（已与 `meta/docs/prompts/prompt-2026-03-10-hep-semantic-deep-cleanup.md` 的 Batch A 合并收口，因为二者共享同一 `idea-core` boundary / acceptance commands / review surface；`hep.bootstrap` / `bootstrap_default` / `HEP_COMPUTE_RUBRIC_RULES` / `toy_laptop` 已从 generic/default authority path 移除，`packages/idea-core/src/idea_core/engine/hep_builtin_domain_packs.json` 仅保留 provider-local `hep.operators.v1` catalog；acceptance 全绿，formal review 经 `Opus + OpenCode(kimi-for-coding/k2p5)` R3 收敛为 0 blocking，Gemini 不可用且人类已批准该 dual-review fallback，self-review 0 blocking）
- **Standalone partial closeout**: `NEW-05a-hep-semantic-authority-deep-cleanup`（深度审计已落地到 `meta/docs/2026-03-10-hep-semantic-authority-deep-audit.md`，program prompt 已落地到 `meta/docs/prompts/prompt-2026-03-10-hep-semantic-deep-cleanup.md`；Batch A 已并入 `NEW-05a-idea-core-domain-boundary` closeout；Batch B 已在当前分支状态收口：`hep-mcp` review/paper/question/assumption authority 已改成 MCP-sampling-first 或 metadata-first fail-closed path，保留 fallback 仅作为带 provenance 的 diagnostics-only 输出，`review_mode=exclude` 仅排除显式 review 而保留 uncertain papers；Batch C 现也已在当前 worktree 收口：theoretical conflict 不再由 closed subdomain lexicon / mutual-exclusion rules 决定 final relation，保留 lexicon 仅作为带 provenance 的 provider-local retrieval prior，title-only non-lexicon hard case (`Zc(3900)` cusp vs triangle singularity) 已锁定，final edges 保留 `different_scope` / `unclear` / `pending_client` / `abstained` 语义；Batch C 吸收 reviewer 指出的低风险修正后重新通过 acceptance（`pnpm --filter @autoresearch/hep-mcp test:eval`; `pnpm --filter @autoresearch/hep-mcp test`; `pnpm --filter @autoresearch/hep-mcp build`; `git diff --check`），formal review 经 `Opus + OpenCode(kimi-for-coding/k2p5)` 收敛为 0 blocking，Gemini 不可用且人类已批准该 dual-review fallback，self-review 0 blocking；Batch D 现也已在当前 worktree 收口：`survey.ts` 不再按标题关键词判定 review，而改走 metadata-backed provider-local classification；`collectionSemantic*` / `challenge*` 已改成 open-text-first + explicit `heuristic_fallback` / `uncertain` / `no_challenge_detected` provenance；`deepAnalyze.ts` 现仅暴露 `heading_utility` diagnostics，不再表述为 semantic understanding；`docs/ARCHITECTURE.md`、`AGENTS.md`、`meta/remediation_tracker_v1.json` 与 `meta/REDESIGN_PLAN.md` 也已纠正早先 `sectionRole*` / `evalSem09SectionRoleClassifier.test.ts` 的 stale historical narrative。Batch D 吸收 formal review 的低风险 amendment 后重新通过 acceptance（`evalSem10`、`evalSem13`、full `hep-mcp test`、`hep-mcp build`、`git diff --check` 全绿），formal review 经 `Opus + OpenCode(kimi-for-coding/k2p5)` 收敛为 0 blocking，Gemini 不可用且人类已批准该 dual-review fallback，self-review 0 blocking；剩余 pending scope 现只限 Batch E-F，严禁把后续收尾扩展成 batch3）
- **Phase 2**: 26/44 完成 — `NEW-WF-01` ✅（2026-03-07 retro-closeout：batch10 已交付 `research_workflow_v1` schema + templates，本轮补专项回归测试并修正 tracker drift）
- **Phase 3**: 32/50 完成 — Batch 8 `NEW-RT-05` ✅ + Batch 9 `NEW-SEM-07` ✅（G2: JSON SoT + drift regression 已满足） + Batch 10 `NEW-SEM-01` ✅ `NEW-SEM-06` ✅（现记为 `SEM-06a` baseline；Opus + K2.5 双模型审核 0 blocking） + Batch 11 `NEW-SEM-02` ✅ `NEW-RT-06` ✅ + Batch 12 `NEW-SEM-03` ✅ `NEW-SEM-04` ✅ `NEW-SEM-06-INFRA` ✅（`Opus + OpenCode(kimi-for-coding/k2p5)` 正式双审 0 blocking，low-risk amendments integrated） + Batch 13 `NEW-SEM-05` ✅ `NEW-SEM-09` ✅（provider-local unified paper/review/content classifier 已落地；`NEW-SEM-09` 旧的 “section-role semantic labeling” closeout 叙事已在 Batch D 纠偏，当前树的 `deepAnalyze` surface 以 explicit heading-utility diagnostics 为准，而非 live `sectionRole*` 模块；语义仍局限在 `hep-mcp` provider-local 范围内，未上提到 generic/shared authority） + Batch 14 `NEW-SEM-10` ✅ `NEW-SEM-13` ✅（topic/method grouping 与 synthesis challenge extraction 已切到 batch14 的 provider-local 语义模块，shared only within `hep-mcp` 而非 promoted generic/shared authority；Batch 14 开工前先独立修复 orchestrator `zod` 直依赖 CI 回归，commit `a4e1ad0`，GitHub Actions run `22768970963` ✅；实现 acceptance 全绿，`Opus + OpenCode(kimi-for-coding/k2p5)` 正式双审 0 blocking，agent `self-review` 0 blocking，implementation commit `7bd21bc`，low-risk amendments 已吸收） + Batch 15–16 `NEW-LOOP-01` ✅（`packages/orchestrator/src/research-loop/` 单用户/单项目 substrate 已落地；workspace/task/event graph + explicit backtracks + typed handoff seams + delegated-task injection 均已锁测试；`Opus + OpenCode(kimi-for-coding/k2p5)` 两轮正式双审最终 `CONVERGED`，agent `self-review` 0 blocking，全部 acceptance commands 全绿，implementation commit `d00147d`；同轮补齐 `NEW-WF-01` regression closeout） + Standalone `NEW-RT-07` ✅（host-side MCP sampling routing registry / typed metadata contract / auditable fallback + fail-closed path 已落地；`packages/orchestrator/src/{mcp-client,mcp-jsonrpc,mcp-server-request-handler,sampling-handler,routing/sampling-*}`、`packages/shared/src/sampling-metadata.ts` 与 `packages/hep-mcp/src/core/sampling-metadata.ts` 为 authority；全部 acceptance commands 全绿，`Opus + OpenCode(kimi-for-coding/k2p5)` 正式双审 0 blocking，agent `self-review` 0 blocking，implementation commit `a7aeba0`；未启动 `NEW-DISC-01` D4/D5 / `NEW-SEM-06b/d/e` / `EVO-13`） + Standalone `NEW-DISC-01` ✅（D4/D5 已完成：shared canonical paper / query-plan / dedup / search-log authority 现位于 `packages/shared/src/discovery/`；broker consumer `packages/hep-mcp/src/tools/research/federatedDiscovery.ts` 将 discovery artifacts 写入 `HEP_DATA_DIR/cache/discovery/`；exact-ID-first + uncertain fail-closed canonicalization、append-only search-log 语义、broker eval fixtures/baseline/holdout 均已锁定；全部 acceptance commands 全绿，`Opus` + `OpenCode(kimi-for-coding/k2p5)` 两轮正式双审最终 0 blocking，agent `self-review` 0 blocking；implementation commit `f233e77`，PR `#3` 已合并到 `main`（merge commit `2dbb97a`）） + Batch 17 `NEW-SEM-06b` ✅（hybrid candidate generation + strong reranker 已落地到 canonical paper substrate；shared discovery authority 现包含 candidate-channel / candidate-generation / rerank artifacts，hep-mcp broker 写入 audited `candidate_generation` + `rerank` artifacts 并执行 exact-ID-first + keyword + optional provider-native semantic generation + bounded canonical-paper rerank；锁定 eval plane 位于 `packages/hep-mcp/tests/eval/evalSem06bHybridDiscovery.test.ts` 与对应 fixtures/baseline/holdout，单测覆盖 `providerExecutors` / `paperReranker` / `federatedDiscovery`；全部 prompt acceptance commands 全绿，`SEM-06b` 专项 holdout 在 `EVAL_INCLUDE_HOLDOUT=1` 下通过；`Opus + OpenCode(kimi-for-coding/k2p5)` 正式双审 0 blocking，agent `self-review` 0 blocking；implementation commit `be1e466`） + Batch 18 `NEW-SEM-06d` ✅（triggered reformulation + QPP planner layer 已落地到 canonical-paper backbone；shared discovery authority 现包含 `provider-result-counts` / `query-reformulation-artifact` contract，hep-mcp discovery 执行 probe -> QPP -> optional reformulation -> optional second round -> rerank，并以 fail-closed 状态写入 audited search-log telemetry；锁定 eval plane 位于 `packages/hep-mcp/tests/eval/evalSem06dTriggeredReformulation.test.ts` 与对应 fixtures/baseline/holdout，覆盖 exact-ID/easy no-trigger、hard uplift、QPP unavailable、budget exhausted、invalid/abstained reformulation failure paths；全部 prompt acceptance commands 全绿，`Opus + OpenCode(kimi-for-coding/k2p5)` 正式双审 0 blocking，Gemini 因本地 agentic reviewer 不可用经用户明确批准 fallback，agent `self-review` 0 blocking；implementation commit `1b6be54`，tracker sync commit `834d799`，PR `#4` 已合并到 `main`（merge commit `e9e96f2`）） + Retrieval lane `Batch 19` `NEW-SEM-06e` ✅（structure-aware evidence localization 已在 shared + hep-mcp 落地：typed localization contract / LaTeX+PDF semantic surface merge / exact-unit rescue / fail-closed fallback+abstain 均已锁定；新增 `evalSem06eStructureAwareLocalization` baseline+holdout 与 `evalSem06eFailureModes` unavailable 路径；全部 acceptance commands 全绿，GitNexus `impact(queryProjectEvidenceSemantic)` LOW，正式三审 `Opus + Gemini-3.1-Pro-Preview + OpenCode(kimi-for-coding/k2p5)` 0 blocking，agent `self-review` 0 blocking；implementation commit `2d0b6e0`，PR `#5` 已合并到 `main`（merge commit `230ec3f`））；single-user loop clarification 文档已完成 `Opus + Kimi K2.5` 外部双审核，0 blocking，clarifications integrated + Standalone `NEW-SEM-06f` ✅（bounded multimodal/page-native retrieval 已落地：shared multimodal artifact contract + hep-mcp policy/fusion modules + preferred-unit localization hook 均已锁定；`queryProjectEvidenceSemantic` 现写出 auditable `multimodal` artifact，并保持 text-first skip / disabled / unavailable / ambiguous fail-closed 语义；eval authority 位于 `packages/hep-mcp/tests/eval/evalSem06fMultimodalScientificRetrieval.test.ts` 与对应 fixtures/baseline/holdout，`EVAL_INCLUDE_HOLDOUT=1` 专项重跑通过；全部 acceptance commands 全绿，GitNexus `detect_changes`=LOW 且 `impact(queryProjectEvidenceSemantic)`=LOW，正式三审 `Opus + Gemini-3.1-Pro-Preview + OpenCode(kimi-for-coding/k2p5)` 0 blocking，agent `self-review` 0 blocking；implementation commit `cc79c47` 已位于 `main`，后续治理澄清 / marker sync commits `cf8cafc` / `b27700b` 已保留）
- **Boundary clarification (2026-03-10)**: `NEW-SEM-05` / `NEW-SEM-10` / `NEW-SEM-13` 的已完工 closeout 只说明 provider-local interim quality gains 已交付，不代表当前 `hep-mcp` 已具备可上提到 generic/shared 的最终 semantic authority。深度审计显示 review/classification/grouping/challenge/conflict 仍有 active closed-lexicon authority，后续必须按独立的 semantic deep cleanup program 继续处理。
- **Phase 4**: 0/8 完成 — blocked by Phase 3
- **Phase 5**: 0/22 实现完成（14 pending + 8 design_complete） — blocked by Phase 4
- **R4 双模型审核**: ✅ 收敛 (Gemini CONVERGED + Codex CONVERGED_WITH_AMENDMENTS, 0 blocking)
- **R5 双模型审核**: ✅ 收敛 (Gemini CONVERGED_WITH_AMENDMENTS + Codex CONVERGED_WITH_AMENDMENTS, 0 blocking, amendments integrated)

## 开发约定

- **审核过程文件 (`autoresearch-meta/.review/`) 为临时产物，禁止 git push**。包括三模型审核的 prompt、输出、中间稿等。已在 `.gitignore` 中排除。
- 新代码必须遵守 ECOSYSTEM_DEV_CONTRACT.md 全部规则
- 存量代码按 REDESIGN_PLAN.md 分阶段对齐
- 豁免: `# CONTRACT-EXEMPT: {规则ID} {原因}`
- 配置键必须在 CFG-01 注册表中注册
- 错误必须使用 AutoresearchError 工厂，禁止裸 throw/raise
- Artifact 命名: `^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl|md)$`（人类可读产物允许 `.md`）
- 所有 artifact 写入必须原子操作 (write .tmp → fsync → rename)，tmp 文件必须与目标在同一文件系统

## CLI 命令参考

```
hepar run          # 启动/恢复 run
hepar status       # 查看 run 状态
hepar approve      # 批准 pending approval
hepar reject       # 拒绝 pending approval
hepar doctor       # 健康检查 + 配置回显
hepar approvals show --run-id <RID> --gate <A?> --format short|full|json
hepar report render --run-ids <...> --out md|tex
```

## 运行时产出目录结构

> 三方收敛设计 (Opus 4.6 + Gemini 2.5 Pro + GPT-5.2 xhigh, 2026-02-20, R1 即收敛, 0 blocking)。后续审核统一使用 Gemini-3-Pro-Preview。
> 审核产物: `autoresearch-meta/.review/r1-{gemini,codex}-output.md`

### 设计原则

1. **全局 = 可驱逐缓存 + 共享数据**: 删除 cache/ 后项目仍可审计；data/ 可重新获取
2. **项目本地 = 持久记录系统 (SoR)**: 人类可读、可审查、可追溯的研究产物
3. **XDG 合规**: 全局目录遵循 XDG Base Directory 规范，支持 `AUTORESEARCH_HOME` 回退
4. **原子写入保证**: 项目本地必须有同文件系统 tmp/ (跨文件系统 rename 不原子)
5. **evidence-first 透明性**: runs/ 和 evidence/ 为可见目录（非隐藏），便于人类发现和审查

### 全局目录 (`~/.autoresearch/`)

默认 `AUTORESEARCH_HOME=~/.autoresearch`，内部按 XDG 语义分层。支持环境变量覆盖。

```
~/.autoresearch/
├── data/                        # 持久共享数据（不可随意删除）
│   ├── arxiv_sources/<arxiv_id>/  # 论文源文件，跨项目复用
│   ├── pdg/                       # PDG 数据快照（带版本）
│   └── corpora/                   # 语料库
├── cache/                       # 可安全删除的缓存
│   ├── downloads/                 # 临时下载
│   ├── embeddings/                # 向量索引（可重建）
│   └── tmp/                       # 全局临时文件
└── state/                       # 运行时状态
    ├── run_index.jsonl            # 跨项目 run 注册表
    ├── locks/                     # 并发锁文件
    └── logs/                      # 全局日志
```

### 项目本地目录 (`<project_dir>/`)

每个研究项目为独立目录，包含人类可读产物和执行记录。

```
<project_dir>/
├── project.toml                 # 项目清单（project_id, 名称, 描述）
├── paper/                       # LaTeX 源文件（人类编辑）
│   ├── main.tex
│   ├── references.bib
│   └── build/                   # 编译产物（.gitignore）
├── reports/                     # 中间报告、分析（MD/HTML）
├── evidence/                    # 策展证据（人类精选，引用 runs/ 中的原始产物）
├── knowledge_base/              # 文献笔记、方法论记录
├── compute/                     # 计算脚本和结果
├── runs/<run_id>/               # 执行记录（可见，便于审查）
│   ├── manifest.json            # 运行清单（输入摘要+环境快照）
│   ├── summary.json             # 运行摘要
│   ├── approvals/               # 审批 packet
│   └── artifacts/               # 运行产物
├── .autoresearch/               # 机器内部状态（.gitignore）
│   └── tmp/                     # 项目本地临时文件（保证原子 rename）
└── .gitignore                   # 排除 .autoresearch/, paper/build/, runs/
```

**语义区分**:
- `runs/` = 原始执行记录，机器生成，完整保留
- `evidence/` = 策展后的证据，人类从 runs/ 中精选，用于论文和报告引用
- `paper/` = LaTeX 源文件（人类编辑）；`paper/build/` = 编译产物（机器生成）

### 关键设计决策

| 决策 | 结论 | 理由 | 审核来源 |
|---|---|---|---|
| 双层分离 | ✅ 采纳 | 共享缓存 vs 项目审计记录，类比 Cargo/npm/DVC | 三方一致 |
| runs/ 位置 | 项目本地 (`runs/`，可见) | 审计记录属于项目，evidence-first 要求透明可发现 | 三方一致 |
| 第三层 (campaign) | 不新增文件系统层，用 `campaign.toml` 元数据 | 类比 pnpm-workspace.yaml | 三方一致 |
| 全局目录命名 | `~/.autoresearch/` + 内部 data/cache/state 分层 | XDG 语义但 macOS 友好路径 | Gemini+Codex 推 XDG，折中 |
| paper/ 源码与编译分离 | `paper/` = 源码，`paper/build/` = 编译产物 | 避免混淆，类比 LaTeX 构建系统 | Codex 提出 |
| 项目本地 tmp | `.autoresearch/tmp/` | 跨文件系统 rename() 不原子 | Codex 提出 |
| evidence/ 语义 | 人类策展的精选证据，引用 runs/ 原始产物 | 避免与 runs/ 重复 | Codex 提出 |

### 跨项目引用

使用 URI + content digest 双重机制：

- **URI 格式**: `autoresearch://<project_id>/<artifact_class>/<path>`
- **ArtifactRef 必须包含**: `sha256`, `origin: {project_id, run_id}`, `retrieval: {method, url}`
- **引用模式**: by-value（快照到 `evidence/external/`）或 by-reference（通过全局 run_index 解析）

### Artifact 命名约定

- 机器产物: `^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl)$`
- **人类可读产物例外**: 审批 packet (`.md`)、报告 (`.md`/`.html`) 允许扩展名豁免
- 所有 artifact 写入必须原子操作 (write .tmp → fsync → rename)，tmp 文件必须与目标在同一文件系统
- Schemas SSOT: `autoresearch-meta/schemas/`
- 生成代码: `*/generated/` (禁止手动编辑)

## GitNexus MCP

本仓使用 GitNexus 提供代码知识图谱（调用链、blast radius、execution flows、语义搜索）。以下规则是**静态治理文本**；不要在根级策略文件里重新引入自动更新的 GitNexus marker / stats。

### Always Start Here

对于任何涉及代码理解、调试、影响分析或重构的任务，必须：

1. 先读 `gitnexus://repo/{name}/context` 检查仓库上下文与 freshness。
2. 若 context 提示 index stale，先运行 `npx gitnexus analyze`，再继续。
3. 根据任务类型读取对应 skill 文件，并遵循其 workflow / checklist。

### Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/refactoring/SKILL.md` |

### Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

### Resources Reference

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats + staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

### Graph Schema

- **Nodes**: `File`, `Function`, `Class`, `Interface`, `Method`, `Community`, `Process`
- **Edges** (`CodeRelation.type`): `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `DEFINES`, `MEMBER_OF`, `STEP_IN_PROCESS`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **autoresearch-lab** (9867 symbols, 23047 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/autoresearch-lab/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/autoresearch-lab/context` | Codebase overview, check index freshness |
| `gitnexus://repo/autoresearch-lab/clusters` | All functional areas |
| `gitnexus://repo/autoresearch-lab/processes` | All execution flows |
| `gitnexus://repo/autoresearch-lab/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
