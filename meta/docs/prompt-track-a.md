# Track A 研究进化实施设计 (EVO-06/07/17/18 + REP)

## 背景

Autoresearch 生态圈的 REDESIGN_PLAN v1.4.1-draft 已完成 107 项规划。
Track A 关注**研究进化** — 从科学诚信检验、到可复现性验证、到研究进化协议 (REP)、
到信号引擎驱动的策略选择。这些是实现"AI 自主科研闭环"的核心科学层。

当前状态: REDESIGN_PLAN 中 EVO-06/07/17/18 有条目级描述，
但以下关键设计问题尚未解决:
- REP SDK 的 wire protocol 细节 (信封格式、RDI gate 评分公式)
- IntegrityCheck 框架的 domain pack 机制
- ResearchEvent 事件流的产生时机与消费路径
- 信号引擎如何从事件流中提取可操作信号
- Track A 与 Track B 共享基础设施 (EVO-20 Memory Graph) 的接口边界

本对话的目标是为 Track A 的 4 个核心 EVO 项产出可实施的详细设计方案。

## Git 分支

工作目录: `autoresearch-meta/` (已有 git 仓库)
工作分支: `redesign/track-a` (已从 main baseline v1.4.1-draft 创建)

**开始工作前**:
```bash
cd autoresearch-meta && git checkout redesign/track-a
```

**提交规范**:
- 在该分支上提交所有设计文档和 schema 变更
- commit message 格式: `track-a: <简要描述>`
- 完成后不要合并到 main，等待人工审核

## 网络代理

如需访问外部资源，先执行:
```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
```

## 必须阅读的文档（按优先级）

1. `autoresearch-meta/REDESIGN_PLAN.md`
   — 重点阅读:
   - EVO-06 (IntegrityReport — 理论物理研究诚信强制框架)
   - EVO-07 (可复现性验证管线)
   - EVO-17 (REP SDK — 研究进化协议)
   - EVO-18 (REP 信号引擎 — 研究进化)
   - EVO-11 (Bandit 策略分发 — Track A 策略选择的运行时接口)
   - EVO-20 (跨周期记忆图谱 — Track A/B 共享基础设施)
     — 上下文: Phase 0-2 基础设施项 (H-02 trace_id, H-18 ArtifactRef,
     NEW-07 A2A 适配层, M-06 SQLite WAL) 提供的前置能力

2. `autoresearch-meta/docs/2026-02-20-evomap-gep-analysis.md`
   — §5 双轨方案 (Track A REP vs Track B GEP)
   — §7.3 REP 设计对标 MCP SDK

3. `autoresearch-meta/docs/2026-02-20-deep-refactoring-analysis.md`
   — §3 静默异常 (与 EVO-06 诚信检查的关联)
   — §5.2 skills 生态 (技能与研究策略的关系)

4. `autoresearch-meta/ECOSYSTEM_DEV_CONTRACT.md`
   — GATE/SEC 规则 (RDI fail-closed gate 需遵守的安全约束)
   — PLUG-01 (REP SDK 零内部依赖约束)

5. `autoresearch-meta/remediation_tracker_v1.json`
   — 最终需要同步更新

## 参考源码

Evolver 公开仓库: https://github.com/autogame-17/evolver (MIT, JS, ~54K LOC 核心)

Track A 移植相关模块:
- `src/gep/signals.js` (~15K) — 信号提取 + 去重 + 停滞检测 (EVO-18 移植基础)
- `src/gep/selector.js` (~7K) — 选择评分管道 (EVO-18 策略选择器移植基础)
- `src/gep/a2aProtocol.js` — A2A 信封构建 (EVO-17 REP 信封移植基础)

**关键约束: 必须移植核心算法，禁止硬依赖 Evolver npm 包。**
理由: EvoMap (AutoGame Limited) 已成立公司，存在闭源风险；
移植时保留 MIT 归属声明。

## 领域知识参考

Track A 面向**理论高能物理** (HEP-th) 研究自动化，后续可扩展至其他理论物理研究领域。
设计时需了解以下科学验证概念:

- **Ward 恒等式**: 规范对称性导出的恒等式，可用于交叉验证计算正确性
- **规范不变性**: 物理可观测量不应依赖规范选择
- **已知极限**: 特定参数极限下结果应退化为已知解析表达式
- **重整化方案依赖**: 不同重整化方案应给出一致的物理结果（至给定阶）

这些是 EVO-06 IntegrityCheck 的 HEP domain pack 种子检查项，但 IntegrityCheck 接口本身必须是领域无关的，支持通过 domain pack 扩展。

## 设计任务

### 1. EVO-17: REP SDK 详细设计 (优先级最高 — Track A 的核心协议)

需要设计:
- **Wire protocol**: REP 信封的完整字段定义 (对标 Evolver `a2aProtocol.js`)
  - 信封头: protocol version, sender, recipient, content_hash (SHA-256)
  - 信封体: message_type 驱动的 wire payload (HelloPayload/PublishPayload/FetchPayload/ReportPayload/ReviewPayload/RevokePayload)
  - 签名/验证机制 (是否需要? 本地模式 vs 网络模式的差异)
- **核心类型的完整 TypeScript 接口**:
  - `ResearchStrategy`: 策略定义（目标、方法、约束、预期结果形式）
  - `ResearchOutcome`: 结果报告（指标、artifacts、integrity_report 引用）
  - `ResearchEvent`: 事件流（事件类型枚举 + 每种类型的 payload schema）
  - `IntegrityReport`: 诚信报告（检查项列表 + 每项的 evidence 指针）
- **RDI (Research Desirability Index) 评分公式**:
  - Fail-closed gate 的具体判定规则 (哪些检查必须全过?)
  - 排名分数的计算公式 (新颖性 50% + 方法通用性 30% + 引用影响 20% 如何量化?)
  - 各维度 0-1 归一化方法
- **Transport 层**:
  - FileTransport (JSONL) 的详细格式 (一行一事件? 文件组织方式?)
  - 未来 HTTP transport 的接口预留
- **子路径导出设计**: root/client/server/transport/validation 的 API surface
- **Schema 定义**: JSON Schema Draft 2020-12，放入 `autoresearch-meta/schemas/`
  - `research_strategy_v1.schema.json`
  - `research_outcome_v1.schema.json`
  - `research_event_v1.schema.json`
  - `integrity_report_v1.schema.json`

### 2. EVO-06: 诚信检查框架详细设计

需要设计:
- **IntegrityCheck 接口** (领域无关):
  - `check(artifact: ArtifactRef, context: CheckContext): CheckResult`
  - CheckResult: pass/fail/advisory + evidence + severity
  - CheckContext: 提供计算上下文（参数值、方法声明、参考文献）
- **Domain Pack 机制**:
  - domain pack 注册 + 发现 + 加载
  - HEP domain pack 的初始检查项实现:
    a) `param_bias_checker`: 参数选择偏见检测
    b) `approx_validator`: 近似有效性验证
    c) `novelty_verifier`: 已知结果检测 (需查询 INSPIRE)
    d) `cross_check`: 计算交叉验证 (Ward 恒等式等)
  - domain pack 扩展路径: 如何添加新检查项、新领域
- **Advisory vs Blocking 语义**:
  - 探索阶段: 所有检查为 advisory
  - A5 审批阶段: 指定检查升级为 blocking
  - 配置方式: 哪些检查在哪些阶段是 blocking
- **与 EVO-17 IntegrityReport 的集成**:
  - 检查结果如何聚合为 IntegrityReport
  - evidence 指针如何引用 ArtifactRef (H-18)
- **Schema**: `integrity_check_v1.schema.json`, `domain_pack_manifest_v1.schema.json`

### 3. EVO-07: 可复现性验证管线详细设计

需要设计:
- **独立重跑机制**:
  - 如何定义"独立方法" (不同程序包? 不同数学方法? 不同精度?)
  - 重跑的触发时机 (每次计算? 仅 A5 审批前?)
  - 重跑结果与原始结果的比对方法
- **偏差报告格式**:
  - 数值偏差的容差定义 (绝对/相对)
  - 偏差来源分类 (数值精度 / 方法差异 / 潜在错误)
- **与 EVO-06 IntegrityReport 的关系**:
  - 可复现性验证是否作为一个 IntegrityCheck domain pack?
  - 还是独立管线，结果注入 IntegrityReport?
- **与计算工具链的集成**:
  - Mathematica (FeynCalc/FeynArts) + Julia (LoopTools.jl) 双轨验证
  - 如何标准化不同工具链的输出以便比对

### 4. EVO-18: REP 信号引擎详细设计

需要设计:
- **Research Signal 类型系统**:
  - `gap_detected`: 知识空白检测 (怎么定义"空白"?)
  - `calculation_divergence`: 计算分歧 (来自 EVO-07 的偏差报告)
  - `known_result_match`: 已知结果匹配 (来自 EVO-06 novelty_verifier)
  - `integrity_violation`: 诚信违规 (来自 EVO-06 IntegrityCheck)
  - 是否需要更多信号类型? (如 `method_plateau`, `parameter_sensitivity`)
- **信号提取管道** (移植 Evolver `signals.js`):
  - 输入: ResearchEvent 流 (EVO-17)
  - 处理: 提取 + 去重 + 聚合 + 频率统计
  - 停滞检测: consecutiveEmptyCycles 阈值 + 策略切换触发
- **策略选择器** (移植 Evolver `selector.js`):
  - 预设策略: explore / deepen / verify / consolidate
  - 选择算法: 信号匹配 → 策略评分 → RDI 加权
  - 与 EVO-11 Bandit 的接口: Bandit 选择策略，信号引擎评估效果
- **与 EVO-20 Memory Graph 的接口**:
  - 信号频率写入 Memory Graph 节点
  - 策略效果历史从 Memory Graph 读取
  - Track A 特有的节点/边类型定义

### 5. 跨项集成设计

- **事件流架构**: 从计算执行 → ResearchEvent 产生 → 信号提取 → 策略选择 → 新计算的完整数据流
- **EVO-20 Memory Graph 的 Track A 接口**:
  - Track A 需要的节点类型 (strategy, outcome, signal, integrity_check)
  - Track A 需要的边类型 (produced, triggered, validated_by)
  - 与 Track B 节点/边的共享 vs 隔离边界
- **REP 与 MCP 的关系**:
  - MCP: "有哪些工具可用" (capability layer)
  - REP: "为什么这个策略有效" (evolution layer)
  - 两者如何共存? REP server 是否也是 MCP server?
- **前置依赖缺漏检查**:
  - H-18 ArtifactRef 是否足以支持 IntegrityReport 的 evidence 指针?
  - NEW-07 A2A 适配层是否足以支持 REP 信封传输?
  - trace/ledger 格式是否足以记录 ResearchEvent?
  - 是否需要额外的 Phase 0-4 基础设施项?

## 输出物

1. 每个 EVO 项的详细实施方案（修改文件、算法伪代码、schema 定义）
2. JSON Schema 文件放入 `autoresearch-meta/schemas/`
3. 如发现前置缺漏，更新 REDESIGN_PLAN.md 相应 Phase 的条目
4. 更新 remediation_tracker_v1.json 与 REDESIGN_PLAN 保持一致
5. 如需 Contract 变更，起草 AMEND 提案
6. 所有变更提交到 `redesign/track-a` 分支

## 约束

- 所有 schema 遵循 JSON Schema Draft 2020-12
- 所有新代码路径遵循 ECOSYSTEM_DEV_CONTRACT.md (CODE-01 ≤200 eLOC 等)
- REP SDK 必须满足 PLUG-01: 零 Autoresearch 内部依赖，独立 npm 包
- IntegrityCheck 接口必须领域无关，HEP 特定检查通过 domain pack 提供
- Track A 与 Track B 共享 EVO-20 Memory Graph 基础设施但不耦合领域逻辑
- 必须移植核心算法，禁止硬依赖 Evolver npm 包 (闭源风险)
- 移植代码保留 MIT 归属声明
