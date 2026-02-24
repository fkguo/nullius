# Track B 工具进化实施设计 (EVO-12a/19/20/21)

## 背景

Autoresearch 生态圈的 REDESIGN_PLAN v1.4.1-draft 已完成 107 项规划，
其中 Phase 5 包含 4 项新增的 GEP 工具进化条目（2026-02-21 加入），
目前仅有 REDESIGN_PLAN 级别的条目描述（做什么），缺少实施级设计（怎么做）。
本对话的目标是为这 4 项产出可实施的详细设计方案。

## Git 分支

工作目录: `autoresearch-meta/` (已有 git 仓库)
工作分支: `redesign/track-b` (已从 main baseline v1.4.1-draft 创建)

**开始工作前**:
```bash
cd autoresearch-meta && git checkout redesign/track-b
```

**提交规范**:
- 在该分支上提交所有设计文档和 schema 变更
- commit message 格式: `track-b: <简要描述>`
- 完成后不要合并到 main，等待人工审核

## 网络代理

如需访问外部资源，先执行:
```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890
```

## 必须阅读的文档（按优先级）

1. `autoresearch-meta/REDESIGN_PLAN.md`
   — 重点阅读: EVO-11 (Bandit), EVO-12/12a, EVO-19, EVO-20, EVO-21 的完整条目
   — 上下文: Phase 0-2 基础设施项 (H-02 trace_id, H-10 ledger, trace-jsonl,
     M-06 SQLite WAL, H-18 ArtifactRef, NEW-01 codegen) 提供的前置能力

2. `autoresearch-meta/docs/2026-02-20-evomap-gep-analysis.md`
   — GEP/Evolver 能力评估、双轨分析、代码移植评估 (§6)

3. `autoresearch-meta/docs/2026-02-20-deep-refactoring-analysis.md`
   — §1 CODE-01, §3 静默异常, §5.2 skills 生态 — 提供工具进化的当前基线

4. `autoresearch-meta/ECOSYSTEM_DEV_CONTRACT.md`
   — GATE/SEC 规则 (EVO-19 Contract Guard 必须遵守)
   — CODE-01 + AMEND-01 (EVO-12a 技能自生成需感知 LOC 约束)

5. `autoresearch-meta/remediation_tracker_v1.json`
   — 最终需要同步更新

## GEP 源码研究

Evolver 公开仓库: https://github.com/autogame-17/evolver (MIT, JS, ~54K LOC 核心)

重点模块:
- `src/gep/memoryGraph.js` (~28K) — 跨周期记忆图谱算法
- `src/gep/solidify.js` (~51K) — 验证 + 固化 + blast_radius
- `src/gep/personality.js` (~13K) — 策略参数自适应进化
- `src/gep/signals.js` (~15K) — 信号提取 + 去重 + 停滞检测
- `src/gep/selector.js` (~7K) — Gene 选择评分管道

**关键约束: 必须移植核心算法，禁止硬依赖 Evolver npm 包。**
理由: EvoMap (AutoGame Limited) 已成立公司，存在闭源风险；
Evolver 当前为 beta (86 stars)，API 不稳定；
我们仅需 ~13K 核心算法逻辑，不需要 ~167K 的框架代码。
移植时保留 MIT 归属声明。

## 设计任务

### 1. EVO-20: 跨周期记忆图谱 (优先级最高 — 其他 3 项的基础设施)

需要设计:
- 节点类型枚举 + 边类型枚举 (覆盖 Track A + Track B + 扩展应用)
- 存储方案选择: SQLite 图模型 vs 嵌入式向量检索 vs 混合方案
- 查询 API: 频率查询、路径查询、衰减算法
- Schema 定义 (JSON Schema Draft 2020-12, 放入 autoresearch-meta/schemas/)
- Memory Graph 的扩展应用评估:
  - 代码共变追踪 (co-change pattern)
  - 调试加速 (error → resolution mapping)
  - 审批模式学习 (approve/reject preference)
  - 研究知识图谱 (Track A 跨 run 关联)
  - 依赖风险热力图 (failure frequency per module)

### 2. EVO-19 扩展: Gene Library + Solidification

需要设计:
- Gene 索引结构: (trigger_signal, target_scope) → Gene
- Capsule → Gene 泛化算法
- blast_radius 计算方法 + CI 集成方式
- Contract Guard 规则映射 (GATE/SEC → guard checks)

### 3. EVO-12a: 技能自生成

需要设计:
- 模式检测算法: 从 trace/ledger 中识别重复修正模式
- 模式泛化: 具体修正实例 → 可复用技能定义
- 两种进化路径的具体实现:
  a) 新技能创建 (全新模式)
  b) 现有技能扩展 (scope extension)
- skill_proposal_v2 schema 设计
- 与 EVO-20 Memory Graph 的集成: 信号频率 ≥ N 触发技能提案

### 4. EVO-21: 主动进化

需要设计:
- Opportunity 信号类型 + 检测方法
- 三种突变类型 (repair/optimize/innovate) 的验证标准差异
- 策略参数自适应算法 (移植 personality.js)
- 风险分级 + GATE 审批级别映射
- 与 EVO-11 Bandit 的接口: 策略选择 vs 策略进化的分工

### 5. 前置依赖缺漏检查

在设计过程中，检查 Phase 0-4 是否有遗漏的前置条件:
- trace/ledger 格式是否足以支持模式检测？
- SQLite WAL (M-06) 是否足以支持 Memory Graph 的并发需求？
- ArtifactRef (H-18) 是否需要扩展以支持 Gene/Capsule 引用？
- 现有 schema 是否需要新增字段？

## 输出物

1. 每个 EVO 项的详细实施方案（修改文件、算法伪代码、schema 定义）
2. 如发现前置缺漏，更新 REDESIGN_PLAN.md 相应 Phase 的条目
3. 更新 remediation_tracker_v1.json 与 REDESIGN_PLAN 保持一致
4. 如需 Contract 变更，起草 AMEND 提案
5. 所有变更提交到 `redesign/track-b` 分支

## 约束

- 所有 schema 遵循 JSON Schema Draft 2020-12
- 所有新代码路径遵循 ECOSYSTEM_DEV_CONTRACT.md (CODE-01 ≤200 eLOC 等)
- Track B 与 Track A 共享基础设施 (EVO-20) 但不耦合领域逻辑
- 必须移植核心算法，禁止硬依赖 Evolver npm 包 (闭源风险)
- 移植代码保留 MIT 归属声明
