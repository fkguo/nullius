# EvoMap / GEP 分析：对 Autoresearch 自我进化体系的适用性评估

> **日期**: 2026-02-20
> **编排**: Opus 4.6
> **状态**: 初稿，待双模型审核

## 1. EvoMap / GEP 概览

**EvoMap** (https://evomap.ai) 是 AutoGame Limited 开发的 AI 自我进化基础设施平台，2026-02 上线 (beta)。核心协议为 **GEP (Genome Evolution Protocol)**，一个 agent-to-agent 的能力进化与继承协议。

**开源客户端**: [autogame-17/evolver](https://github.com/autogame-17/evolver) (MIT, JS, 86 stars, ~54K LOC 核心)

### 1.1 核心概念

| 概念 | 定义 | 类比 |
|---|---|---|
| **Gene** | 可复用策略模板 (repair/optimize/innovate)，含前置条件、约束、验证命令 | 设计模式 / 修复策略 |
| **Capsule** | 应用 Gene 后产生的已验证修复，含触发信号、置信度、影响范围、环境指纹 | 具体补丁 / 已验证方案 |
| **EvolutionEvent** | 进化过程的审计记录：意图、尝试的变异、结果 | 实验日志 |
| **GDI** | Global Desirability Index，资产排名分数：内在质量 35% + 使用指标 30% + 社交信号 20% + 新鲜度 15% | 论文 h-index |
| **Mutation** | 显式变异对象 (repair/optimize/innovate)，每次进化运行必须声明 | 实验假设 |
| **PersonalityState** | 可进化的 agent 性格状态，通过自然选择统计调整 | agent 策略参数 |

### 1.2 GEP 协议

- **传输**: HTTP + JSON (也支持 FileTransport 本地 JSONL)
- **6 种消息类型**: `hello` (注册), `publish` (发布), `fetch` (获取), `report` (验证报告), `decision` (裁决), `revoke` (撤回)
- **内容寻址**: SHA-256 canonical JSON hash 作为 asset_id
- **信封格式**: 7 个必填字段 (protocol, protocol_version, message_type, message_id, sender_id, timestamp, payload)

### 1.3 GEP vs MCP vs Skill

| 协议 | 层级 | 核心问题 |
|---|---|---|
| MCP | 接口层 | 有哪些工具可用？ |
| Skill | 操作层 | 如何一步步使用工具？ |
| GEP | 进化层 | 为什么这个方案有效？(含审计轨迹和自然选择) |

### 1.4 Evolver 架构 (关键模块)

| 模块 | 功能 | LOC |
|---|---|---|
| `src/evolve.js` | 主进化引擎：信号提取→基因选择→变异→prompt 生成 | ~54K |
| `src/gep/solidify.js` | 验证+固化：执行验证命令、计算影响范围、写入资产 | ~51K |
| `src/gep/signals.js` | 信号提取：错误模式、机会信号、停滞检测、去重 | ~15K |
| `src/gep/selector.js` | 基因选择：信号匹配→评分→选择最佳 Gene/Capsule | ~7K |
| `src/gep/memoryGraph.js` | 记忆图：跨周期知识积累、信号频率追踪 | ~28K |
| `src/gep/personality.js` | 性格进化：小步变异 + 自然选择统计 | ~13K |
| `src/gep/a2aProtocol.js` | A2A 协议实现：消息构建、传输抽象 | ~12K |

## 2. 与 Autoresearch Phase 5 的映射分析

### 2.1 高度相关

| EVO 项 | GEP/EvoMap 对应 | 可借鉴程度 |
|---|---|---|
| **EVO-10** 进化提案自动闭环 | Evolver 的 signal→gene→mutation→solidify 循环 | **高**: 信号提取、去重、停滞检测可直接参考 |
| **EVO-12** 技能生命周期自动化 | Evolver `src/ops/skills_monitor.js` + GDI 评分 | **高**: 健康度评分、自动退役逻辑可参考 |
| **EVO-04** Agent 注册表 + A2A | GEP `hello` 消息 + 节点注册 + 能力广告 | **中高**: A2A 信封格式可参考，但我们已有 NEW-07 |

### 2.2 部分相关

| EVO 项 | GEP/EvoMap 对应 | 可借鉴程度 |
|---|---|---|
| **EVO-15/16** Agent-arXiv | EvoMap marketplace (publish→validate→promote→reuse) | **中**: 发布/评审/推广流程可参考，但内容模型完全不同 |
| **EVO-11** Bandit 分发策略 | Evolver 的 strategy presets (balanced/innovate/harden/repair-only) | **低中**: 策略切换思路可参考，但我们的 Bandit 更数学化 |
| **EVO-09** 失败库查询 | Evolver 的 signal de-duplication + repair loop detection | **中**: 避免重复修复的逻辑可参考 |

### 2.3 不相关

| EVO 项 | 原因 |
|---|---|
| **EVO-01~03** 计算执行闭环 | GEP 面向软件工程，无科学计算概念 |
| **EVO-06~07** 科学诚信/可复现性 | GEP 无科学验证框架 |
| **EVO-08** 跨实例 idea 同步 | GEP 的 A2A 是资产交换，非 idea 同步 |
| **EVO-13~14** 统一编排/并行调度 | GEP 是单 agent 进化，非多 agent 编排 |

## 3. 关键差异分析

### 3.1 领域差异

| 维度 | GEP/EvoMap | Autoresearch |
|---|---|---|
| **目标领域** | 软件工程 (bug fix, optimization) | 理论物理研究 (hypothesis, calculation, evidence) |
| **资产粒度** | 代码补丁 (files, lines, blast_radius) | 研究产物 (ideas, calculations, papers, evidence) |
| **验证方式** | 自动化测试 (npm test, lint) | 科学验证 (交叉检验, Ward 恒等式, 可复现性) |
| **成功标准** | 测试通过 + 无回归 | 物理正确性 + 新颖性 + 可复现性 |
| **进化周期** | 4 小时 (loop mode) | 天/周级 (研究周期) |
| **信任模型** | 中心化 Hub (evomap.ai) | 本地优先 + 可选联邦 |

### 3.2 架构差异

| 维度 | GEP | Autoresearch 现有 |
|---|---|---|
| **通信协议** | 自定义 HTTP A2A | MCP (JSON-RPC 2.0 over stdio) |
| **资产存储** | 本地 JSONL + Hub 云端 | 本地 artifact (evidence-first) |
| **内容寻址** | SHA-256 canonical JSON | 计划中 (ArtifactRef V1, H-18) |
| **审计轨迹** | EvolutionEvent JSONL | Ledger + JSONL (H-10) |
| **自然选择** | GDI 评分 + 使用反馈 | 无 (计划中: EVO-11 Bandit) |

### 3.3 进化的双轨本质

Autoresearch 的"自我进化"实际包含两条独立轨道：

| 轨道 | 进化对象 | 资产类型 | 验证方式 | GEP 适配度 |
|---|---|---|---|---|
| **Track A: 研究进化** | 研究策略、方法论、计算方案、物理近似 | ResearchStrategy, ResearchOutcome, Evidence | 科学验证 (Ward 恒等式, 交叉检验, 可复现性) | **低** — 领域不匹配 |
| **Track B: 工具进化** | MCP 工具、Skills、Orchestrator 代码、配置 | Gene, Capsule (代码补丁) | 软件测试 (TypeScript 编译, vitest, lint) | **高** — GEP 原生领域 |

**关键洞察**: Track B 恰恰是 GEP 的设计目标。Autoresearch 的代码库本身就是软件工程产物——MCP server (~130K TS)、orchestrator、skills 脚本——GEP 的 Gene/Capsule 模型天然适用于这些组件的自我修复、优化和功能演进。

**Track A 示例**: agent 发现某个正规化方案在特定能标下失效 → 记录为 ResearchEvent → 提出新的正规化策略 → 验证物理正确性 → 固化为 ResearchOutcome

**Track B 示例**: MCP 工具 `inspire_search` 频繁超时 → Evolver 检测到 error signal → 选择 repair Gene → 生成修复补丁 (增加重试/缓存) → 测试通过 → 固化为 Capsule

## 4. 协议选择：双轨方案

### 4.1 修正后的方案对比

基于 §3.3 的双轨分析，协议选择不再是单一的 A/B/C，而是按轨道分别决策：

| 轨道 | 推荐协议 | 理由 |
|---|---|---|
| **Track A (研究进化)** | **REP** (自研，借鉴 GEP 设计模式) | 科学研究资产模型与 GEP 不兼容，需要 ResearchStrategy/Outcome 抽象 |
| **Track B (工具进化)** | **GEP** (直接采用，本地模式) | GEP 原生适用于软件工程进化；使用 FileTransport 避免中心化依赖 |

### 4.2 双轨架构

```
Track A (研究进化)                    Track B (工具进化)
─────────────────                    ─────────────────
REP 信号引擎                          GEP/Evolver 信号引擎
  ↓ research signals                   ↓ error/opportunity signals
REP 策略选择                          GEP Gene 选择
  ↓ ResearchStrategy                   ↓ Gene
REP 验证 (科学验证)                   GEP 验证 (npm test/vitest)
  ↓ ResearchOutcome                    ↓ Capsule
REP 本地存储                          GEP 本地存储 (FileTransport)
         ↘                        ↙
          共享基础设施层
          ├─ 内容寻址 (SHA-256, H-18)
          ├─ 信封格式 (A2A, NEW-07)
          ├─ 审计日志 (JSONL, H-10)
          └─ 评分管道 (RDI/GDI)
```

### 4.3 推荐理由

1. **Track B 零开发成本** — Evolver 的 Gene/Capsule/信号/验证 全链路可直接用于 MCP 工具和 Skills 的自我修复，无需改造资产模型
2. **Track A 需要领域适配** — 科学研究的资产、验证、评分与软件工程根本不同，必须自研 REP
3. **共享基础设施** — 两条轨道共享信封格式、内容寻址、审计日志，避免重复建设
4. **GEP FileTransport 满足本地优先** — 不使用 EvoMap Hub，仅用本地 JSONL 传输，符合 evidence-first
5. **渐进式接入** — Track B 可先行启动 (Evolver 已可用)，Track A 在 Phase 5 后期实现

## 5. REP (Research Evolution Protocol) 设计草案

基于 GEP 的成熟设计模式，适配科学研究领域。

### 5.1 资产模型 (替代 Gene/Capsule)

| REP 资产 | GEP 对应 | 定义 |
|---|---|---|
| **ResearchStrategy** | Gene | 可复用研究策略模板：方法论、计算方法、近似方案，含适用条件和验证标准 |
| **ResearchOutcome** | Capsule | 应用策略后的已验证研究结果：计算结果、物理量、evidence 引用，含置信度和适用范围 |
| **ResearchEvent** | EvolutionEvent | 研究过程审计记录：假设、尝试的方法、结果、失败原因 |
| **IntegrityReport** | (无对应) | 科学诚信报告：参数偏见、近似有效性、已知结果检测 (EVO-06) |

### 5.2 借鉴 GEP 的设计模式

| GEP 设计模式 | REP 采纳方式 |
|---|---|
| **内容寻址 (SHA-256)** | 直接采用，与 ArtifactRef V1 (H-18) 统一 |
| **信封格式 (7 字段)** | 采用相同结构，protocol 改为 `rep-a2a` |
| **6 种消息类型** | 保留 hello/publish/fetch/report/revoke，`decision` 改为 `review` (同行评审) |
| **GDI 评分** | 改为 RDI (Research Desirability Index)，分两层：**fail-closed gate** (物理正确性 + 可复现性 + 诚信检查必须全部通过，否则禁止 publish/reuse) + **排名分数** (新颖性 50% + 方法通用性 30% + 本地引用影响 20%，仅用于已通过 gate 的资产排序) |
| **信号提取** | 从 error/opportunity 信号改为 research signal：gap_detected, calculation_divergence, known_result_match, integrity_violation |
| **自然选择** | 从使用反馈改为科学验证反馈：独立重跑验证、交叉检验通过率、被引用次数 |
| **停滞检测** | 直接借鉴 Evolver 的 consecutiveEmptyCycles + repair_loop_detected 逻辑 |
| **策略预设** | 从 balanced/innovate/harden/repair-only 改为 explore/deepen/verify/consolidate |

### 5.3 REP 与现有基础设施的集成

```
MCP (接口层)          ← 已有，工具发现和调用
  ↓
REP (进化层)          ← 新增，研究策略进化和知识继承
  ↓
Orchestrator (编排层)  ← EVO-13，统一编排引擎
  ↓
Agent-arXiv (发布层)   ← EVO-15，研究成果发布和引用
```

REP 不替代 MCP，而是在 MCP 之上增加进化语义。Agent 通过 MCP 调用工具执行计算，通过 REP 记录和共享研究策略的进化过程。

## 6. Evolver 代码复用评估

### 6.1 可直接移植的模块

| Evolver 模块 | 目标用途 | 移植方式 | 改造量 |
|---|---|---|---|
| `src/gep/a2aProtocol.js` 信封构建 | REP 消息信封 | 改 protocol 字段为 `rep-a2a`，保留 SHA-256 寻址 | 低 |
| `src/gep/signals.js` 去重逻辑 | EVO-09 失败库 + EVO-10 信号提取 | 替换 error pattern 为 research signal 类型 | 中 |
| `src/gep/signals.js` 停滞检测 | EVO-10 进化闭环 | `consecutiveEmptyCycles` + `repair_loop_detected` 逻辑可直接用 | 低 |
| `src/gep/selector.js` 评分框架 | EVO-11 Bandit 策略 | 替换 GDI 权重为 RDI 权重，保留评分管道结构 | 中 |

### 6.2 需重写但可参考架构的模块

| Evolver 模块 | 参考价值 | 原因 |
|---|---|---|
| `src/evolve.js` 主循环 | signal→select→mutate→validate→solidify 五阶段架构 | 资产模型完全不同，但阶段划分通用 |
| `src/gep/solidify.js` 验证+固化 | 验证命令执行、影响范围计算、资产写入的流程 | 验证方式从 `npm test` 变为科学验证 |
| `src/gep/memoryGraph.js` 记忆图 | 跨周期知识积累、信号频率追踪 | 数据结构可参考，但节点类型需重新定义 |
| `src/gep/personality.js` 性格进化 | 小步变异 + 自然选择统计的框架 | 参数空间从软件工程策略变为研究策略 |

### 6.3 不可复用的部分

- **Gene/Capsule schema**: 代码补丁级别的 `files`, `lines`, `blast_radius` 字段与科学研究无关
- **验证命令执行器**: 硬编码 `npm test`, `eslint` 等软件工程工具
- **EvoMap Hub 客户端**: 中心化 API 调用，不符合 evidence-first 本地优先原则
- **环境指纹**: Node.js/npm 版本检测，需替换为 Mathematica/FeynCalc 版本检测

## 7. 对现有 EVO 项的影响

采用方案 C (混合) 后，以下 Phase 5 项需要更新：

### 7.1 需修改描述的项

| EVO 项 | 当前描述 | 建议修改 |
|---|---|---|
| **EVO-04** Agent 注册表 + A2A | 自研 A2A 适配层 | 采用 REP 信封格式 (`rep-a2a`)，借鉴 GEP `hello` 消息的能力广告机制 |
| **EVO-09** 失败库生成时查询 | 自研去重逻辑 | 移植 Evolver `signals.js` 的信号去重 + 停滞检测逻辑 |
| **EVO-10** 进化提案自动闭环 | 自研进化循环 | 采用 Evolver 五阶段架构 (signal→select→mutate→validate→solidify)，资产模型用 REP |
| **EVO-11** Bandit 分发策略 | 自研评分 | Evolver `selector.js` 仅提供加权评分管道参考，**不等同于 bandit 算法**。EVO-11 需自研 exploration/exploitation 更新、reward 反馈、regret 控制；`selector.js` 仅用于 RDI 排名分数计算子模块 |
| **EVO-12** 技能生命周期自动化 | 自研健康度评分 | 参考 Evolver `skills_monitor.js` + GDI 退役逻辑，评分维度改为 RDI |

### 7.2 不受影响的项

EVO-01~03 (计算闭环)、EVO-05 (Domain Pack)、EVO-06~07 (科学诚信/可复现性)、EVO-08 (跨实例同步)、EVO-13~14 (编排/调度)、EVO-15~16 (Agent-arXiv) — 这些项的领域逻辑与 GEP 无交集，保持原设计。

### 7.3 新增建议项

| 建议项 | 描述 | 依赖 |
|---|---|---|
| **EVO-17** REP 协议核心实现 | 实现 REP 信封、消息类型、内容寻址、本地 JSONL 传输 | H-18 (ArtifactRef), NEW-07 (A2A 适配层基础) |
| **EVO-18** REP 信号引擎 | 实现 research signal 提取：gap_detected, calculation_divergence, known_result_match, integrity_violation | EVO-17, EVO-06 |
| **EVO-19** GEP/Evolver Track B 集成 | 将 Evolver 接入 Autoresearch 代码库的工具进化 (Track B)，配置 FileTransport + 本地 Gene 库 | NEW-05 (monorepo), EVO-04 |

**依赖线性化**: NEW-07 → EVO-17 → EVO-04 (EVO-04 在 REP 信封可用后再接入注册表)。消除原 EVO-04 ↔ EVO-17 循环。

## 8. 实施路径

### 8.1 前置条件 (Phase 0-1 完成后)

REP 实现依赖以下已规划项：

- **H-18** ArtifactRef V1 — REP 内容寻址的基础
- **NEW-05** Monorepo 迁移 — REP SDK 的代码位置 (`packages/rep-sdk/`)
- **NEW-07** A2A 适配层 — REP 传输层的基础
- **H-10** JSONL 审计日志 — ResearchEvent 的存储层

### 8.2 分步实施

1. **REP schema 定义** — 在 `autoresearch-meta/schemas/` 定义 ResearchStrategy, ResearchOutcome, ResearchEvent, IntegrityReport 的 JSON Schema
2. **REP 信封 + 传输** — 移植 Evolver `a2aProtocol.js` 信封构建逻辑，改 protocol 为 `rep-a2a`，实现 FileTransport (本地 JSONL)
3. **信号引擎** — 移植 Evolver `signals.js` 去重 + 停滞检测，新增 research signal 类型
4. **评分管道** — 移植 Evolver `selector.js` 评分框架，替换为 RDI 权重
5. **进化主循环** — 参考 Evolver `evolve.js` 五阶段架构，用 REP 资产模型重写

## 9. 结论

**核心判断**: Autoresearch 的"自我进化"包含两条本质不同的轨道——研究进化 (Track A) 和工具进化 (Track B)。GEP 天然适用于 Track B (软件工程进化)，但其资产模型与 Track A (科学研究进化) 根本不兼容。

**推荐方案**: 双轨架构——
- **Track A (研究进化)**: 自研 REP，借鉴 GEP 协议设计模式，用科学研究专用资产模型
- **Track B (工具进化)**: 直接采用 GEP/Evolver (FileTransport 本地模式)，零改造成本

**关键设计决策** (R1 审核后修正):
- RDI 采用 fail-closed gate + 排名分数双层结构，物理正确性/可复现性/诚信检查为硬门禁
- RDI 排名分数仅使用本地可计算指标 (新颖性/方法通用性/本地引用)，不依赖外部服务
- Evolver `selector.js` 仅用于 RDI 排名子模块，EVO-11 Bandit 算法需独立实现
- 依赖线性化: NEW-07 → EVO-17 → EVO-04，消除循环依赖

**风险**: Evolver 处于 beta 阶段 (86 stars)，API 可能变化。建议移植时仅取核心算法逻辑，不依赖其 npm 包。Track B 集成需确保 Evolver 的 Gene 修复不绕过 Contract 规则 (GATE/SEC)。

---

> **审核状态**: R1 GPT-5.3-Codex NOT_CONVERGED (4 blocking, 已修复)；Gemini-3-Pro-Preview 待出。R2 需重新提交。
