# Autoresearch Ecosystem — Agent Context

> 本文件为 AI agent 提供跨会话持久上下文。修改本文件需经 autoresearch-meta 治理流程。

## 生态圈概览

Autoresearch 是一个 evidence-first 自动化研究平台，面向高能物理 (HEP) 领域。由 7 个组件组成，通过 MCP (Model Context Protocol) stdio 传输和 JSON-RPC 2.0 协议互联。

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

## Phase 结构

- **Phase 0 (止血)**: 9 项。Monorepo 迁移 + TS 编排层增量迁移 + 安全漏洞 + 治理绕过。NEW-05 最先执行，NEW-05a 紧随。
- **Phase 1 (统一抽象)**: 17 项。AutoresearchError, RunState, GateSpec, ArtifactRef, trace_id, risk_level 等共享抽象 + 代码生成基础设施。
- **Phase 2 (深度集成)**: 19 项。原子写入, 文件锁, 幂等性, JSONL 日志, 审批 UX 三件套, 报告生成。
- **Phase 3 (扩展性)**: 13 项。Schema 扩展, 凭据管理, 网络治理, AST lint 升级, MCP 工具整合。
- **Phase 4 (长期演进)**: 8 项。文档, 低优先级缺陷, 发布冻结产物, A2A 适配层。
- **Phase 5 (社区化与端到端闭环)**: 19 项。理论计算执行闭环, 结果反馈循环, Agent 注册表, Domain Pack, 科学诚信, 可复现性验证, 跨实例同步, 失败库生成时查询, 进化提案自动闭环, Bandit 分发策略运行时接入, 技能生命周期自动化, 统一编排引擎 (TS), 跨 Run 并行调度, Agent-arXiv 基础设施, Agent 社区自主运行实验, REP 协议核心 (Track A), REP 信号引擎 (Track A), GEP/Evolver Track B 集成。

## Contract 规则域

ERR (4), ID (3), SYNC (6), CFG (4), GATE (5), LOG (4), ART (5), SEC (3), NET (1), RES (1), MIG (1), REL (2), CODE (1), LANG (1), PLUG (1)

## 双模型审核流程

v1.1.0 起，所有重大文档变更需经 GPT-5.3-Codex (xhigh) 和 Gemini-3-Pro-Preview 独立审核，迭代至收敛。审核产物存放在 `autoresearch-meta/.review/`（已 gitignore）。

### 触发条件

- 跨组件架构变更（影响 ≥2 个组件的接口/契约）
- Contract 规则新增或修改
- REDESIGN_PLAN Phase 级别变更（项移动、新增、删除）
- 不可逆操作方案（monorepo 迁移、schema 破坏性变更）

单组件内部修改、bug fix、文档 typo 等**不需要**双审核。

### 收敛判定规则

1. 两个模型独立审核，输出 strict JSON（含 `verdict`, `blocking_issues`, `amendments`）
2. **CONVERGED**: 两模型均 0 blocking issues → 方案通过
3. **CONVERGED_WITH_AMENDMENTS**: 0 blocking + 非阻塞修正建议 → 方案通过，修正建议按价值选择性采纳
4. **NOT_CONVERGED**: 任一模型有 blocking issue → 必须修正后重新提交下一轮 (R+1)
5. **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入决策
6. 每轮 prompt 必须包含：上一轮两模型的完整输出 + 已采纳/未采纳修正及理由

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

使用 `gemini-cli-runner` 和 `codex-cli-runner` skills 并行执行。prompt 文件存放在 `.review/` 目录。

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
| 架构 | 跨组件设计决策 | 战略优先：全局影响评估→双模型审核→方可执行 |

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
| Momus 审查循环 | 双模型审核流程 | ✅ 已覆盖（更强） |
| Metis 意图分类 | **无对应规则** | ⬆️ 本节补充 |
| Oracle 战略顾问 | superpowers:brainstorming + 双模型审核 | ✅ 部分覆盖 |
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
| **双模型审核 (治理文档)** | GPT-5.2 (xhigh) + Gemini-3-Pro | GLM-5 替代任一 | 独立审核需不同厂商，避免同源偏见 |
| **双模型审核 (代码/架构)** | GPT-5.3-Codex (xhigh) + Opus 4.6 | MiniMax M2.5 替代 Codex | 代码审核需代码专精 + 架构理解 |
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
4. **独立审核 → 不同厂商模型交叉**: 避免同源偏见，至少 2 家厂商。推荐组合：Anthropic + OpenAI、Anthropic + Google、OpenAI + 国产
5. **成本敏感 → Sonnet 4.6 (~71%)**: 单组件、低复杂度、日常开发。国产备选：GLM-5 (72.8%)、Kimi K2.5 (70.8%) 成本更低
6. **超长上下文 (>200K) → Gemini-3-Pro (74.2%)**: 全代码库扫描、大规模文档分析，唯一 ≥1M 上下文

### 国产模型使用策略

国产模型 (MiniMax M2.5, GLM-5, Kimi K2.5) 在 SWE-bench 上表现出色，成本显著低于 Anthropic/OpenAI。适用场景：

- **双模型审核的第三方验证**: 当 Anthropic + OpenAI 审核结果存疑时，引入国产模型作为 tiebreaker
- **低复杂度日常任务**: 替代 Sonnet 4.6 进一步降低成本
- **大规模代码迁移的并行验证**: MiniMax M2.5 (75.8%) 可与 Opus 4.6 并行执行同一迁移任务，交叉验证

**限制**: 国产模型的 MCP 工具调用、agentic 编排、CLI 集成成熟度不如 Anthropic/OpenAI，暂不作为主力 agentic 执行模型。

### 切换时机

- Agent 在开始工作前检查 tracker 中目标项的 `complexity` 字段
- 如果当前模型与推荐不匹配，在输出中提示：`⚠️ 建议切换至 {model}（原因: {reason}）`
- 人类决定是否切换，agent 不自动切换
- **xhigh 推理深度仅在以下场景使用**: 双模型审核、架构级决策、大规模代码迁移。日常任务使用默认推理深度以控制成本
- **Benchmark 数据时效**: 本节数据基于 2026-02 SWE-bench Verified。GPT-5.3-Codex 提交评测后需更新推荐

## 当前进度

> **SSOT**: `autoresearch-meta/remediation_tracker_v1.json`（机器可读，agent 执行时更新）

- **Phase 0**: 0/8 完成 — 全部 pending，NEW-05 (monorepo) 建议最先执行
- **Phase 1**: 0/17 完成 — blocked by Phase 0
- **Phase 2**: 0/19 完成 — blocked by Phase 1
- **Phase 3**: 0/13 完成 — blocked by Phase 2
- **Phase 4**: 0/8 完成 — blocked by Phase 3
- **Phase 5**: 0/16 完成 — blocked by Phase 4
- **R4 双模型审核**: ✅ 收敛 (Gemini CONVERGED + Codex CONVERGED_WITH_AMENDMENTS, 0 blocking)
- **R5 双模型审核**: ✅ 收敛 (Gemini CONVERGED_WITH_AMENDMENTS + Codex CONVERGED_WITH_AMENDMENTS, 0 blocking, amendments integrated)

## 开发约定

- **审核过程文件 (`autoresearch-meta/.review/`) 为临时产物，禁止 git push**。包括双模型审核的 prompt、输出、中间稿等。已在 `.gitignore` 中排除。
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

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **autoresearch-lab** (12858 symbols, 27234 relationships, 300 execution flows).

GitNexus provides a knowledge graph over this codebase — call chains, blast radius, execution flows, and semantic search.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring, you must:

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/refactoring/SKILL.md` |

## Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats, staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```

<!-- gitnexus:end -->
